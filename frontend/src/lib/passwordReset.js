import { isCompleteCode } from '@/lib/onboarding'

// The three screens, in order. Named rather than numbered so a reordering is a one-line
// change and the page never compares raw integers.
export const STEPS = ['request', 'code', 'password']

// Mirrors django.contrib.auth.password_validation.MinimumLengthValidator's default.
export const MIN_PASSWORD_LENGTH = 8

/**
 * The first thing wrong with a proposed password, or null.
 *
 * A courtesy check, not the authority: Django's validators also reject common and
 * entirely-numeric passwords using a word list this bundle has no business shipping. The
 * server is what decides, and its message is what gets displayed when it refuses — this
 * only spares the user a round trip for the two mistakes that are cheap to catch here.
 */
export function passwordProblem(newPassword, confirmPassword) {
  const password = newPassword ?? ''
  if (password.length === 0) return 'Enter a new password.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (/^\d+$/.test(password)) return 'Use more than just numbers.'
  if (password !== (confirmPassword ?? '')) return 'The two passwords do not match.'
  return null
}

/** Whether the password step may be submitted. */
export function canSubmitPassword(newPassword, confirmPassword) {
  return passwordProblem(newPassword, confirmPassword) === null
}

/** Whether the code step may be submitted. */
export function canSubmitCode(code) {
  return isCompleteCode(code)
}

/**
 * Turn an axios failure into something worth reading.
 *
 * DRF answers a field error as `{field: [messages]}` and a flow error as `{detail, code}`.
 * Reading only `detail` renders "[object Object]" for the first shape, which is exactly the
 * case that matters here — a rejected password is always a field error.
 */
export function errorMessage(error, fallback = 'Something went wrong. Please try again.') {
  const body = error?.response?.data
  if (!body) return fallback
  if (typeof body === 'string') return body
  if (typeof body.detail === 'string') return body.detail

  for (const key of ['new_password', 'confirm_password', 'code']) {
    const value = body[key]
    if (Array.isArray(value) && value.length > 0) return String(value[0])
    if (typeof value === 'string') return value
  }
  return fallback
}
