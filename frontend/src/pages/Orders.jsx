import { useEffect, useState } from 'react'
import axios from 'axios'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  ShoppingCart,
} from 'lucide-react'
import { api } from '@/lib/api'
import { computeItemsTotal, formatDate, shortId } from '@/lib/format'
import { useCurrency } from '@/context/CurrencyContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { ExportButton } from '@/components/ui/ExportButton'
import { FilterField, FilterPopover, filterControlClass } from '@/components/ui/FilterPopover'
import { PaymentBadge } from '@/components/ui/PaymentBadge'
import { PAYMENT_OPTIONS } from '@/lib/payment'
import { btnGhost, btnGhostAccent, btnIcon, btnPrimary } from '@/lib/buttonStyles'
import { Invoice } from '@/components/invoice/Invoice'
import { TransactionDetail } from '@/components/transactions/TransactionDetail'
import { OrderForm } from '@/components/forms/OrderForm'

const PAGE_SIZE = 10
const YEAR_OPTIONS = [0, 1, 2].map((offset) => new Date().getFullYear() - offset)
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' }),
}))

export function Orders() {
  const { primaryCurrency, enableDualCurrency } = useCurrency()
  const [customers, setCustomers] = useState([])
  const [customer, setCustomer] = useState('all')
  const [year, setYear] = useState('all')
  const [month, setMonth] = useState('all')
  const [paymentStatus, setPaymentStatus] = useState('all')
  const [sort, setSort] = useState({ field: 'placed_at', direction: 'desc' })
  const [page, setPage] = useState(1)

  const [result, setResult] = useState({ count: 0, next: null, previous: null, results: [] })
  const [status, setStatus] = useState('loading')
  const [refreshKey, setRefreshKey] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [editOrder, setEditOrder] = useState(null)

  const [productCache, setProductCache] = useState(new Map())
  const [invoiceLoadingId, setInvoiceLoadingId] = useState(null)
  const [invoiceOrder, setInvoiceOrder] = useState(null)
  // The public link for the invoice currently open, and whether one is being minted. Kept
  // here rather than on the order row: it is per-viewing state, and closing the invoice
  // should not leave a stale token in the list.
  const [shareUrl, setShareUrl] = useState(null)
  const [sharing, setSharing] = useState(false)
  const [detailOrder, setDetailOrder] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/inventory/customers/', { signal: controller.signal })
      .then(({ data }) => setCustomers(data))
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    // AbortController, not a `cancelled` flag: the flag only suppressed the *response
    // handler*, leaving the request itself running. Navigating away from this page mid-load
    // left a heavyweight /orders/ fetch occupying one of the browser's ~6 connections to the
    // origin, so the page you navigated *to* queued behind it — which is why loading
    // Products appeared to trigger unrelated /orders/ and /purchases/ traffic.
    const controller = new AbortController()
    setStatus('loading')

    const params = { page, ordering: sort.direction === 'desc' ? `-${sort.field}` : sort.field }
    if (customer !== 'all') params.customer = customer
    if (year !== 'all') params.placed_at__year = year
    if (month !== 'all') params.placed_at__month = month
    if (paymentStatus !== 'all') params.payment_status = paymentStatus

    api
      .get('/inventory/orders/', { params, signal: controller.signal })
      .then(({ data }) => {
        setResult(data)
        setStatus('ready')
      })
      .catch((error) => {
        if (!axios.isCancel(error)) setStatus('error')
      })

    return () => controller.abort()
  }, [customer, year, month, paymentStatus, sort, page, refreshKey])

  const orders = result.results

  /** Filter/sort changes invalidate the current page number — always go back to page 1. */
  function resetToFirstPage(setter) {
    return (value) => {
      setter(value)
      setPage(1)
    }
  }

  function toggleSort(field) {
    setPage(1)
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'desc' },
    )
  }

  async function openInvoice(order) {
    setInvoiceLoadingId(order.id)
    try {
      const uniqueIds = [...new Set(order.items.map((item) => item.product))]
      const missing = uniqueIds.filter((id) => !productCache.has(id))

      let nextCache = productCache
      if (missing.length) {
        const fetched = await Promise.all(missing.map((id) => api.get(`/inventory/products/${id}/`)))
        nextCache = new Map(productCache)
        fetched.forEach(({ data }) => nextCache.set(data.id, data.name))
        setProductCache(nextCache)
      }

      // OrderSerializer.customer is a StringRelatedField (name only) — look up the phone
      // number and address from the already-fetched customers list by name (Customer.name is
      // unique per account).
      const matchedCustomer = customers.find((c) => c.name === order.customer)

      setInvoiceOrder({
        id: order.id,
        placed_at: order.placed_at,
        exchange_rate: order.exchange_rate,
        // Carried through explicitly. These were read off `invoiceOrder` further down but
        // never put on it, so every invoice printed as unpaid with a zero balance no matter
        // what had actually been settled.
        payment_status: order.payment_status,
        paid_amount: order.paid_amount,
        remaining_amount: order.remaining_amount,
        customer: order.customer,
        customerPhone: matchedCustomer?.phone_number || null,
        customerLocation: matchedCustomer?.location || null,
        items: order.items.map((item) => ({
          name: nextCache.get(item.product) ?? `Product #${item.product}`,
          quantity: item.quantity,
          unitPrice: item.unit_price,
        })),
      })
    } finally {
      setInvoiceLoadingId(null)
    }
  }

  function openDetail(order) {
    setDetailOrder(order)
  }

  function openEdit(order) {
    setEditOrder(order)
  }

  const exportParams = {}
  if (year !== 'all') exportParams.year = year
  if (month !== 'all') exportParams.month = month

  // Counted, not derived from the markup: only this component knows that 'all' means "not
  // filtered". The badge is what tells a user an empty list is their filter, not missing data.
  const activeFilters = [customer, year, month, paymentStatus].filter((v) => v !== 'all').length

  function clearFilters() {
    setCustomer('all')
    setYear('all')
    setMonth('all')
    setPaymentStatus('all')
    setPage(1)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* The filters collapse into one control; the export and the primary action stay out
            here, because burying the thing the user came to do is not a tidier header. */}
        <FilterPopover activeCount={activeFilters} onClear={clearFilters}>
          <FilterField label="Customer">
            <select
              value={customer}
              onChange={(event) => resetToFirstPage(setCustomer)(event.target.value)}
              className={filterControlClass}
            >
              <option value="all">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="Payment">
            <select
              value={paymentStatus}
              onChange={(event) => resetToFirstPage(setPaymentStatus)(event.target.value)}
              className={filterControlClass}
            >
              <option value="all">Any payment status</option>
              {PAYMENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterField>

          <div className="grid grid-cols-2 gap-2">
            <FilterField label="Year">
              <select
                value={year}
                onChange={(event) => resetToFirstPage(setYear)(event.target.value)}
                className={filterControlClass}
              >
                <option value="all">All years</option>
                {YEAR_OPTIONS.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="Month">
              <select
                value={month}
                onChange={(event) => resetToFirstPage(setMonth)(event.target.value)}
                className={filterControlClass}
              >
                <option value="all">All months</option>
                {MONTH_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </FilterField>
          </div>
        </FilterPopover>

        <div className="ml-auto flex items-center gap-2">
          <ExportButton url="/inventory/orders/export/csv/" params={exportParams} filename="orders.csv" />
          <button type="button" onClick={() => setAddOpen(true)} className={btnPrimary}>
            <Plus size={14} />
            Add order
          </button>
        </div>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn't load orders. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <OrdersTable
            orders={orders}
            sort={sort}
            onSort={toggleSort}
            loading={status === 'loading'}
            onViewInvoice={openInvoice}
            invoiceLoadingId={invoiceLoadingId}
            onViewDetail={openDetail}
            onEdit={openEdit}
          />
          <OrdersCards
            orders={orders}
            loading={status === 'loading'}
            onViewInvoice={openInvoice}
            invoiceLoadingId={invoiceLoadingId}
            onViewDetail={openDetail}
            onEdit={openEdit}
          />

          {status === 'ready' && result.count === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <ShoppingCart className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">No orders match your filters.</p>
            </div>
          )}

          {result.count > 0 && (
            <div className="flex items-center justify-between px-1 text-[13px] text-text-secondary">
              <span className="tabular-nums">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, result.count)} of {result.count}
              </span>
              <div className="flex items-center gap-1.5">
                <PageButton disabled={!result.previous} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={16} />
                </PageButton>
                <PageButton disabled={!result.next} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight size={16} />
                </PageButton>
              </div>
            </div>
          )}
        </>
      )}

      {invoiceOrder && (
        <Invoice
          open={Boolean(invoiceOrder)}
          onClose={() => {
            setInvoiceOrder(null)
            setShareUrl(null)
          }}
          documentType="Invoice"
          id={invoiceOrder.id}
          placedAt={invoiceOrder.placed_at}
          exchangeRate={invoiceOrder.exchange_rate}
          partyLabel="Customer"
          partyName={invoiceOrder.customer}
          partyPhone={invoiceOrder.customerPhone}
          partyLocation={invoiceOrder.customerLocation}
          items={invoiceOrder.items}
          primaryCurrency={primaryCurrency}
          showSecondaryCurrency={enableDualCurrency}
          paymentStatus={invoiceOrder.payment_status}
          paidAmount={Number(invoiceOrder.paid_amount) || 0}
          remainingAmount={Number(invoiceOrder.remaining_amount) || 0}
          shareUrl={shareUrl}
          sharing={sharing}
          onShare={async () => {
            setSharing(true)
            try {
              const { data } = await api.post(`/inventory/orders/${invoiceOrder.id}/share/`)
              setShareUrl(data.share_url)
            } finally {
              setSharing(false)
            }
          }}
        />
      )}

      {detailOrder && (
        <TransactionDetail
          open={Boolean(detailOrder)}
          onClose={() => setDetailOrder(null)}
          documentType="Order"
          id={detailOrder.id}
          placedAt={detailOrder.placed_at}
          exchangeRate={detailOrder.exchange_rate}
          paymentStatus={detailOrder.payment_status}
          paidAmount={Number(detailOrder.paid_amount) || 0}
          remainingAmount={Number(detailOrder.remaining_amount) || 0}
          partyLabel="Customer"
          partyName={detailOrder.customer}
          items={detailOrder.items}
          productKey="id"
          totalProfit={detailOrder.total_profit}
        />
      )}

      <OrderForm
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        customers={customers}
      />

      {/* A second instance rather than one form with a mode flag: `open` drives the
          SlideOver's mount/unmount animation, and toggling both the flag and the order on the
          same instance would animate the "Add order" panel into an "Edit order" one. */}
      <OrderForm
        open={Boolean(editOrder)}
        order={editOrder}
        onClose={() => setEditOrder(null)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        customers={customers}
      />
    </div>
  )
}

