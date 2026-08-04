import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { SlideOver } from '@/components/ui/SlideOver'

const emptyForm = { name: '', phone_number: '' }

export function SupplierForm({ open, onClose, onSaved, supplier }) {
  const isEdit = Boolean(supplier)
  const [form, setForm] = useState(() =>
    supplier ? { name: supplier.name, phone_number: supplier.phone_number ?? '' } : emptyForm,
  )
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    try {
      if (isEdit) {
        await api.patch(`/inventory/suppliers/${supplier.id}/`, form)
      } else {
        await api.post('/inventory/suppliers/', form)
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
    <SlideOver open={open} onClose={onClose} title={isEdit ? 'Edit supplier' : 'Add supplier'}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          <TextInput value={form.name} onChange={(v) => update('name', v)} required />
        </Field>
        <Field label="Phone number" error={errors.phone_number}>
          <TextInput value={form.phone_number} onChange={(v) => update('phone_number', v)} />
        </Field>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Add supplier'}
        </button>
      </form>
    </SlideOver>
  )
}

function Field({ label, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
      {error && <span className="text-[12px] text-accent-red">{error[0]}</span>}
    </label>
  )
}

function TextInput({ value, onChange, ...props }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
      {...props}
    />
  )
}
