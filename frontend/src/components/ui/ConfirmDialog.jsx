import { useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Modal } from './Modal'

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Delete' }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch {
      setError("Couldn't delete this — it may still be referenced by products, orders, or purchases.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-sm">
      <div className="p-6">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-accent-red/10 text-accent-red">
          <TriangleAlert size={18} />
        </div>
        <h2 className="font-display text-[16px] font-semibold text-text-primary">{title}</h2>
        <p className="mt-1 text-[13px] text-text-secondary">{description}</p>

        {error && <p className="mt-3 text-[13px] text-accent-red">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-3 py-2 text-[13px] font-medium text-text-secondary hover:bg-canvas-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-xl bg-accent-red px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  )
}
