import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

export function Modal({ open, onClose, children, className = '' }) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          // Do NOT use `no-print`/display:none here — the invoice modal's printable content is
          // nested inside this backdrop, and a `display: none` ancestor drops its descendants from
          // print entirely (that was the blank-page bug). `print:hidden` is left off deliberately;
          // the print stylesheet's `body * { visibility: hidden }` already hides this for print,
          // while still letting `.invoice-print` (an actual descendant) opt back in to visible.
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm print:static print:block print:bg-transparent print:p-0 print:backdrop-blur-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
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
