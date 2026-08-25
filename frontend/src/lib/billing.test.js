import { describe, expect, it } from 'vitest'
import {
  buildSupportMessage,
  formatDate,
  formatKeyInput,
  isCompleteKey,
  isTrialUrgent,
  normalizeKey,
  paymentMethodLabel,
  renewalInfo,
  subscriptionBadge,
  telegramUrl,
  trialBannerMessage,
  trialDaysRemaining,
  whatsappUrl,
} from '@/lib/billing'

describe('normalizeKey', () => {
  it('uppercases and strips dashes and spaces', () => {
    expect(normalizeKey('abcd-efgh jkmn')).toBe('ABCDEFGHJKMN')
  })

  it('drops characters outside the alphabet', () => {
    // 0, O, 1, I and L are not in the alphabet — a user reading a key aloud will
    // substitute them, and silently keeping them guarantees a failed redemption.
    expect(normalizeKey('ABCD0OIL2345')).toBe('ABCD2345')
  })

  it('truncates past the key length', () => {
    expect(normalizeKey('ABCDEFGHJKMNPQRS')).toBe('ABCDEFGHJKMN')
  })

  it('survives null', () => {
    expect(normalizeKey(null)).toBe('')
  })
})

describe('isCompleteKey', () => {
  it('is true at exactly twelve characters', () => {
    expect(isCompleteKey('ABCD-EFGH-JKMN')).toBe(true)
    expect(isCompleteKey('ABCDEFGHJKM')).toBe(false)
  })
})

describe('formatKeyInput', () => {
  it('groups in fours as the user types', () => {
    expect(formatKeyInput('ABCDEFGH')).toBe('ABCD-EFGH')
  })

  it('does not leave a trailing dash', () => {
    expect(formatKeyInput('ABCD')).toBe('ABCD')
  })

  it('is empty for empty input', () => {
    expect(formatKeyInput('')).toBe('')
  })
})

describe('buildSupportMessage', () => {
  it('carries the three things support needs to act', () => {
    expect(
      buildSupportMessage({ accountId: 42, email: 'a@b.com', plan: 'annual' }),
    ).toBe(
      'Hello! I want to activate my IMS subscription. ' +
        'Account ID: 42, Email: a@b.com, Plan: Annual.',
    )
  })

  it('says renew for a lapsed customer', () => {
    // Support reads these at a glance; a new sale and a lapsed customer are different jobs.
    expect(
      buildSupportMessage({ accountId: 1, email: 'a@b.com', plan: 'monthly', renewing: true }),
    ).toContain('I want to renew my IMS subscription')
  })

  it('degrades to placeholders rather than printing undefined', () => {
    const message = buildSupportMessage({})
    expect(message).not.toMatch(/undefined|null/)
    expect(message).toContain('Account ID: —')
  })

  it('labels every plan the server can send', () => {
    expect(buildSupportMessage({ plan: 'one_time' })).toContain('Plan: Lifetime.')
    expect(buildSupportMessage({ plan: 'monthly' })).toContain('Plan: Monthly.')
    expect(buildSupportMessage({ plan: 'annual' })).toContain('Plan: Annual.')
  })
})

describe('chat deep links', () => {
  it('strips everything wa.me rejects from the number', () => {
    expect(whatsappUrl('+961 70-000 000', 'hi')).toBe('https://wa.me/96170000000?text=hi')
  })

  it('drops a leading @ from a telegram handle', () => {
    expect(telegramUrl('@ims_support', 'hi')).toBe('https://t.me/ims_support?text=hi')
  })

  it('percent-encodes the message', () => {
    // The message contains commas, spaces and a colon; an unencoded URL truncates at the
    // first one and support receives half an enquiry.
    expect(whatsappUrl('96170000000', 'a b,c')).toBe('https://wa.me/96170000000?text=a%20b%2Cc')
  })

  it('returns null when unconfigured so the caller hides the button', () => {
    expect(whatsappUrl('', 'hi')).toBeNull()
    expect(whatsappUrl(null, 'hi')).toBeNull()
    expect(telegramUrl('   ', 'hi')).toBeNull()
    expect(telegramUrl(undefined, 'hi')).toBeNull()
  })
})

