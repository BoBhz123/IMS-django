import { useEffect, useRef, useState } from 'react'
import {
  acquireScrollLock, isTopOverlay, popOverlay, pushOverlay, releaseScrollLock,
} from '@/lib/overlayStack'

/**
 * Stacking, Escape ownership, and body-scroll locking for one overlay.
 *
 * Returns the z-index it should render at and a predicate for "am I the one Escape should
 * close". Both Modal and SlideOver use it, which is what lets them nest without the inner one
 * dragging the outer one closed. See lib/overlayStack.js for why the registry is module-level,
 * and why the scroll lock is a refcount here rather than a line in each component.
 *
 * `lockScroll` separates the two jobs this hook does, which are not the same job.
 *
 * Escape ordering is wanted by every overlay. Freezing the page behind it is wanted only by the
 * ones that cover it: a modal or a slide-over is a mode, and scrolling the page underneath a
 * mode is meaningless. A *popover* is anchored to something on the page and dims nothing —
 * locking the page for it means opening a filter panel silently freezes the table the user
 * opened it to filter. This defaulted to always-on when the refcount was introduced, and
 * FilterPopover inherited a lock its own doc comment said it must not have.
 */
export function useOverlayLayer(open, { lockScroll = true } = {}) {
  // A stable identity per component instance. Symbol so two overlays can never collide.
  const idRef = useRef(null)
  if (idRef.current === null) idRef.current = Symbol('overlay')

  const [depth, setDepth] = useState(0)

  useEffect(() => {
    if (!open) {
      setDepth(0)
      return undefined
    }
    setDepth(pushOverlay(idRef.current))
    if (lockScroll) acquireScrollLock()
    return () => {
      popOverlay(idRef.current)
      // Symmetrical with the acquire above — releasing a lock this layer never took would
      // decrement the refcount on behalf of an overlay that is still open, handing scrolling
      // back while a modal is still covering the page.
      if (lockScroll) releaseScrollLock()
    }
  }, [open, lockScroll])

  return {
    // 50 is the base every overlay used before this existed; each nested layer clears the one
    // beneath it, including that layer's backdrop.
    zIndex: 50 + Math.max(0, depth - 1) * 10,
    // A function, not a boolean: the answer has to be read at the moment Escape is pressed,
    // not captured when the listener was bound.
    isTop: () => isTopOverlay(idRef.current),
  }
}
