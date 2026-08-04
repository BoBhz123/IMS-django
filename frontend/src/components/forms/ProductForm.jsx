import { useRef, useState } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { CurrencyInput } from '@/components/ui/CurrencyInput'

const emptyForm = {
  name: '',
  category: '',
  supplier: '',
  description: '',
  cost_price: 0,
  default_sell_price: 0,
  stock_quantity: 1,
}

export function ProductForm({ open, onClose, onSaved, product, categories, suppliers }) {
  const { formatAmount } = useCurrency()
  const isEdit = Boolean(product)
  const [form, setForm] = useState(() =>
    product
      ? {
          name: product.name,
          category: product.category ?? '',
          supplier: product.supplier ?? '',
          description: product.description ?? '',
          cost_price: product.cost_price,
          default_sell_price: product.default_sell_price,
          stock_quantity: product.stock_quantity,
        }
      : emptyForm,
  )
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const existingImage = product?.images?.[0]
  const [imageFile, setImageFile] = useState(null)
  const [imagePreview, setImagePreview] = useState(existingImage?.image ?? null)
  const [imageRemoved, setImageRemoved] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef(null)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function pickImage(file) {
    if (!file || !file.type.startsWith('image/')) return
    setImageFile(file)
    setImageRemoved(false)
    setImagePreview((current) => {
      if (current && current.startsWith('blob:')) URL.revokeObjectURL(current)
      return URL.createObjectURL(file)
    })
  }

  function clearImage() {
    setImageFile(null)
    setImageRemoved(true)
    setImagePreview((current) => {
      if (current && current.startsWith('blob:')) URL.revokeObjectURL(current)
      return null
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleDrop(event) {
    event.preventDefault()
    setDragActive(false)
    pickImage(event.dataTransfer.files?.[0])
  }

  // Read-only projection for display only — cost_price/default_sell_price are strict per-unit
  // values and must never be overwritten by this. Recomputed on every render from the current
  // quantity and unit cost, so it can never drift into becoming its own source of truth.
  const totalInventoryCost = Number(form.stock_quantity || 0) * Number(form.cost_price || 0)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    const payload = {
      name: form.name,
      category: form.category || null,
      supplier: form.supplier || null,
      description: form.description,
      cost_price: form.cost_price,
      default_sell_price: form.default_sell_price,
      stock_quantity: Number(form.stock_quantity),
    }

    try {
      let productId = product?.id
      if (isEdit) {
        await api.patch(`/inventory/products/${productId}/`, payload)
      } else {
        const { data } = await api.post('/inventory/products/', payload)
        productId = data.id
      }

      if (imageFile || (imageRemoved && existingImage)) {
        if (existingImage) {
          await api.delete(`/inventory/products/${productId}/images/${existingImage.id}/`)
        }
        if (imageFile) {
          const imageData = new FormData()
          imageData.append('image', imageFile)
          await api.post(`/inventory/products/${productId}/images/`, imageData)
        }
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
    <SlideOver open={open} onClose={onClose} title={isEdit ? 'Edit product' : 'Add product'}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Name" error={errors.name}>
          <TextInput value={form.name} onChange={(v) => update('name', v)} required />
        </Field>

        <Field label="Category" error={errors.category}>
          <Select value={form.category} onChange={(v) => update('category', v)} required placeholder="Select a category">
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Supplier" error={errors.supplier}>
          <Select value={form.supplier} onChange={(v) => update('supplier', v)} placeholder="No supplier">
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" error={errors.description}>
          <textarea
            value={form.description}
            onChange={(event) => update('description', event.target.value)}
            rows={3}
            className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
          />
        </Field>

        <Field label="Product image">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => pickImage(event.target.files?.[0])}
          />
          {imagePreview ? (
            <div className="relative w-fit">
              <img
                src={imagePreview}
                alt="Product preview"
                className="h-28 w-28 rounded-xl border border-hairline object-cover"
              />
              <button
                type="button"
                onClick={clearImage}
                aria-label="Remove image"
                className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-canvas text-text-secondary shadow-md hover:text-accent-red"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault()
                setDragActive(true)
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-6 text-center backdrop-blur-md transition-colors ${
                dragActive
                  ? 'border-accent-blue/60 bg-accent-blue/10'
                  : 'border-hairline bg-canvas-2/60 hover:border-accent-blue/40'
              }`}
            >
              <ImagePlus size={18} className="text-text-tertiary" />
              <span className="text-[12px] text-text-secondary">
                Drag & drop an image, or tap to choose one
              </span>
            </button>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost price" error={errors.cost_price}>
            <CurrencyInput valueUsd={form.cost_price} onChangeUsd={(v) => update('cost_price', v)} />
          </Field>
          <Field label="Sell price" error={errors.default_sell_price}>
            <CurrencyInput valueUsd={form.default_sell_price} onChangeUsd={(v) => update('default_sell_price', v)} />
          </Field>
        </div>

        <Field label="Stock quantity" error={errors.stock_quantity}>
          <input
            type="number"
            min="0"
            value={form.stock_quantity}
            onChange={(event) => update('stock_quantity', event.target.value)}
            required
            className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary tabular-nums focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
          />
        </Field>

        {/* Display-only: unit cost × quantity. Never fed back into cost_price/default_sell_price. */}
        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Total inventory cost (unit cost × qty)</span>
          <span className="font-semibold text-text-primary tabular-nums">
            {formatAmount(totalInventoryCost)}
          </span>
        </div>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Add product'}
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

function Select({ value, onChange, placeholder, children, ...props }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
      {...props}
    >
      <option value="">{placeholder}</option>
      {children}
    </select>
  )
}