describe('trialBannerMessage', () => {
  it('says nothing for a paid account', () => {
    expect(trialBannerMessage({ is_trial: false, trial_days_remaining: 5 })).toBeNull()
    expect(trialBannerMessage(null)).toBeNull()
  })

  it('counts down in plain language', () => {
    expect(trialBannerMessage({ is_trial: true, trial_days_remaining: 9 })).toBe(
      '9 days left in your free trial.',
    )
  })

  it('uses the singular on the last day', () => {
    expect(trialBannerMessage({ is_trial: true, trial_days_remaining: 1 })).toBe(
      '1 day left in your free trial.',
    )
  })

  it('handles the final hours without saying zero days', () => {
    expect(trialBannerMessage({ is_trial: true, trial_days_remaining: 0 })).toBe(
      'Your free trial ends today.',
    )
  })
})

describe('trialDaysRemaining', () => {
  // Built in *local* time, because the count is in local calendar days — a UTC literal would
  // make these tests pass or fail depending on the machine's timezone.
  const NOW = new Date(2026, 7, 25, 10, 0, 0).getTime()

  function endingIn(ms) {
    return { is_trial: true, trial_ends_at: new Date(NOW + ms).toISOString() }
  }

  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR

  it('counts whole days to the deadline', () => {
    expect(trialDaysRemaining(endingIn(9 * DAY), NOW)).toBe(9)
  })

  it('counts calendar days, not elapsed 24-hour blocks', () => {
    // 30 hours from 10:00 lands at 16:00 tomorrow — one sleep away, so "1 day left".
    expect(trialDaysRemaining(endingIn(30 * HOUR), NOW)).toBe(1)
    // Later today is zero days, however many hours that is. This is the case a raw
    // millisecond division gets wrong whichever way it rounds.
    expect(trialDaysRemaining(endingIn(HOUR), NOW)).toBe(0)
    expect(trialDaysRemaining(endingIn(13 * HOUR), NOW)).toBe(0)
  })

  it('clamps an elapsed trial at zero rather than going negative', () => {
    expect(trialDaysRemaining(endingIn(-3 * DAY), NOW)).toBe(0)
  })

  it('recomputes from the same payload as time passes', () => {
    // The whole point. `trial_days_remaining` is a snapshot taken when the payload was
    // fetched; a tab left open overnight would keep reporting it. Same account object, two
    // different clocks, two different answers.
    const account = endingIn(5 * DAY)
    expect(trialDaysRemaining(account, NOW)).toBe(5)
    expect(trialDaysRemaining(account, NOW + 3 * DAY)).toBe(2)
  })

  it('prefers the timestamp over the server’s day count when they disagree', () => {
    // They disagree exactly when the snapshot has gone stale, and the timestamp is the one
    // that is still true.
    const stale = { ...endingIn(2 * DAY), trial_days_remaining: 14 }
    expect(trialDaysRemaining(stale, NOW)).toBe(2)
  })

  it('falls back to the server count when there is no timestamp', () => {
    expect(trialDaysRemaining({ is_trial: true, trial_days_remaining: 6 }, NOW)).toBe(6)
    expect(trialDaysRemaining({ is_trial: true, trial_ends_at: null }, NOW)).toBeNull()
  })

  it('ignores an unparseable timestamp rather than reporting NaN days', () => {
    const broken = { is_trial: true, trial_ends_at: 'not a date', trial_days_remaining: 4 }
    expect(trialDaysRemaining(broken, NOW)).toBe(4)
  })
})

describe('trialBannerMessage with a deadline', () => {
  const NOW = new Date(2026, 7, 25, 10, 0, 0).getTime()
  const DAY = 24 * 60 * 60 * 1000

  it('distinguishes “ends today” from “has ended”', () => {
    // Both are 0 days, and they need different words: an elapsed trial is still reported as
    // is_trial until something refetches, and telling that user it "ends today" invites them
    // to keep working against an app that has already locked them out.
    const endsLater = { is_trial: true, trial_ends_at: new Date(NOW + 60_000).toISOString() }
    const alreadyOver = { is_trial: true, trial_ends_at: new Date(NOW - DAY).toISOString() }

    expect(trialBannerMessage(endsLater, NOW)).toBe('Your free trial ends today.')
    expect(trialBannerMessage(alreadyOver, NOW)).toBe('Your free trial has ended.')
  })

  it('counts down from the deadline', () => {
    const account = { is_trial: true, trial_ends_at: new Date(NOW + 4 * DAY).toISOString() }
    expect(trialBannerMessage(account, NOW)).toBe('4 days left in your free trial.')
  })
})

