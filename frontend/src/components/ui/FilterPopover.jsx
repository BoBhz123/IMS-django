import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { SlidersHorizontal, X } from 'lucide-react'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'
import { btnGhost, btnSecondary } from '@/lib/buttonStyles'

/**
 * One "Show filters" button standing in for a row of inline selects.
 *
 * Every list page had grown its own sprawl of filter controls competing with the primary action
 * for the top of the screen. Collapsing them here keeps the header to "what this page is" plus
 * "the thing you came to do", and puts the count of active filters where a glance finds it.
 *
 * It registers through useOverlayLayer rather than binding its own Escape listener. That hook is
 * this project's answer to "which overlay does Escape close" (see lib/overlayStack.js), and a
 * popover that listened unconditionally would close the SlideOver behind it — the exact
 * regression the stack was written to prevent.
 *
 * Not a Modal: a popover is anchored, does not dim the page, and must not lock body scrolling.
 * It borrows the ordering, not the presentation.
 *
 * `activeCount` is supplied by the caller rather than derived from `children`. Only the page
 * knows which of its filter values count as "set" — 'all' and '' are both empty here, and the
 * markup cannot tell.
 */
export function FilterPopover({ activeCount = 0, onClear, children, label = 'Show filters' }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const { isTop } = useOverlayLayer(open)

  useEffect(() => {
    if (!open) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape' && isTop()) setOpen(false)
    }
    function handlePointerDown(event) {
      // The trigger lives inside the container, so its own click is excluded here and handled
      // by the button's onClick toggle — otherwise the two fight and the panel never opens.
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open, isTop])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // Spelled out rather than left to the default name computation, which concatenates the
        // label and the count badge with no separator and announces "Show filters2".
        aria-label={activeCount > 0 ? `${label} (${activeCount} active)` : label}
        className={btnSecondary}
      >
        <SlidersHorizontal size={14} />
        {label}
        {activeCount > 0 && (
          <span
            aria-hidden="true"
            className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-blue px-1.5 text-[11px] font-semibold text-white tabular-nums"
          >
            {activeCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Filters"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            // Left-anchored at every width. The trigger is the leftmost thing in each page
            // header, so aligning the panel's *right* edge to it would hang the panel off the
            // left of the viewport. Capped against the viewport so it cannot overflow right
            // either, which is what a narrow phone would otherwise do.
            className="absolute left-0 z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] origin-top-left rounded-squircle-sm border border-glass-border bg-glass-strong p-4 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[12px] font-semibold text-text-primary">Filters</span>
              <div className="flex items-center gap-1">
                {activeCount > 0 && onClear && (
                  <button type="button" onClick={onClear} className={btnGhost}>
                    Clear all
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close filters"
                  className="flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary hover:bg-canvas-2 hover:text-text-primary"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A labelled row inside the popover. Labels are visible, not sr-only — the controls have lost
 *  the surrounding page context that used to make an unlabelled select readable. */
export function FilterField({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      {children}
    </label>
  )
}

export const filterControlClass =
  'w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none'
