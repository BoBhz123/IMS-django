import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, ScanLine, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { DEFAULT_EXCHANGE_RATE, useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { BarcodeScannerModal } from '@/components/ui/BarcodeScannerModal'
import { ProductSearchModal } from '@/components/forms/ProductSearchModal'
import { CustomerForm } from '@/components/forms/CustomerForm'
import { ProductForm } from '@/components/forms/ProductForm'
import { CurrencyInput } from '@/components/ui/CurrencyInput'
import { ProductPicker } from '@/components/forms/ProductPicker'
import { StockBadge } from '@/components/ui/StockBadge'
import { lookupByBarcode } from '@/hooks/useBarcodeLookup'
import { useAllProducts } from '@/hooks/useAllProducts'
import { useOpenSession } from '@/hooks/useOpenSession'
import { hasBlockingStockError, stockStateFor } from '@/lib/stock'
import {
  availableStock, creditedUnitsByProductId, partyIdByName, toFormLines,
} from '@/lib/transactionEdit'

function emptyItem() {
  return { product: '', quantity: 1, unit_price: 0, stock_quantity: null, product_name: '' }
}

/**
 * Largest quantity this line may take: the product's stock less whatever the other lines
 * already claim. Duplicate lines for one product share a single pool, which is why this
 * subtracts the other lines rather than looking at this one alone.
 */
function maxQuantityFor(items, index) {
  const item = items[index]
  if (!item?.product) return undefined
  const available = Number(item.stock_quantity)
  if (!Number.isFinite(available)) return undefined

  const claimedElsewhere = items.reduce((sum, other, i) => {
    if (i === index || String(other.product) !== String(item.product)) return sum
    return sum + (Number(other.quantity) || 0)
  }, 0)

  return Math.max(0, available - claimedElsewhere)
}

export function OrderForm({ open, onClose, order = null, ...rest }) {
  // Keyed body: every opening remounts it, so a created order does not leave its customer,
  // exchange rate and line items behind for the next one — and so switching from editing one
  // order to editing another re-hydrates instead of showing the first one's lines. The
  // session key alone would not do the second job, hence the order id in it. See
  // useOpenSession.
  const session = useOpenSession(open)
  return (
    <SlideOver open={open} onClose={onClose} title={order ? 'Edit order' : 'Add order'}>
      <OrderFormBody
        key={`${session}:${order?.id ?? 'new'}`}
        onClose={onClose}
        order={order}
        {...rest}
      />
    </SlideOver>
  )
}

function OrderFormBody({ onClose, onSaved, customers: initialCustomers, order = null }) {
  // Customers created from inside this form are merged locally rather than triggering a
  // refetch through the page. A refetch would be a round trip the user waits on, and the
  // parent's list is only used to populate this one select.
  const [createdCustomers, setCreatedCustomers] = useState([])
  const customers = useMemo(
    () => [...initialCustomers, ...createdCustomers],
    [initialCustomers, createdCustomers],
  )
  const onCustomerCreated = useCallback((created) => {
    setCreatedCustomers((current) => [...current, created])
  }, [])

  const { formatAmount, formatSecondary, showExchangeRate } = useCurrency()
  const editing = Boolean(order)

  // Only editing needs the catalog: the saved lines carry product ids, and the form needs
  // each product's name (for the picker's label) and stock (for the quantity cap).
  const { products: catalog, status: catalogStatus } = useAllProducts(editing)

  const [customer, setCustomer] = useState(() =>
    editing ? partyIdByName(order.customer, customers) : '',
  )
  const [exchangeRate, setExchangeRate] = useState(
    () => (editing ? order.exchange_rate : DEFAULT_EXCHANGE_RATE),
  )
  const [items, setItems] = useState(() => (editing ? [] : [emptyItem()]))
  const [hydrated, setHydrated] = useState(!editing)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  /**
   * Stock this order already holds, per product — what the edit gives back before it takes
   * anything new. Without it every line of an order that sold out its product reads as "over
   * stock" and the form refuses to submit an edit that changes nothing about quantities.
   */
  const credited = useMemo(
    () => (editing ? creditedUnitsByProductId(order.items, catalog, 'id') : new Map()),
    [editing, order, catalog],
  )

  // Hydration waits for the catalog, so it cannot run in useState above.
  useEffect(() => {
    if (hydrated || catalogStatus !== 'ready') return
    setItems(toFormLines(order.items, catalog, { productKey: 'id', credited }))
    setHydrated(true)
  }, [hydrated, catalogStatus, order, catalog, credited])

  const [scannerOpen, setScannerOpen] = useState(false)
  // Direct product add (one step) and the two in-context quick-create surfaces.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [newCustomerOpen, setNewCustomerOpen] = useState(false)
  const [newProductOpen, setNewProductOpen] = useState(false)
  const [scanMessage, setScanMessage] = useState(null)
  const [scanChoices, setScanChoices] = useState([])

  // The scan handlers have to stay referentially stable — BarcodeScannerModal lists them in the
  // deps of the effect that starts the camera — so they cannot close over `items` directly.
  // `credited` is read through a ref for the same reason: it changes once, when the catalog
  // arrives, and that must not restart the camera mid-scan.
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const creditedRef = useRef(credited)
  useEffect(() => {
    creditedRef.current = credited
  }, [credited])

  /**
   * Put a scanned product on the order: bump the line that already holds it, otherwise take the
   * first blank line, otherwise append one.
   *
   * The increment goes through maxQuantityFor, the same cap the quantity input uses. Without it
   * a repeated scan walks past available stock and the server rejects the whole order at submit
   * time, with nothing to say which line was at fault.
   */
  const applyScannedProduct = useCallback((product) => {
    const current = itemsRef.current
    setScanChoices([])

    const existing = current.findIndex((item) => String(item.product) === String(product.id))
    if (existing !== -1) {
      const cap = maxQuantityFor(current, existing)
      const next = (Number(current[existing].quantity) || 0) + 1
      if (cap !== undefined && next > cap) {
        setScanMessage(
          `Only ${product.stock_quantity} of ${product.name} in stock — this order already claims them all.`,
        )
        return
      }
      setItems(current.map((item, i) => (i === existing ? { ...item, quantity: next } : item)))
      setScanMessage(null)
      return
    }

    const line = {
      ...emptyItem(),
      product: String(product.id),
      unit_price: product.default_sell_price,
      // Credited, like every other line: scanning a product back onto the order being
      // edited must see the same ceiling the hydrated lines do.
      stock_quantity: availableStock(product, creditedRef.current),
      product_name: product.name,
    }
    const blank = current.findIndex((item) => !item.product)
    setItems(blank === -1 ? [...current, line] : current.map((item, i) => (i === blank ? line : item)))
    setScanMessage(null)
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
        // Barcodes are deliberately non-unique in this app, so the only safe move is to ask.
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
      unit_price: product ? product.default_sell_price : 0,
      stock_quantity: product ? availableStock(product, credited) : null,
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
      customer: customer || null,
      exchange_rate: Number(exchangeRate),
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

    try {
      if (editing) {
        // PUT, not PATCH: the server replaces the line items wholesale, and a PATCH that
        // omitted `items` would leave the old lines standing. What is sent is the whole
        // order as it should now read.
        await api.put(`/inventory/orders/${order.id}/`, payload)
      } else {
        await api.post('/inventory/orders/', payload)
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
          <p className="text-accent-red">Couldn't load this order for editing. Close and retry.</p>
        ) : (
          <>
            <Loader2 size={18} className="animate-spin text-accent-blue" />
            <p>Loading order…</p>
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
            Saving replaces every line on this order. Stock is adjusted by the difference —
            what this order currently holds is released first.
          </p>
        )}

        <Field label="Customer">
          <div className="flex items-center gap-2">
            <select
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              className="min-w-0 flex-1 rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none"
            >
              <option value="">No customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* Secondary action: compact icon and padding, set against the primary
                Add product / Scan barcode pair below. */}
            <button
              type="button"
              onClick={() => setNewCustomerOpen(true)}
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
            {/* Primary actions: the two ways a line actually gets onto an order. Larger icon
                and padding than the secondary controls above (customer, exchange rate), which
                are set up once per order rather than used repeatedly. */}
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
                  onClick={() => {
                    applyScannedProduct(product)
                    setScanMessage(null)
                  }}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-text-primary hover:bg-canvas-2"
                >
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">
                    {product.stock_quantity} left
                  </span>
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

              {(() => {
                const stock = stockStateFor(items, index)
                if (stock.status === 'none') return null
                return (
                  <div className="mb-2 flex items-center gap-2">
                    {stock.status === 'out' && <StockBadge quantity={0} />}
                    {stock.status === 'limit' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-orange/15 px-2 py-0.5 text-[12px] font-medium text-accent-orange">
                        Reached limit — {stock.available} available
                      </span>
                    )}
                    {stock.status === 'over' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-red/15 px-2 py-0.5 text-[12px] font-medium text-accent-red">
                        Over stock by {-stock.remaining} — only {stock.available} available
                      </span>
                    )}
                    {stock.status === 'ok' && <StockBadge quantity={stock.remaining} />}
                  </div>
                )
              })()}

              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Qty"
                  value={item.quantity}
                  max={maxQuantityFor(items, index)}
                  onChange={(v) => updateItem(index, { quantity: v })}
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
          <div className="text-[13px] text-accent-red">
            {(Array.isArray(errors.items) ? errors.items : [errors.items]).map((message) => (
              <p key={String(message)}>{String(message)}</p>
            ))}
          </div>
        )}

        {hasBlockingStockError(items) && (
          <p className="text-[13px] text-accent-red">
            Reduce quantities to available stock before {editing ? 'saving' : 'creating'} this order.
          </p>
        )}

        <button
          type="submit"
          disabled={saving || hasBlockingStockError(items)}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {editing ? 'Save changes' : 'Create order'}
        </button>
      </form>

      {/* Outside the <form>: the scanner's own buttons default to type="submit". */}
      <BarcodeScannerModal open={scannerOpen} onClose={closeScanner} onScan={handleScan} />

      {/* One-step add: picking a product appends it (or increments the line already holding
          it) through the same applyScannedProduct the barcode path uses, so the stock cap and
          the duplicate-line rule cannot drift between the two entry points. */}
      <ProductSearchModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={applyScannedProduct}
        onCreateNew={() => setNewProductOpen(true)}
      />

      {/* Quick-create. Both render alongside this form rather than replacing it, and the
          overlay stack (lib/overlayStack.js) keeps Escape from closing the order underneath —
          losing entered line items to a stray keypress is the failure mode here. */}
      <CustomerForm
        open={newCustomerOpen}
        onClose={() => setNewCustomerOpen(false)}
        onSaved={(created) => {
          if (created) {
            onCustomerCreated(created)
            setCustomer(String(created.id))
          }
        }}
      />
      <ProductForm
        open={newProductOpen}
        onClose={() => setNewProductOpen(false)}
        onSaved={(created) => {
          if (created) applyScannedProduct(created)
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

function NumberField({ label, value, onChange, max }) {
  const atLimit = max !== undefined && Number(value) >= max
  return (
    <div>
      <span className="mb-1 block text-[11px] text-text-tertiary">{label}</span>
      <input
        type="number"
        min="1"
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={max !== undefined && Number(value) > max}
        className={`w-full rounded-lg border bg-canvas px-2 py-1.5 text-[13px] text-text-primary tabular-nums focus:outline-none ${
          atLimit ? 'border-accent-orange' : 'border-hairline'
        }`}
      />
    </div>
  )
}
