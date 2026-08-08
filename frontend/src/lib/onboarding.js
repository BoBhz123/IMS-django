export const CODE_LENGTH = 6

/** Digits only, capped at the code length — pasting "123 456" should just work. */
export function normalizeCode(raw) {
  return String(raw ?? '')
    .replace(/\D/g, '')
    .slice(0, CODE_LENGTH)
}

export function isCompleteCode(raw) {
  return normalizeCode(raw).length === CODE_LENGTH
}

export function formatCooldown(seconds) {
  const total = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

const UNPAID_STATUSES = new Set(['pending_payment', 'past_due', 'canceled'])

/**
 * Where an account in this state must be sent, or null if it may use the app.
 *
 * A null status means there is no account row — a platform superadmin, who is not scoped and
 * has no subscription. Treating that as "unpaid" would lock the owner out of their own admin.
 */
export function routeForAccountStatus(status) {
  if (status === 'pending_verification') return '/signup/verify'
  if (UNPAID_STATUSES.has(status)) return '/subscription'
  return null
}
