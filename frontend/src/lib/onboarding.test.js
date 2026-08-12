import { describe, expect, it } from 'vitest'
import {
  formatCooldown,
  isCompleteCode,
  isRegistrationExpiredError,
  normalizeCode,
  isAllowedWhileUnpaid,
  registrationSecondsRemaining,
  routeForAccount,
  routeForAccountStatus,
} from './onboarding'

describe('normalizeCode', () => {
  it('keeps only digits', () => {
    expect(normalizeCode('12-34 56')).toBe('123456')
  })

  it('truncates past six digits', () => {
    expect(normalizeCode('1234567890')).toBe('123456')
  })

  it('survives null and undefined', () => {
    expect(normalizeCode(null)).toBe('')
    expect(normalizeCode(undefined)).toBe('')
  })
})

describe('isCompleteCode', () => {
  it('is true at exactly six digits', () => {
    expect(isCompleteCode('123456')).toBe(true)
    expect(isCompleteCode('12345')).toBe(false)
    expect(isCompleteCode('')).toBe(false)
  })
})

describe('formatCooldown', () => {
  it('renders mm:ss', () => {
    expect(formatCooldown(65)).toBe('1:05')
    expect(formatCooldown(9)).toBe('0:09')
  })

  it('clamps negatives to zero', () => {
    expect(formatCooldown(-5)).toBe('0:00')
  })
})

describe('routeForAccountStatus', () => {
  it('sends unverified accounts to the code screen', () => {
    expect(routeForAccountStatus('pending_verification')).toBe('/signup/verify')
  })

  it('sends every unpaid state to the subscribe screen', () => {
    for (const status of ['pending_payment', 'past_due', 'canceled']) {
      expect(routeForAccountStatus(status)).toBe('/subscription')
    }
  })

  it('lets active accounts through', () => {
    expect(routeForAccountStatus('active')).toBeNull()
  })

  it('lets a superadmin with no account through', () => {
    // A null status is "no account row", not "unpaid" — otherwise the platform owner is
    // redirected to a paywall for a subscription they were never meant to have.
    expect(routeForAccountStatus(null)).toBeNull()
    expect(routeForAccountStatus(undefined)).toBeNull()
  })
})

describe('trial routing', () => {
  // A trial that has run out still reads `trialing` in the database — nothing sweeps the
  // column on a schedule — so the status alone cannot decide this.
  it('lets a running trial through', () => {
    expect(routeForAccountStatus('trialing', { subscription_live: true })).toBeNull()
  })

  it('sends an elapsed trial to the subscribe screen', () => {
    expect(routeForAccountStatus('trialing', { subscription_live: false })).toBe(
      '/subscription',
    )
  })

  it('treats a trialing status with no account object as elapsed', () => {
    // Failing closed: rendering the dashboard for an account whose every call 403s is worse
    // than one redundant redirect.
    expect(routeForAccountStatus('trialing')).toBe('/subscription')
  })

  it('routeForAccount reads the status off the account', () => {
    expect(routeForAccount({ subscription_status: 'trialing', subscription_live: true })).toBeNull()
    expect(routeForAccount({ subscription_status: 'pending_verification' })).toBe('/signup/verify')
    expect(routeForAccount(null)).toBeNull()
  })
})

describe('the unpaid whitelist', () => {
  it('lets an expired account stay on the screens it needs', () => {
    // /subscription is the way out of the wall; /settings is where the customer finds the
    // account id support will ask them for.
    for (const path of ['/subscription', '/settings']) {
      expect(routeForAccountStatus('canceled', null, path)).toBeNull()
      expect(routeForAccountStatus('past_due', null, path)).toBeNull()
      expect(routeForAccountStatus('trialing', { subscription_live: false }, path)).toBeNull()
    }
  })

  it('still bounces an expired account off every other screen', () => {
    for (const path of ['/', '/products', '/orders', '/customers']) {
      expect(routeForAccountStatus('canceled', null, path)).toBe('/subscription')
    }
  })

  it('does not let the whitelist bypass email verification', () => {
    // An unverified account has not proved it owns the address. That is a different and
    // worse hole than an unpaid one, so the whitelist deliberately does not apply.
    expect(routeForAccountStatus('pending_verification', null, '/settings')).toBe(
      '/signup/verify',
    )
  })

  it('matches nested paths under a whitelisted route', () => {
    expect(isAllowedWhileUnpaid('/settings/billing')).toBe(true)
    expect(isAllowedWhileUnpaid('/subscription')).toBe(true)
  })

  it('does not match a route that merely starts with the same letters', () => {
    // '/settings-export' is not '/settings'; a naive startsWith would let it through.
    expect(isAllowedWhileUnpaid('/settings-export')).toBe(false)
    expect(isAllowedWhileUnpaid('/subscriptions-report')).toBe(false)
  })

  it('treats a missing path as not whitelisted', () => {
    expect(isAllowedWhileUnpaid(null)).toBe(false)
    expect(isAllowedWhileUnpaid('')).toBe(false)
    expect(routeForAccountStatus('canceled')).toBe('/subscription')
  })

  it('routeForAccount forwards the path', () => {
    expect(routeForAccount({ subscription_status: 'canceled' }, '/settings')).toBeNull()
    expect(routeForAccount({ subscription_status: 'canceled' }, '/products')).toBe('/subscription')
  })

  it('never redirects a live account regardless of path', () => {
    expect(routeForAccount({ subscription_status: 'active' }, '/products')).toBeNull()
    expect(
      routeForAccount({ subscription_status: 'trialing', subscription_live: true }, '/products'),
    ).toBeNull()
  })
})

describe('isRegistrationExpiredError', () => {
  it('recognises the server slug', () => {
    expect(
      isRegistrationExpiredError({
        response: { status: 410, data: { code: 'registration_expired' } },
      }),
    ).toBe(true)
  })

  it('recognises the status even without a body', () => {
    expect(isRegistrationExpiredError({ response: { status: 410, data: {} } })).toBe(true)
  })

  it('leaves ordinary failures alone', () => {
    // A mistyped code must stay recoverable — treating it as an expired session would throw
    // away a registration over one wrong digit.
    expect(
      isRegistrationExpiredError({
        response: { status: 400, data: { code: 'invalid_code' } },
      }),
    ).toBe(false)
    expect(isRegistrationExpiredError(undefined)).toBe(false)
  })
})

describe('registrationSecondsRemaining', () => {
  const now = Date.parse('2026-08-12T12:00:00Z')

  it('counts down to the deadline', () => {
    const account = { registration_expires_at: '2026-08-12T12:10:00Z' }
    expect(registrationSecondsRemaining(account, now)).toBe(600)
  })

  it('clamps a passed deadline to zero rather than going negative', () => {
    const account = { registration_expires_at: '2026-08-12T11:59:00Z' }
    expect(registrationSecondsRemaining(account, now)).toBe(0)
  })

  it('is null when there is no session to count', () => {
    // A verified account has the column cleared, and a superadmin has no account at all.
    expect(registrationSecondsRemaining({ registration_expires_at: null }, now)).toBeNull()
    expect(registrationSecondsRemaining(null, now)).toBeNull()
    expect(registrationSecondsRemaining({ registration_expires_at: 'nonsense' }, now)).toBeNull()
  })
})
