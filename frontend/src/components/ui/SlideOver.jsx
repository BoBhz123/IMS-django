import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'

export function SlideOver({ open, onClose, title, children }) {
  const { zIndex, isTop } = useOverlayLayer(open)

  useEffect(() => {
    if (!open) return
    function handleKeyDown(event) {
      // Only the topmost overlay reacts. Without this, Escape inside a quick-create modal
      // closes this slide-over too and takes every entered line item with it.
      if (event.key === 'Escape' && isTop()) onClose()
    }
    // Body scrolling is NOT touched here — useOverlayLayer refcounts it. See Modal.jsx and
    // lib/overlayStack.js.
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, isTop])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          style={{ zIndex }}
          className="fixed inset-0 flex justify-end bg-black/35 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 340, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
            className="flex h-full w-full max-w-md flex-col border-l border-glass-border bg-glass-strong backdrop-blur-2xl [box-shadow:var(--shadow-glass)]"
          >
            <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
              <h2 className="font-display text-[16px] font-semibold text-text-primary">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-canvas-2 text-text-secondary hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
