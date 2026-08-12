import { useEffect, useRef, useState } from 'react'

/**
 * A number that increases every time `open` flips false -> true.
 *
 * Used as the `key` on a form body so each opening remounts it and every field goes back to the
 * component's own defaults. The forms stay mounted while closed — that is what lets SlideOver
 * play its exit animation — and a mounted component keeps its state, so without this the next
 * "Add product" opens on the last product somebody typed.
 *
 * Preferred over resetting each piece of state in an effect: an effect only clears the state
 * somebody remembered to list, and the fields it misses are invisible until a user hits them.
 * Remounting cannot miss anything.
 */
export function useOpenSession(open) {
  const [session, setSession] = useState(0)
  const previous = useRef(open)

  useEffect(() => {
    if (open && !previous.current) setSession((s) => s + 1)
    previous.current = open
  }, [open])

  return session
}
