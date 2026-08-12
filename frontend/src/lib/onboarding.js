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
 *
 * `trialing` is not a status you can route on alone: a trial that has run out still reads
 * `trialing` in the database, because nothing sweeps the column on a schedule. So the caller
 * passes the whole account and the *computed* liveness decides — the same answer the server's
 * permission class reaches. Routing on the bare status would leave an elapsed trial staring at
 * a dashboard whose every API call 403s.
 */
/**
 * The only screens an unpaid or expired account may still reach.
 *
 * `/subscription` is the way out of the wall. `/settings` is on the list because it is where
 * the customer finds the account id and email support will ask them for, and locking someone
 * out of their own account details while asking them to pay is hostile. Neither screen calls
 * a gated endpoint, so allowing them costs nothing.
 */
export const UNPAID_ALLOWED_PATHS = ['/subscription', '/settings']

export function isAllowedWhileUnpaid(pathname) {
  if (!pathname) return false
  return UNPAID_ALLOWED_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`),
  )
}

/**
 * Where an account in this state must be sent, or null if it may stay where it is.
 *
 * `trialing` is not a status you can route on alone: a trial that has run out still reads
 * `trialing` in the database, because nothing sweeps the column on a schedule. So the caller
 * passes the whole account and the *computed* liveness decides — the same answer the server's
 * permission class reaches. Routing on the bare status would leave an elapsed trial staring at
 * a dashboard whose every API call 403s.
 *
 * `currentPath` lets the whitelist above apply. It deliberately does **not** apply to
 * `pending_verification`: an unverified account has not proved it owns the email address, and
 * letting it wander into settings would be a different and worse hole than an unpaid one.
 */
export function routeForAccountStatus(status, account = null, currentPath = null) {
  if (status === 'pending_verification') return '/signup/verify'

  let target = null
  if (status === 'trialing') {
    target = account?.subscription_live ? null : '/subscription'
  } else if (UNPAID_STATUSES.has(status)) {
    target = '/subscription'
  }

  if (target && isAllowedWhileUnpaid(currentPath)) return null
  return target
}

/** Convenience wrapper for callers holding an account object rather than a bare status. */
export function routeForAccount(account, currentPath = null) {
  return routeForAccountStatus(account?.subscription_status ?? null, account, currentPath)
}
