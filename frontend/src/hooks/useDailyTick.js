import { useEffect, useState } from 'react'
import { msUntilNextLocalMidnight, subscribeVisibility } from '@/lib/visibility'

/**
 * A timestamp that refreshes when the date rolls over, and whenever the tab comes back.
 *
 * For values that are derived from "now" but only change once a day — the trial countdown.
 * A one-second interval would give the same answer at a few thousand times the cost, and on a
 * component mounted in the app shell that cost is a re-render of everything below it.
 *
 * The visibility half is not an optimisation, it is the correctness half. A background tab has
 * its timers throttled to something like once a minute and, when the machine sleeps, not fired
 * at all — so a laptop closed on Tuesday and opened on Friday would still be showing Tuesday's
 * day count. Re-reading the clock on resume is what fixes that, and it is why every consumer
 * must *derive* from this timestamp rather than decrement a counter of its own.
 */
export function useDailyTick() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let timer = null

    function scheduleNextMidnight() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setNow(Date.now())
        scheduleNextMidnight()
      }, msUntilNextLocalMidnight())
    }

    scheduleNextMidnight()

    const unsubscribe = subscribeVisibility((visible) => {
      if (!visible) return
      // Both, and in this order: read the true time first, then re-aim the timer, which the
      // browser may have deferred by an arbitrary amount while the tab was in the background.
      setNow(Date.now())
      scheduleNextMidnight()
    })

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  return now
}