describe('isTrialUrgent', () => {
  it('stays quiet early in the trial', () => {
    // A fortnight-long banner that shouts from day one is a banner users stop seeing.
    expect(isTrialUrgent({ is_trial: true, trial_days_remaining: 10 })).toBe(false)
  })

  it('escalates near the end', () => {
    expect(isTrialUrgent({ is_trial: true, trial_days_remaining: 2 })).toBe(true)
  })

  it('is never urgent for a paid account', () => {
    expect(isTrialUrgent({ is_trial: false, trial_days_remaining: 0 })).toBe(false)
  })

  it('escalates off the deadline, not the stale day count', () => {
    const NOW = new Date(2026, 7, 25, 10, 0, 0).getTime()
    const DAY = 24 * 60 * 60 * 1000
    const account = {
      is_trial: true,
      trial_ends_at: new Date(NOW + 2 * DAY).toISOString(),
      trial_days_remaining: 14,
    }
    expect(isTrialUrgent(account, 3, NOW)).toBe(true)
  })
})

describe('subscriptionBadge', () => {
  it('reports an expired paid row as expired, not active', () => {
    // Nothing sweeps subscription_status on a schedule, so the stored column and the truth
    // disagree the moment a subscription lapses. The badge follows the computed flag.
    expect(subscriptionBadge({ subscription_status: 'active', subscription_live: false })).toEqual(
      { label: 'Expired', live: false },
    )
    expect(subscriptionBadge({ subscription_status: 'active', subscription_live: true })).toEqual(
      { label: 'Active', live: true },
    )
  })

  it('distinguishes a running trial from an elapsed one', () => {
    expect(
      subscriptionBadge({ subscription_status: 'trialing', subscription_live: true }).label,
    ).toBe('Trialing')
    expect(
      subscriptionBadge({ subscription_status: 'trialing', subscription_live: false }).label,
    ).toBe('Trial ended')
  })

  it('labels the remaining states', () => {
    expect(subscriptionBadge({ subscription_status: 'canceled' }).label).toBe('Canceled')
    expect(subscriptionBadge({ subscription_status: 'past_due' }).label).toBe('Past due')
    expect(subscriptionBadge({ subscription_status: 'pending_payment' }).label).toBe('Not active')
  })

  it('handles a superadmin with no account row', () => {
    expect(subscriptionBadge(null)).toEqual({ label: 'No subscription', live: false })
    expect(subscriptionBadge({}).label).toBe('No subscription')
  })
})

describe('renewalInfo', () => {
  it('points a trial at its own clock, not at expires_at', () => {
    const info = renewalInfo({
      subscription_status: 'trialing',
      trial_ends_at: '2026-08-26T00:00:00Z',
      expires_at: '2020-01-01T00:00:00Z',
    })
    expect(info).toEqual({ label: 'Trial ends', value: '2026-08-26T00:00:00Z' })
  })

  it('returns null for a lifetime licence', () => {
    // "Renews: —" invites the question of whether something is broken.
    expect(renewalInfo({ subscription_status: 'active', plan_type: 'one_time' })).toBeNull()
  })

  it('says expired rather than renews once the date has passed', () => {
    expect(
      renewalInfo({
        subscription_status: 'active',
        plan_type: 'monthly',
        expires_at: '2026-09-12T00:00:00Z',
        subscription_live: false,
      }).label,
    ).toBe('Expired')
  })

  it('survives a missing account or date', () => {
    expect(renewalInfo(null)).toBeNull()
    expect(renewalInfo({ subscription_status: 'active', plan_type: 'monthly' })).toBeNull()
    expect(renewalInfo({ subscription_status: 'trialing' })).toBeNull()
  })
})

describe('paymentMethodLabel', () => {
  it('names each inferred method', () => {
    expect(paymentMethodLabel('card')).toMatch(/card/i)
    expect(paymentMethodLabel('manual')).toMatch(/key|cash/i)
    expect(paymentMethodLabel('trial')).toMatch(/no card/i)
  })

  it('falls back rather than rendering a raw key', () => {
    expect(paymentMethodLabel('')).toBe('Not set')
    expect(paymentMethodLabel(undefined)).toBe('Not set')
  })
})

describe('formatDate', () => {
  it('returns null for missing or unparseable values', () => {
    // Null so callers can choose their own fallback — an em dash baked in here would show up
    // where "Never — lifetime licence" belongs.
    expect(formatDate(null)).toBeNull()
    expect(formatDate('')).toBeNull()
    expect(formatDate('not a date')).toBeNull()
  })

  it('formats an ISO timestamp', () => {
    expect(formatDate('2027-08-12T00:00:00Z')).toBe('Aug 12, 2027')
  })
})
