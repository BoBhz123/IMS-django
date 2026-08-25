// Mirrors accounts/billing/keys.py. No 0/O, no 1/I/L — the pairs people confuse when a key
// is read aloud over the phone.
export const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const KEY_LENGTH = 12
const GROUP_SIZE = 4

/** What the user typed, reduced to what the server stores. */
export function normalizeKey(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split('')
    .filter((character) => KEY_ALPHABET.includes(character))
    .join('')
    .slice(0, KEY_LENGTH)
}

export function isCompleteKey(raw) {
  return normalizeKey(raw).length === KEY_LENGTH
}

/** Dash-separated groups of four — the form the key was handed over in. */
export function formatKeyInput(raw) {
  const normalized = normalizeKey(raw)
  const groups = []
  for (let index = 0; index < normalized.length; index += GROUP_SIZE) {
    groups.push(normalized.slice(index, index + GROUP_SIZE))
  }
  return groups.join('-')
}

// --- Local payment (Whish / cash) --------------------------------------------------------
// These settle over chat, not a gateway: the customer messages us, pays by Whish or hands
// over cash, and we issue a discount key. The message is pre-filled because the three things
// support needs — which account, which login, which plan — are exactly the three things a
// customer will otherwise forget to include.

const PLAN_LABELS = {
  monthly: 'Monthly',
  annual: 'Annual',
  one_time: 'Lifetime',
}

export function planLabel(planKey) {
  return PLAN_LABELS[planKey] ?? 'Subscription'
}

/**
 * The pre-filled enquiry. `renewing` only changes the verb — support reads these at a glance
 * and "activate" vs "renew" is the difference between a new sale and a lapsed customer.
 */
export function buildSupportMessage({ accountId, email, plan, renewing = false } = {}) {
  const action = renewing ? 'renew' : 'activate'
  return (
    `Hello! I want to ${action} my IMS subscription. ` +
    `Account ID: ${accountId ?? '—'}, ` +
    `Email: ${email || '—'}, ` +
    `Plan: ${planLabel(plan)}.`
  )
}

/** Digits only — wa.me rejects +, spaces and dashes. */
export function normalizePhoneForWhatsApp(raw) {
  return String(raw ?? '').replace(/\D/g, '')
}

/**
 * Deep links. Null rather than a dead '#' when unconfigured, so the caller hides the button
 * instead of rendering a link that goes nowhere.
 */
