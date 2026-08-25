import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPageVisible, msUntilNextLocalMidnight, subscribeVisibility } from '@/lib/visibility'

/** jsdom's visibilityState is read-only, so it is redefined per test and restored after. */
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  delete document.visibilityState
})

describe('isPageVisible', () => {
  it('is true for a visible page', () => {
    setVisibility('visible')
    expect(isPageVisible()).toBe(true)
  })

  it('is false only for hidden', () => {
    setVisibility('hidden')
    expect(isPageVisible()).toBe(false)
  })

  it('treats prerender as visible', () => {
    // The spec defines 'prerender' for a page that is about to be shown. Testing for
    // === 'visible' instead would leave a freshly opened tab with its timers parked.
    setVisibility('prerender')
    expect(isPageVisible()).toBe(true)
  })
})

describe('subscribeVisibility', () => {
  it('reports each change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeVisibility(listener)

    setVisibility('hidden')
    expect(listener).toHaveBeenLastCalledWith(false)

    setVisibility('visible')
    expect(listener).toHaveBeenLastCalledWith(true)

    unsubscribe()
  })

  it('detaches the listener when unsubscribed', () => {
    // The whole reason this module exists: the unsubscribe function cannot be forgotten at a
    // call site without the omission being visible, and this is what it has to actually do.
    const listener = vi.fn()
    const unsubscribe = subscribeVisibility(listener)
    unsubscribe()

    setVisibility('hidden')
    expect(listener).not.toHaveBeenCalled()
  })

  it('is safe to unsubscribe twice', () => {
    const unsubscribe = subscribeVisibility(vi.fn())
    unsubscribe()
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('msUntilNextLocalMidnight', () => {
  it('measures to the next local midnight, not 24 hours out', () => {
    const from = new Date(2026, 7, 25, 22, 0, 0)
    expect(msUntilNextLocalMidnight(from)).toBe(2 * 60 * 60 * 1000)
  })

  it('rolls over the month correctly', () => {
    // Day 32 of March is April 1st — the Date constructor's own overflow, rather than
    // arithmetic on a timestamp, which is off by an hour across a DST boundary.
    const from = new Date(2026, 2, 31, 23, 30, 0)
    const midnight = new Date(msUntilNextLocalMidnight(from) + from.getTime())
    expect(midnight.getMonth()).toBe(3)
    expect(midnight.getDate()).toBe(1)
    expect(midnight.getHours()).toBe(0)
  })

  it('never returns zero', () => {
    // A zero-delay timeout that reschedules itself for zero is a busy loop that pins a core.
    const exactlyMidnight = new Date(2026, 7, 25, 0, 0, 0, 0)
    expect(msUntilNextLocalMidnight(exactlyMidnight)).toBeGreaterThan(0)
  })
})
