import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, ScanLine, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { DEFAULT_EXCHANGE_RATE, useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { BarcodeScannerModal } from '@/components/ui/BarcodeScannerModal'
import { CurrencyInput } from '@/components/ui/CurrencyInput'
import { ProductPicker } from '@/components/forms/ProductPicker'
import { lookupByBarcode } from '@/hooks/useBarcodeLookup'
import { useOpenSession } from '@/hooks/useOpenSession'

function emptyItem() {
  return { product: '', quantity: 1, unit_multiplier: 1, unit_price: 0, product_name: '' }
}

export function PurchaseForm({ open, onClose, ...rest }) {
  // Keyed body: every opening remounts it, so a created purchase does not leave its supplier,
  // exchange rate and line items behind for the next one. See useOpenSession.
  const session = useOpenSession(open)
  return (
    <SlideOver open={open} onClose={onClose} title="Add purchase">
      <PurchaseFormBody key={session} onClose={onClose} {...rest} />
    </SlideOver>
  )
}

function PurchaseFormBody({ onClose, onSaved, suppliers }) {
  const { formatAmount } = useCurrency()

  const [supplier, setSupplier] = useState('')
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE)
  const [items, setItems] = useState([emptyItem()])
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanMessage, setScanMessage] = useState(null)
  const [scanChoices, setScanChoices] = useState([])

  // Stable scan handlers: BarcodeScannerModal restarts the camera whenever they change, so they
  // read the current lines through a ref instead of closing over `items`.
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  /**
   * Put a scanned product on the purchase: bump the line that already holds it, otherwise take
   * the first blank line, otherwise append one.
   *
   * Deliberately uncapped, unlike the order flow — a purchase adds stock, so buying four of
   * something you currently hold two of is exactly the normal case.
   */
  const applyScannedProduct = useCallback((product) => {
    const current = itemsRef.current
    setScanChoices([])
    setScanMessage(null)

    const existing = current.findIndex((item) => String(item.product) === String(product.id))
    if (existing !== -1) {
      setItems(
        current.map((item, i) =>
          i === existing ? { ...item, quantity: (Number(item.quantity) || 0) + 1 } : item,
        ),
      )
      return
    }

    const line = {
      ...emptyItem(),
      product: String(product.id),
      // Same fill as handleProductChange below — a scan must not leave the line at $0.
      unit_price: product.cost_price,
      product_name: product.name,
    }
    const blank = current.findIndex((item) => !item.product)
    setItems(blank === -1 ? [...current, line] : current.map((item, i) => (i === blank ? line : item)))
  }, [])

  const handleScan = useCallback(
    async (code) => {
      setScannerOpen(false)
      setScanChoices([])
      setScanMessage(null)

      const { status, products } = await lookupByBarcode(code)

      if (status === 'found') {
        applyScannedProduct(products[0])
        return
      }
      if (status === 'ambiguous') {
        setScanChoices(products)
        setScanMessage(`${products.length} products share ${code}. Which one?`)
        return
      }
      setScanMessage(
        status === 'not_found'
          ? `No product has the barcode ${code}. Add it from Products first.`
          : "Couldn't look that barcode up. Check your connection and try again.",
      )
    },
    [applyScannedProduct],
  )

  const closeScanner = useCallback(() => setScannerOpen(false), [])

  function updateItem(index, patch) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  function handleProductChange(index, productId, product) {
    updateItem(index, {
      product: productId,
      unit_price: product ? product.cost_price : 0,
      product_name: product ? product.name : '',
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
      supplier: supplier || null,
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
      await api.post('/inventory/purchases/', payload)
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
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Supplier">
          <select
            value={supplier}
            onChange={(event) => setSupplier(event.target.value)}
            className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
          >
            <option value="">No supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
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
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="flex items-center gap-1 text-[12px] font-medium text-accent-blue hover:opacity-80"
              >
                <ScanLine size={13} />
                Scan barcode
              </button>
              <button
                type="button"
                onClick={addItem}
                className="flex items-center gap-1 text-[12px] font-medium text-accent-blue hover:opacity-80"
              >
                <Plus size={13} />
                Add item
              </button>
            </div>
          </div>

          {scanMessage && <p className="text-[12px] text-accent-orange">{scanMessage}</p>}

          {scanChoices.length > 0 && (
            <div className="flex flex-col gap-1 rounded-xl border border-hairline p-2">
              {scanChoices.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => applyScannedProduct(product)}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-canvas-2"
                >
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                </button>
              ))}
            </div>
          )}

          {items.map((item, index) => (
            <div key={index} className="rounded-xl border border-hairline p-3">
              <div className="mb-2 flex items-center gap-2">
                <ProductPicker
                  value={item.product}
                  selectedName={item.product_name}
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
                  <span className="mb-1 block text-[11px] text-text-tertiary">Unit cost</span>
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
          <span className="text-text-secondary">Purchase total</span>
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
          Create purchase
        </button>
      </form>

      {/* Outside the <form>: the scanner's own buttons default to type="submit". */}
      <BarcodeScannerModal open={scannerOpen} onClose={closeScanner} onScan={handleScan} />
    </>
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
