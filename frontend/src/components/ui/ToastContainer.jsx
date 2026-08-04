import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import { subscribeToasts } from '@/lib/toast'

const AUTO_DISMISS_MS = 5000

export function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    return subscribeToasts((toast) => {
      setToasts((current) => [...current, toast])
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id))
      }, AUTO_DISMISS_MS)
    })
  }, [])

  function dismiss(id) {
    setToasts((current) => current.filter((t) => t.id !== id))
  }

  return createPortal(
    <div className="print:hidden fixed top-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

function ToastItem({ toast, onDismiss }) {
  const isError = toast.type === 'error'
  const Icon = isError ? AlertCircle : CheckCircle2

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24, scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start gap-2.5 rounded-squircle border border-glass-border bg-glass-strong p-3.5 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]"
    >
      <Icon
        size={18}
        className="mt-0.5 shrink-0"
        style={{ color: isError ? 'var(--delta-bad)' : 'var(--delta-good)' }}
      />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-text-primary">{toast.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-full p-0.5 text-text-tertiary hover:text-text-primary"
      >
        <X size={14} />
      </button>
    </motion.div>
  )
}