export function whatsappUrl(number, message) {
  const digits = normalizePhoneForWhatsApp(number)
  if (!digits) return null
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

export function telegramUrl(username, message) {
  const handle = String(username ?? '').trim().replace(/^@/, '')
  if (!handle) return null
  return `https://t.me/${handle}?text=${encodeURIComponent(message)}`
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Local midnight at the start of the day containing `ms`. */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Whole days left in the trial, counted from `trial_ends_at`.
 *
 * `trial_ends_at` is the authority, not the account's join date. An admin can extend, reset or
 * revoke a trial (see the Django admin's actions), so "created_at + 14" is a guess that is
 * wrong for exactly the accounts somebody has intervened on — and it is wrong silently, in the
 * direction of promising days the account does not have.
 *
 * `account.trial_days_remaining` is the server's own answer and is the fallback, used when the
 * timestamp is missing. It is only a fallback because it is a snapshot: computed when the
 * payload was fetched, it does not change while the tab stays open, so a session left running
 * overnight keeps reporting yesterday's count. Deriving from the timestamp lets the same
 * payload produce a fresh answer whenever the component asks.
 *
 * Counts *calendar* days — how many local midnights sit between now and the deadline — not
 * elapsed 24-hour blocks. The two disagree exactly where a person would notice: a trial ending
 * at 23:00 tonight has 0 days left ("ends today"), not "1 day" because 13 hours is more than
 * zero. Dividing the raw millisecond gap gets that case wrong whichever way it rounds — floor
 * reports "0 days left" for a trial with 23 hours to run, ceil reports "1 day left" sixty
 * seconds before the thing expires.
 *
 * Math.round over the day difference, not floor: local midnights are 23 or 25 hours apart
 * across a DST boundary, and dividing that by 24h would drop or add a day once or twice a year.
 */
export function trialDaysRemaining(account, now = Date.now()) {
  if (!account) return null

  const endsAt = account.trial_ends_at ? Date.parse(account.trial_ends_at) : NaN
  if (Number.isNaN(endsAt)) {
    // No usable timestamp — fall back to whatever the server computed, including null.
    return account.trial_days_remaining ?? null
  }

  const days = Math.round((startOfLocalDay(endsAt) - startOfLocalDay(now)) / MS_PER_DAY)
  return days > 0 ? days : 0
}

/** Copy for the trial banner. Null means there is nothing worth interrupting the user for. */
export function trialBannerMessage(account, now = Date.now()) {
  if (!account?.is_trial) return null
  const days = trialDaysRemaining(account, now)
  if (days === null || days === undefined) return null
  // 0 covers both "ends later today" and "already elapsed" — trialDaysRemaining clamps.
  // The distinction matters: an elapsed trial is still reported as `is_trial` until something
  // refetches, and telling that user their trial "ends today" invites them to keep working
  // against an app that has already locked them out.
  if (days <= 0) return hasTrialElapsed(account, now)
    ? 'Your free trial has ended.'
    : 'Your free trial ends today.'
  if (days === 1) return '1 day left in your free trial.'
  return `${days} days left in your free trial.`
}

/** Whether the deadline is actually behind us, as opposed to later today. */
export function hasTrialElapsed(account, now = Date.now()) {
  const endsAt = account?.trial_ends_at ? Date.parse(account.trial_ends_at) : NaN
  if (Number.isNaN(endsAt)) return false
  return endsAt <= now
}

/**
 * Whether the banner should shout. A fortnight-long trial that nags from day one trains the
 * user to ignore it, so it stays quiet until the end is actually near.
 */
export function isTrialUrgent(account, threshold = 3, now = Date.now()) {
  if (!account?.is_trial) return false
  const days = trialDaysRemaining(account, now)
  return days !== null && days <= threshold
}

const PAYMENT_METHOD_LABELS = {
  card: 'Card (auto-renews)',
  manual: 'Activation key / cash',
  trial: 'Free trial — no card on file',
}

export function paymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] ?? 'Not set'
}

const STATUS_LABELS = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
  pending_payment: 'Not active',
  pending_verification: 'Awaiting verification',
}

/**
 * The badge to show for an account.
 *
 * Takes the whole account, not the status string, because the stored column and the truth
 * disagree the moment a subscription lapses — nothing sweeps `subscription_status` on a
 * schedule, so an `active` row past its expiry must read "Expired" and a `trialing` row past
 * its trial must read "Trial ended".
 */
export function subscriptionBadge(account) {
  const status = account?.subscription_status
  const live = Boolean(account?.subscription_live)

  if (!status) return { label: 'No subscription', live: false }
  if (status === 'active') return { label: live ? 'Active' : 'Expired', live }
  if (status === 'trialing') return { label: live ? 'Trialing' : 'Trial ended', live }
  return { label: STATUS_LABELS[status] ?? status, live }
}

/**
 * Which date actually matters for this account, and what to call it.
 *
 * A trial counts down to `trial_ends_at`; a paid plan to `expires_at`; a lifetime licence to
 * neither. Returning null for lifetime is deliberate — rendering "Renews: —" invites the
 * question of whether something is broken.
 */
export function renewalInfo(account) {
  if (!account) return null
  if (account.subscription_status === 'trialing') {
    return account.trial_ends_at
      ? { label: 'Trial ends', value: account.trial_ends_at }
      : null
  }
  if (account.plan_type === 'one_time') return null
  if (!account.expires_at) return null
  return {
    label: account.subscription_live ? 'Renews' : 'Expired',
    value: account.expires_at,
  }
}

/** Locale-formatted date, or null when the value is missing or unparseable. */
export function formatDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
