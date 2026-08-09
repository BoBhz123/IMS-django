import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { SlideOver } from '@/components/ui/SlideOver'
import { EXPENSE_CATEGORIES, toSpentAtISO, todayForInput } from '@/lib/expenses'

function initialForm(expense) {
  if (!expense) {
    return { description: '', amount: '', category: 'other', spent_on: todayForInput() }
  }
  return {
    description: expense.description,
    amount: String(expense.amount),
    category: expense.category,
    spent_on: expense.spent_at ? expense.spent_at.slice(0, 10) : todayForInput(),
  }
}

export function ExpenseForm({ open, onClose, onSaved, expense }) {
  const isEdit = Boolean(expense)
  const [form, setForm] = useState(() => initialForm(expense))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    const payload = {
      description: form.description,
      amount: form.amount,
      category: form.category,
      spent_at: toSpentAtISO(form.spent_on),
    }

    try {
      if (isEdit) {
        await api.patch(`/inventory/expenses/${expense.id}/`, payload)
      } else {
        await api.post('/inventory/expenses/', payload)
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
    <SlideOver open={open} onClose={onClose} title={isEdit ? 'Edit expense' : 'Add expense'}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Description" error={errors.description}>
          <input
            type="text"
            value={form.description}
            onChange={(event) => update('description', event.target.value)}
            required
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Amount (USD)" error={errors.amount}>
          <input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => update('amount', event.target.value)}
            required
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Category" error={errors.category}>
          <select
            value={form.category}
            onChange={(event) => update('category', event.target.value)}
            className={INPUT_CLASS}
          >
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date spent" error={errors.spent_at}>
          <input
            type="date"
            value={form.spent_on}
            onChange={(event) => update('spent_on', event.target.value)}
            className={`${INPUT_CLASS} scheme-light dark:scheme-dark`}
          />
        </Field>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Add expense'}
        </button>
      </form>
    </SlideOver>
  )
}

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none'

function Field({ label, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
      {error && <span className="text-[12px] text-accent-red">{error[0]}</span>}
    </label>
  )
}
