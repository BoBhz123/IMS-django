import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireScrollLock,
  isTopOverlay,
  popOverlay,
  pushOverlay,
  releaseScrollLock,
  resetOverlayStack,
} from './overlayStack'

describe('overlayStack', () => {
  beforeEach(() => resetOverlayStack())

  it('reports the most recently opened overlay as the top one', () => {
    const back = Symbol('slide-over')
    const front = Symbol('modal')
    pushOverlay(back)
    pushOverlay(front)

    expect(isTopOverlay(front)).toBe(true)
    // The load-bearing half: an Escape press must not reach the order form underneath, or
    // every line item the user entered is discarded along with the quick-create dialog.
    expect(isTopOverlay(back)).toBe(false)
  })

  it('hands the top back when the front overlay closes', () => {
    const back = Symbol('slide-over')
    const front = Symbol('modal')
    pushOverlay(back)
    pushOverlay(front)
    popOverlay(front)

    expect(isTopOverlay(back)).toBe(true)
  })

  it('returns a 1-based depth so the caller can derive a z-index', () => {
    expect(pushOverlay(Symbol('a'))).toBe(1)
    expect(pushOverlay(Symbol('b'))).toBe(2)
  })

  it('removes the right entry when overlays close out of order', () => {
    // Unmount order is not guaranteed to be the reverse of mount order when a parent closes
    // both at once, so a blind pop() would drop the wrong one and leave a ghost on top.
    const first = Symbol('first')
    const second = Symbol('second')
    const third = Symbol('third')
    pushOverlay(first)
    pushOverlay(second)
    pushOverlay(third)

    popOverlay(second)
    expect(isTopOverlay(third)).toBe(true)
    popOverlay(third)
    expect(isTopOverlay(first)).toBe(true)
  })

  it('ignores an unknown id rather than corrupting the stack', () => {
    const open = Symbol('open')
    pushOverlay(open)
    popOverlay(Symbol('never-opened'))
    expect(isTopOverlay(open)).toBe(true)
  })

  it('has no top when nothing is open', () => {
    expect(isTopOverlay(Symbol('anything'))).toBe(false)
  })
})

describe('overlayStack scroll lock', () => {
  beforeEach(() => resetOverlayStack())

  it('locks the body while any overlay holds the lock', () => {
    acquireScrollLock()
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('keeps the body locked until the LAST overlay releases', () => {
    // The bug this replaces: the order form, the product picker and the quick-create product
    // form are open at once, and closing the innermost one used to hand page scrolling back
    // while two overlays were still covering the screen.
    acquireScrollLock()
    acquireScrollLock()
    acquireScrollLock()

    releaseScrollLock()
    expect(document.body.style.overflow).toBe('hidden')
    releaseScrollLock()
    expect(document.body.style.overflow).toBe('hidden')
    releaseScrollLock()
    expect(document.body.style.overflow).toBe('')
  })

  it('balances when overlays release out of order', () => {
    // Releases carry no identity, so out-of-order unmounts are just three decrements — the
    // point of the test is that the count, not the ordering, is what governs.
    acquireScrollLock()
    acquireScrollLock()
    releaseScrollLock()
    releaseScrollLock()
    expect(document.body.style.overflow).toBe('')
  })

  it('restores the page\'s own overflow style rather than blanking it', () => {
    document.body.style.overflow = 'scroll'
    acquireScrollLock()
    expect(document.body.style.overflow).toBe('hidden')
    releaseScrollLock()
    expect(document.body.style.overflow).toBe('scroll')
    document.body.style.overflow = ''
  })

  it('ignores an unbalanced release instead of going negative', () => {
    // A negative count would mean the next acquire never reaches 1 and the body never locks.
    releaseScrollLock()
    acquireScrollLock()
    expect(document.body.style.overflow).toBe('hidden')
    releaseScrollLock()
    expect(document.body.style.overflow).toBe('')
  })
})
