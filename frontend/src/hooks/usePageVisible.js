import { useEffect, useState } from 'react'
import { isPageVisible, subscribeVisibility } from '@/lib/visibility'

/**
 * Whether the tab is currently on screen.
 *
 * Used to park work that has no value while nobody is looking — polling intervals above all.
 * Browsers already throttle timers in a background tab, but throttled is not stopped: a
 * one-second countdown left running still wakes the tab, still re-renders, and still holds
 * whatever its closure captured. Worse, the throttling is what makes a resumed interval
 * *wrong*, because it fires late and by a variable amount.
 *
 * The rule for anything gated on this: recompute from a deadline on resume, never resume a
 * counter you were decrementing. See VerifyEmail's session countdown.
 */
export function usePageVisible() {
  const [visible, setVisible] = useState(isPageVisible)

  useEffect(() => subscribeVisibility(setVisible), [])

  return visible
}
