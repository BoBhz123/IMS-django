import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, ScanLine, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { DEFAULT_EXCHANGE_RATE, useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { BarcodeScannerModal } from '@/components/ui/BarcodeScannerModal'
import { ProductSearchModal } from '@/components/forms/ProductSearchModal'
import { SupplierForm } from '@/components/forms/SupplierForm'
import { ProductForm } from '@/components/forms/ProductForm'
import { CurrencyInput } from '@/components/ui/CurrencyInput'
import { ProductPicker } from '@/components/forms/ProductPicker'
import { lookupByBarcode } from '@/hooks/useBarcodeLookup'
import { useAllProducts } from '@/hooks/useAllProducts'
import { useOpenSession } from '@/hooks/useOpenSession'
import { PaymentSection } from '@/components/forms/PaymentSection'
import { PAYMENT_STATUS, partialAmountMissing, paymentPayload } from '@/lib/payment'
import { partyIdByName, toFormLines } from '@/lib/transactionEdit'

function emptyItem() {
  return { product: '', quantity: 1, unit_price: 0, product_name: '' }
}

export function PurchaseForm({ open, onClose, purchase = null, ...rest }) {
  // Keyed body: every opening remounts it, so a created purchase does not leave its supplier,
  // exchange rate and line items behind for the next one — and switching between two
  // purchases being edited re-hydrates rather than showing the first one's lines. See
  // useOpenSession.
  const session = useOpenSession(open)
  return (
    <SlideOver open={open} onClose={onClose} title={purchase ? 'Edit purchase' : 'Add purchase'}>
      <PurchaseFormBody
        key={`${session}:${purchase?.id ?? 'new'}`}
        onClose={onClose}
        purchase={purchase}
        {...rest}
      />
    </SlideOver>
  )
}

function PurchaseFormBody({ onClose, onSaved, suppliers: initialSuppliers, purchase = null }) {
  // See OrderFormBody — suppliers created in-context are merged locally rather than refetched.
  const [createdSuppliers, setCreatedSuppliers] = useState([])
  const suppliers = useMemo(
    () => [...initialSuppliers, ...createdSuppliers],
    [initialSuppliers, createdSuppliers],
  )
  const onSupplierCreated = useCallback((created) => {
    setCreatedSuppliers((current) => [...current, created])
  }, [])

  const { formatAmount, formatSecondary, showExchangeRate } = useCurrency()
  const editing = Boolean(purchase)

  // PurchaseItem.product is a *name* on the wire, not an id (PurchaseItemSerializer declares
  // it as a StringRelatedField), so editing has to resolve each line back to a product id
  // through the catalog before it can post anything.
  const { products: catalog, status: catalogStatus } = useAllProducts(editing)

  const [supplier, setSupplier] = useState(() =>
    editing ? partyIdByName(purchase.supplier, suppliers) : '',
  )
  const [exchangeRate, setExchangeRate] = useState(
    () => (editing ? purchase.exchange_rate : DEFAULT_EXCHANGE_RATE),
  )
  // Starts empty — see OrderFormBody. The seeded blank row was a dropdown waiting to be used,
  // and "+ Add product" now opens the picker directly.
  const [items, setItems] = useState([])
  const [hydrated, setHydrated] = useState(!editing)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const [paymentStatus, setPaymentStatus] = useState(() =>
    editing ? (purchase.payment_status ?? PAYMENT_STATUS.UNPAID) : PAYMENT_STATUS.PAID,
  )
  const [paidAmount, setPaidAmount] = useState(() =>
    editing ? Number(purchase.paid_amount) || 0 : 0,
  )

  useEffect(() => {
    if (hydrated || catalogStatus !== 'ready') return
    setItems(toFormLines(purchase.items, catalog, { productKey: 'name' }))
    setHydrated(true)
  }, [hydrated, catalogStatus, purchase, catalog])

  const [scannerOpen, setScannerOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [newSupplierOpen, setNewSupplierOpen] = useState(false)
  const [newProductOpen, setNewProductOpen] = useState(false)
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


  function removeItem(index) {
    setItems((current) => current.filter((_, i) => i !== index))
  }

  const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    const payload = {
      supplier: supplier || null,
      exchange_rate: Number(exchangeRate),
      ...paymentPayload(paymentStatus, paidAmount),
      items: items
        .filter((item) => item.product)
        .map((item) => ({
          product: Number(item.product),
          quantity: Number(item.quantity),
          unit_price: item.unit_price,
        })),
    }

    if (payload.items.length === 0) {
      setErrors({ detail: ['Add at least one item.'] })
      setSaving(false)
      return
    }

    // No error is set here: PaymentSection already renders the message beside the amount field,
    // and the submit button is disabled on the same condition. This is the backstop for a
    // programmatic submit, not the user-facing path.
    if (partialAmountMissing(paymentStatus, paidAmount)) {
      setSaving(false)
      return
    }

    try {
      if (editing) {
        // PUT for the same reason as OrderForm: the server replaces the lines wholesale, and
        // a PATCH omitting `items` would leave the originals standing.
        await api.put(`/inventory/purchases/${purchase.id}/`, payload)
      } else {
        await api.post('/inventory/purchases/', payload)
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

  if (!hydrated) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-[13px] text-text-secondary">
        {catalogStatus === 'error' ? (
          <p className="text-accent-red">Couldn't load this purchase for editing. Close and retry.</p>
        ) : (
          <>
            <Loader2 size={18} className="animate-spin text-accent-blue" />
            <p>Loading purchase…</p>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {editing && (
          <p className="rounded-xl bg-accent-blue/10 px-3 py-2 text-[12px] text-text-secondary">
            Saving replaces every line on this purchase. Stock moves by the difference —
            reducing a quantity below what is still on the shelf will be refused.
          </p>
        )}

        <Field label="Supplier">
          <div className="flex items-center gap-2">
            <select
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
            >
              <option value="">No supplier</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {/* Secondary sizing — see OrderForm's customer control. */}
            <button
              type="button"
              onClick={() => setNewSupplierOpen(true)}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-hairline p-2 text-sm font-medium text-accent-blue hover:bg-canvas-2"
            >
              <Plus className="h-4 w-4" />
              New
            </button>
          </div>
        </Field>

        {/* Hidden when the account is single-currency USD: with no conversion happening
            anywhere, the rate is noise on the form. It is still SENT — the column is the
            historical record of the day's rate and stays populated either way. With LBP as the
            primary currency the field stays visible, because the rate is then what turns every
            stored USD figure into the number on screen. See CurrencyContext.showExchangeRate. */}
        {showExchangeRate && (
          <Field label="Exchange rate (LBP per $)">
            <input
              type="number"
              min="1"
              value={exchangeRate}
              onChange={(event) => setExchangeRate(event.target.value)}
              className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary tabular-nums focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
            />
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-text-secondary">Items</span>
            {/* See OrderForm — primary sizing for the two ways stock gets onto a purchase. */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-2 rounded-xl bg-accent-blue p-3 text-base font-medium text-white hover:opacity-90"
              >
                <Plus className="h-6 w-6" />
                Add product
              </button>
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="flex items-center gap-2 rounded-xl bg-accent-blue/12 p-3 text-base font-medium text-accent-blue hover:bg-accent-blue/20"
              >
                <ScanLine className="h-6 w-6" />
                Scan barcode
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

          {items.length === 0 && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-hairline bg-canvas-2/40 px-3 py-8 text-center transition-colors hover:border-accent-blue/40 hover:bg-canvas-2/70"
            >
              <Plus size={18} className="text-text-tertiary" />
              <span className="text-[13px] text-text-secondary">
                No items yet — tap to add a product
              </span>
            </button>
          )}

          {items.map((item, index) => (
            <div key={index} className="rounded-xl border border-hairline p-3">
              <div className="mb-2 flex items-center gap-2">
                <ProductPicker
                  value={item.product}
                  selectedName={item.product_name}
                  onChange={(productId, product) => handleProductChange(index, productId, product)}
                />
                {/* Unconditional — see OrderForm. The old length guard only protected the
                    seeded blank row, which no longer exists. */}
                <button
                  type="button"
                  onClick={() => removeItem(index)}
                  aria-label="Remove item"
                  className="shrink-0 text-text-tertiary transition-colors hover:text-accent-red"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Qty"
                  value={item.quantity}
                  onChange={(v) => updateItem(index, { quantity: v })}
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

        <PaymentSection
          status={paymentStatus}
          onStatusChange={setPaymentStatus}
          paidAmount={paidAmount}
          onPaidAmountChange={setPaidAmount}
          total={total}
          exchangeRate={exchangeRate}
          formatAmount={formatAmount}
          formatSecondary={formatSecondary}
        />

        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Purchase total</span>
          <span className="flex flex-col items-end">
            <span className="font-semibold text-text-primary tabular-nums">{formatAmount(total, exchangeRate)}</span>
            {/* formatSecondary returns null with dual display off, so this line simply is not
                rendered — the "hide every secondary total" rule lives in one place. */}
            {formatSecondary(total, exchangeRate) && (
              <span className="text-[11px] text-text-tertiary tabular-nums">
                {formatSecondary(total, exchangeRate)}
              </span>
            )}
          </span>
        </div>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}
        {errors.items && (
          // An edit that would drive stock negative comes back as a list of per-product
          // messages, so a string-only branch would render nothing and the save would look
          // like it silently failed.
          <div className="text-[13px] text-accent-red">
            {(Array.isArray(errors.items) ? errors.items : [errors.items]).map((message) => (
              <p key={String(message)}>{String(message)}</p>
            ))}
          </div>
        )}

        <button
          type="submit"
          disabled={saving || partialAmountMissing(paymentStatus, paidAmount)}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {editing ? 'Save changes' : 'Create purchase'}
        </button>
      </form>

      {/* Outside the <form>: the scanner's own buttons default to type="submit". */}
      <BarcodeScannerModal open={scannerOpen} onClose={closeScanner} onScan={handleScan} />

      {/* disableOutOfStock={false}: a purchase is how stock arrives, so a zero-stock product
          is exactly the one being ordered. The order form disables those for the opposite
          reason. */}
      <ProductSearchModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(product) => {
          applyScannedProduct(product)
          setPickerOpen(false)
        }}
        onCreateNew={() => setNewProductOpen(true)}
        disableOutOfStock={false}
      />

      <SupplierForm
        open={newSupplierOpen}
        onClose={() => setNewSupplierOpen(false)}
        onSaved={(created) => {
          if (created) {
            onSupplierCreated(created)
            setSupplier(String(created.id))
          }
        }}
      />
      {/* See OrderForm — mounts above the picker, and a save adds the product at its cost
          price and closes both. */}
      <ProductForm
        open={newProductOpen}
        onClose={() => setNewProductOpen(false)}
        onSaved={(created) => {
          if (created) {
            applyScannedProduct(created)
            setPickerOpen(false)
          }
        }}
      />
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
