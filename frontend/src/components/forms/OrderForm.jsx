import { useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { DEFAULT_EXCHANGE_RATE, useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { CurrencyInput } from '@/components/ui/CurrencyInput'
import { ProductPicker } from '@/components/forms/ProductPicker'

function emptyItem() {
  return { product: '', quantity: 1, unit_multiplier: 1, unit_price: 0 }
}

export function OrderForm({ open, onClose, onSaved, customers }) {
  const { formatAmount } = useCurrency()

  const [customer, setCustomer] = useState('')
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE)
  const [items, setItems] = useState([emptyItem()])
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  function updateItem(index, patch) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function handleProductChange(index, productId, product) {
    updateItem(index, {
      product: productId,
      unit_price: product ? product.default_sell_price : 0,
    })
  }

  function addItem() {
    setItems((current) => [...current, emptyItem()])
  }

  function removeItem(index) {
    setItems((current) => current.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_multiplier * item.unit_price, 0)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    const payload = {
      customer: customer || null,
      exchange_rate: Number(exchangeRate),
      items: items
        .filter((item) => item.product)
        .map((item) => ({
          product: Number(item.product),
          quantity: Number(item.quantity),
          unit_multiplier: Number(item.unit_multiplier),
          unit_price: item.unit_price,
        })),
    }

    if (payload.items.length === 0) {
      setErrors({ detail: ['Add at least one item.'] })
      setSaving(false)
      return
    }

    try {
      await api.post('/inventory/orders/', payload)
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
    <SlideOver open={open} onClose={onClose} title="Add order">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Customer">
          <select
            value={customer}
            onChange={(event) => setCustomer(event.target.value)}
            className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
          >
            <option value="">No customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Exchange rate (LBP per $)">
          <input
            type="number"
            min="1"
            value={exchangeRate}
            onChange={(event) => setExchangeRate(event.target.value)}
            className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary tabular-nums focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
          />
        </Field>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-text-secondary">Items</span>
            <button
              type="button"
              onClick={addItem}
              className="flex items-center gap-1 text-[12px] font-medium text-accent-blue hover:opacity-80"
            >
              <Plus size={13} />
              Add item
            </button>
          </div>

          {items.map((item, index) => (
            <div key={index} className="rounded-xl border border-hairline p-3">
              <div className="mb-2 flex items-center gap-2">
                <ProductPicker
                  value={item.product}
                  onChange={(productId, product) => handleProductChange(index, productId, product)}
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    aria-label="Remove item"
                    className="shrink-0 text-text-tertiary hover:text-accent-red"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <NumberField
                  label="Qty"
                  value={item.quantity}
                  onChange={(v) => updateItem(index, { quantity: v })}
                />
                <NumberField
                  label="× per unit"
                  value={item.unit_multiplier}
                  onChange={(v) => updateItem(index, { unit_multiplier: v })}
                />
                <div>
                  <span className="mb-1 block text-[11px] text-text-tertiary">Unit price</span>
                  <CurrencyInput
                    valueUsd={item.unit_price}
                    onChangeUsd={(v) => updateItem(index, { unit_price: v })}
                    rate={exchangeRate}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Order total</span>
          <span className="font-semibold text-text-primary tabular-nums">{formatAmount(total, exchangeRate)}</span>
        </div>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}
        {errors.items && typeof errors.items === 'string' && (
          <p className="text-[13px] text-accent-red">{errors.items}</p>
        )}

        <button
          type="submit"
          disabled={saving}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          Create order
        </button>
      </form>
    </SlideOver>
  )
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  )
}

function NumberField({ label, value, onChange }) {
  return (
    <div>
      <span className="mb-1 block text-[11px] text-text-tertiary">{label}</span>
      <input
        type="number"
        min="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-[13px] text-text-primary tabular-nums focus:outline-none"
      />
    </div>
  )
}