function SortHeader({ field, label, sort, onSort }) {
  const isActive = sort.field === field
  const Icon = isActive ? (sort.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`flex items-center gap-1 font-medium ${isActive ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'}`}
    >
      {label}
      <Icon size={12} strokeWidth={2.5} />
    </button>
  )
}

function InvoiceButton({ order, onViewInvoice, invoiceLoadingId }) {
  const loading = invoiceLoadingId === order.id
  return (
    <button
      type="button"
      onClick={() => onViewInvoice(order)}
      disabled={loading}
      className={btnGhostAccent}
    >
      {loading ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
      Invoice
    </button>
  )
}

function EditButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={btnGhost}
    >
      <Pencil size={12} />
      Edit
    </button>
  )
}

function ViewButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={btnGhost}
    >
      <Eye size={12} />
      View
    </button>
  )
}

function OrdersTable({ orders, sort, onSort, loading, onViewInvoice, invoiceLoadingId, onViewDetail, onEdit }) {
  const { formatAmount } = useCurrency()

  return (
    <GlassCard className="hidden overflow-hidden sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Customer</th>
              <th className="px-4 py-3 font-medium">
                <SortHeader field="placed_at" label="Date" sort={sort} onSort={onSort} />
              </th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Payment</th>
              <th className="px-4 py-3 text-right">
                <div className="flex justify-end">
                  <SortHeader field="annotated_total" label="Total" sort={sort} onSort={onSort} />
                </div>
              </th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-2.5" colSpan={7}>
                      <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
                    </td>
                  </tr>
                ))
              : orders.map((order) => {
                  const total = computeItemsTotal(order.items)
                  return (
                    <tr key={order.id} className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60">
                      <td className="px-5 py-2.5 font-medium text-text-primary tabular-nums">{shortId(order.id)}</td>
                      <td className="px-4 py-2.5 text-text-secondary">{order.customer ?? 'No customer'}</td>
                      <td className="px-4 py-2.5 text-text-secondary tabular-nums">{formatDate(order.placed_at)}</td>
                      <td className="px-4 py-2.5 text-text-secondary tabular-nums">{order.items.length}</td>
                      <td className="px-4 py-2.5">
                        <PaymentBadge
                          status={order.payment_status}
                          remaining={order.remaining_amount}
                          formatAmount={formatAmount}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-text-primary tabular-nums">
                        {formatAmount(total, order.exchange_rate)}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <ViewButton onClick={() => onViewDetail(order)} />
                          <EditButton onClick={() => onEdit(order)} />
                          <InvoiceButton order={order} onViewInvoice={onViewInvoice} invoiceLoadingId={invoiceLoadingId} />
                        </div>
                      </td>
                    </tr>
                  )
                })}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}

