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
 */
export function useOverlayLayer(open) {
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
    acquireScrollLock()
    return () => {
      popOverlay(idRef.current)
      releaseScrollLock()
    }
  }, [open])

  return {
    // 50 is the base every overlay used before this existed; each nested layer clears the one
    // beneath it, including that layer's backdrop.
    zIndex: 50 + Math.max(0, depth - 1) * 10,
    // A function, not a boolean: the answer has to be read at the moment Escape is pressed,
    // not captured when the listener was bound.
    isTop: () => isTopOverlay(idRef.current),
  }
}
