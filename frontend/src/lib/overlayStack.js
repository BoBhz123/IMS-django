/**
 * Which overlay is on top, so Escape closes one thing at a time.
 *
 * Modal and SlideOver each bind their own `keydown` listener on `document`. With two open at
 * once — a quick-create modal over the order form's slide-over — both listeners fire on a
 * single Escape, so the order form closes too and every line item the user had entered is
 * gone. That is the precise failure the "without losing existing form state" requirement is
 * about, and it cannot be fixed inside either component alone because neither knows the other
 * exists.
 *
 * Module-level rather than context: overlays are rendered from all over the tree (and through
 * portals), so a provider would have to wrap the whole app and still would not order them by
 * *open* time, which is the ordering that matters.
 */

const stack = []

/** Registers an overlay as open. Returns its depth, 1-based. */
export function pushOverlay(id) {
  stack.push(id)
  return stack.length
}

/**
 * Body-scroll ownership, refcounted.
 *
 * Modal and SlideOver each used to set `document.body.style.overflow = 'hidden'` on open and
 * blank it on close, independently. With the order form (SlideOver) → product picker (Modal) →
 * new product (SlideOver) stack that the quick-create flow actually produces, closing the
 * *inner* overlay handed page scrolling back while two overlays were still open. The reverse is
 * reachable too: `popOverlay`'s comment records that unmount order is not guaranteed to be the
 * reverse of mount order, so the last cleanup to run could be the one that re-locked it.
 *
 * A count, not a boolean: the lock has to survive every overlay above the last one releasing it.
 */
let scrollLocks = 0
let restoreOverflow = null

export function acquireScrollLock() {
  if (scrollLocks === 0) {
    // Saved rather than assumed to be '': blanking it would discard an overflow style the page
    // set for its own reasons, and nothing here has the standing to do that.
    restoreOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
  return scrollLocks
}

export function releaseScrollLock() {
  if (scrollLocks === 0) return 0
  scrollLocks -= 1
  if (scrollLocks === 0) {
    document.body.style.overflow = restoreOverflow ?? ''
    restoreOverflow = null
  }
  return scrollLocks
}

export function popOverlay(id) {
  const index = stack.indexOf(id)
  // indexOf rather than pop(): unmount order is not guaranteed to be the reverse of mount
  // order when a parent closes both at once, and popping blindly would drop the wrong entry.
  if (index !== -1) stack.splice(index, 1)
}

export function isTopOverlay(id) {
  return stack.length > 0 && stack[stack.length - 1] === id
}

/** Test seam — nothing in the app should need this. */
export function resetOverlayStack() {
  stack.length = 0
  // The scroll count has to be zeroed too, or one test that unmounts an overlay untidily leaves
  // `document.body` locked for every test after it in the same file.
  scrollLocks = 0
  restoreOverflow = null
  document.body.style.overflow = ''
}
