/**
 * One place that knows about `document.visibilityState`.
 *
 * Every consumer subscribing through here rather than binding its own listener is what makes
 * the teardown auditable: `subscribeVisibility` cannot be called without being handed the
 * function that removes the listener, so a caller that ignores the return value is visibly
 * wrong at the call site instead of leaking silently.
 *
 * Guarded against a missing `document` so this module is importable from a plain unit test (or
 * any non-DOM environment) without pulling in jsdom.
 */

export function isPageVisible() {
  // `!== 'hidden'` rather than `=== 'visible'`: the spec also defines 'prerender', and a
  // prerendering page is one that is about to be shown. Treating it as hidden would leave a
  // freshly opened tab with its timers parked.
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * Call `listener(visible)` whenever the page's visibility changes.
 * Returns the unsubscribe function — always call it from an effect's cleanup.
 */
export function subscribeVisibility(listener) {
  if (typeof document === 'undefined') return () => {}

  const handler = () => listener(isPageVisible())
  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}

/**
 * Milliseconds until the next local midnight.
 *
 * Local, not UTC: a trial countdown that rolls over at 02:00 because the user is in Beirut is
 * a bug the user experiences as the app being wrong about the date. Uses the Date constructor's
 * own month/day overflow (day 32 of March is April 1st) rather than adding 24h to a timestamp,
 * which is off by an hour across a DST boundary.
 */
export function msUntilNextLocalMidnight(from = new Date()) {
  const midnight = new Date(
    from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 0, 0,
  )
  // Never returns 0: a zero-delay timeout that reschedules itself for zero is a busy loop.
  return Math.max(1, midnight.getTime() - from.getTime())
}
