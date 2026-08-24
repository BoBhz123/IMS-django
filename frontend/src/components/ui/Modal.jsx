import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'

export function Modal({ open, onClose, children, className = '' }) {
  const { zIndex, isTop } = useOverlayLayer(open)

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event) {
      // See SlideOver — Escape closes the topmost overlay only.
      if (event.key === 'Escape' && isTop()) onClose()
    }
    // Body scrolling is NOT touched here. useOverlayLayer holds a refcounted lock instead —
    // this component's own cleanup used to hand scrolling back while an overlay underneath it
    // was still open. See lib/overlayStack.js.
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, isTop])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          // Do NOT use `no-print`/display:none here — the invoice modal's printable content is
          // nested inside this backdrop, and a `display: none` ancestor drops its descendants from
          // print entirely (that was the blank-page bug). `print:hidden` is left off deliberately;
          // the print stylesheet's `body * { visibility: hidden }` already hides this for print,
          // while still letting `.invoice-print` (an actual descendant) opt back in to visible.
          style={{ zIndex }}
          className="fixed inset-0 flex items-center justify-center bg-black/35 p-4 backdrop-blur-md print:static print:block print:bg-transparent print:p-0 print:backdrop-blur-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            // The same easing curve the SlideOver's spring settles on, so a modal opening over a
            // slide-over does not read as a different piece of software.
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
            className={`relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-squircle border border-glass-border bg-glass-strong backdrop-blur-2xl [box-shadow:var(--shadow-glass)] print:static print:block print:h-auto print:max-h-none print:w-auto print:max-w-none print:overflow-visible print:border-none print:bg-transparent print:shadow-none print:backdrop-blur-none ${className}`}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute top-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-canvas-2 text-text-secondary hover:text-text-primary"
            >
              <X size={16} />
            </button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