function OrdersCards({ orders, loading, onViewInvoice, invoiceLoadingId, onViewDetail, onEdit }) {
  const { formatAmount } = useCurrency()

  if (loading) {
    return (
      <div className="flex flex-col gap-2 sm:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-squircle-sm bg-canvas-2" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 sm:hidden">
      {orders.map((order) => {
        const total = computeItemsTotal(order.items)
        return (
          <GlassCard key={order.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-text-primary tabular-nums">{shortId(order.id)}</p>
                <p className="text-[12px] text-text-secondary">{order.customer ?? 'No customer'}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <p className="font-medium text-text-primary tabular-nums">{formatAmount(total, order.exchange_rate)}</p>
                <PaymentBadge
                  status={order.payment_status}
                  remaining={order.remaining_amount}
                  formatAmount={formatAmount}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-[12px] text-text-secondary">
              <span>
                {formatDate(order.placed_at)} · {order.items.length} items
              </span>
              <div className="flex items-center gap-1">
                <ViewButton onClick={() => onViewDetail(order)} />
                <EditButton onClick={() => onEdit(order)} />
                <InvoiceButton order={order} onViewInvoice={onViewInvoice} invoiceLoadingId={invoiceLoadingId} />
              </div>
            </div>
          </GlassCard>
        )
      })}
    </div>
  )
}

function PageButton({ disabled, onClick, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={btnIcon}
    >
      {children}
    </button>
  )
}
