import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { SlideOver } from '@/components/ui/SlideOver'
import { useOpenSession } from '@/hooks/useOpenSession'

const emptyForm = { name: '' }

export function CategoryForm({ open, onClose, ...rest }) {
  // Keyed body: every opening remounts it so the fields go back to their defaults instead of
  // holding whatever was last submitted. See useOpenSession.
  const session = useOpenSession(open)
  return (
    <SlideOver open={open} onClose={onClose} title={rest.category ? 'Edit category' : 'Add category'}>
      <CategoryFormBody key={session} onClose={onClose} {...rest} />
    </SlideOver>
  )
}

function CategoryFormBody({ onClose, onSaved, category }) {
  const isEdit = Boolean(category)
  const [name, setName] = useState(() => category?.name ?? emptyForm.name)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    try {
      if (isEdit) {
        await api.patch(`/inventory/categories/${category.id}/`, { name })
      } else {
        await api.post('/inventory/categories/', { name })
      }
      onSaved()
      onClose()
    } catch (error) {
      if (error.response?.status === 400) {
        setErrors(error.response.data)
      } else {
        setErrors({ detail: ['Something went wrong. Please try again.'] })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-text-secondary">Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          autoFocus
          placeholder="e.g. Drinks"
          className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
        />
        {/* The server rejects a name that already exists, case-insensitively, and says so here. */}
        {errors.name && <span className="text-[12px] text-accent-red">{errors.name[0]}</span>}
      </label>

      {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}

      <button
        type="submit"
        disabled={saving}
        className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        {isEdit ? 'Save changes' : 'Add category'}
      </button>
    </form>
  )
}
