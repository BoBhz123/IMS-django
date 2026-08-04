import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Eye, FileText, Plus, Truck } from 'lucide-react'
import { api } from '@/lib/api'
import { computeItemsTotal, formatDate, shortId } from '@/lib/format'
import { useCurrency } from '@/context/CurrencyContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { ExportButton } from '@/components/ui/ExportButton'
import { Invoice } from '@/components/invoice/Invoice'
import { TransactionDetail } from '@/components/transactions/TransactionDetail'
import { PurchaseForm } from '@/components/forms/PurchaseForm'

const PAGE_SIZE = 10
const YEAR_OPTIONS = [0, 1, 2].map((offset) => new Date().getFullYear() - offset)
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' }),
}))

export function Purchases() {
  const [suppliers, setSuppliers] = useState([])
  const [supplier, setSupplier] = useState('all')
  const [year, setYear] = useState('all')
  const [month, setMonth] = useState('all')
  const [sort, setSort] = useState({ field: 'placed_at', direction: 'desc' })
  const [page, setPage] = useState(1)

  const [purchases, setPurchases] = useState([])
  const [status, setStatus] = useState('loading')
  const [refreshKey, setRefreshKey] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [invoicePurchase, setInvoicePurchase] = useState(null)
  const [detailPurchase, setDetailPurchase] = useState(null)

  useEffect(() => {
    api
      .get('/inventory/suppliers/')
      .then(({ data }) => setSuppliers(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setPage(1)

    const params = { ordering: sort.direction === 'desc' ? `-${sort.field}` : sort.field }
    if (supplier !== 'all') params.supplier = supplier
    if (year !== 'all') params.placed_at__year = year
    if (month !== 'all') params.placed_at__month = month

    api
      .get('/inventory/purchases/', { params })
      .then(({ data }) => {
        if (!cancelled) {
          setPurchases(data)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [supplier, year, month, sort, refreshKey])

  const pageCount = Math.max(1, Math.ceil(purchases.length / PAGE_SIZE))
  const pagePurchases = useMemo(
    () => purchases.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [purchases, page],
  )

  function toggleSort(field) {
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'desc' },
    )
  }

  function openInvoice(purchase) {
    setInvoicePurchase({
      ...purchase,
      items: purchase.items.map((item) => ({
        name: item.product,
        quantity: item.quantity,
        unitMultiplier: item.unit_multiplier,
        unitPrice: item.unit_price,
      })),
    })
  }

  function openDetail(purchase) {
    setDetailPurchase(purchase)
  }

  const exportParams = {}
  if (year !== 'all') exportParams.year = year
  if (month !== 'all') exportParams.month = month

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect value={supplier} onChange={setSupplier} label="All suppliers">
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect value={year} onChange={setYear} label="All years">
          {YEAR_OPTIONS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect value={month} onChange={setMonth} label="All months">
          {MONTH_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </FilterSelect>

        <div className="ml-auto flex items-center gap-2">
          <ExportButton url="/inventory/purchases/export/csv/" params={exportParams} filename="purchases.csv" />
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
          >
            <Plus size={14} />
            Add purchase
          </button>
        </div>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn't load purchases. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <PurchasesTable
            purchases={pagePurchases}
            sort={sort}
            onSort={toggleSort}
            loading={status === 'loading'}
            onViewInvoice={openInvoice}
            onViewDetail={openDetail}
          />
          <PurchasesCards
            purchases={pagePurchases}
            loading={status === 'loading'}
            onViewInvoice={openInvoice}
            onViewDetail={openDetail}
          />

          {status === 'ready' && purchases.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Truck className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">No purchases match your filters.</p>
            </div>
          )}

          {purchases.length > 0 && (
            <div className="flex items-center justify-between px-1 text-[13px] text-text-secondary">
              <span className="tabular-nums">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, purchases.length)} of{' '}
                {purchases.length}
              </span>
              <div className="flex items-center gap-1.5">
                <PageButton disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={16} />
                </PageButton>
                <PageButton disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight size={16} />
                </PageButton>
              </div>
            </div>
          )}
        </>
      )}

      {invoicePurchase && (
        <Invoice
          open={Boolean(invoicePurchase)}
          onClose={() => setInvoicePurchase(null)}
          documentType="Purchase Order"
          id={invoicePurchase.id}
          placedAt={invoicePurchase.placed_at}
          exchangeRate={invoicePurchase.exchange_rate}
          partyLabel="Supplier"
          partyName={invoicePurchase.supplier}
          items={invoicePurchase.items}
        />
      )}

      {detailPurchase && (
        <TransactionDetail
          open={Boolean(detailPurchase)}
          onClose={() => setDetailPurchase(null)}
          documentType="Purchase"
          id={detailPurchase.id}
          placedAt={detailPurchase.placed_at}
          exchangeRate={detailPurchase.exchange_rate}
          partyLabel="Supplier"
          partyName={detailPurchase.supplier}
          items={detailPurchase.items}
          productKey="name"
        />
      )}

      <PurchaseForm
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        suppliers={suppliers}
      />
    </div>
  )
}

function FilterSelect({ value, onChange, label, children }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:outline-none"
    >
      <option value="all">{label}</option>
      {children}
    </select>
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

function InvoiceButton({ purchase, onViewInvoice }) {
  return (
    <button
      type="button"
      onClick={() => onViewInvoice(purchase)}
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-blue hover:bg-accent-blue/10"
    >
      <FileText size={12} />
      Invoice
    </button>
  )
}

function ViewButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
    >
      <Eye size={12} />
      View
    </button>
  )
}

function PurchasesTable({ purchases, sort, onSort, loading, onViewInvoice, onViewDetail }) {
  const { formatAmount } = useCurrency()

  return (
    <GlassCard className="hidden overflow-hidden sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3 font-medium">Purchase</th>
              <th className="px-4 py-3 font-medium">Supplier</th>
              <th className="px-4 py-3 font-medium">
                <SortHeader field="placed_at" label="Date" sort={sort} onSort={onSort} />
              </th>
              <th className="px-4 py-3 font-medium">Items</th>
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
                    <td className="px-5 py-2.5" colSpan={6}>
                      <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
                    </td>
                  </tr>
                ))
              : purchases.map((purchase) => {
                  const total = computeItemsTotal(purchase.items)
                  return (
                    <tr key={purchase.id} className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60">
                      <td className="px-5 py-2.5 font-medium text-text-primary tabular-nums">
                        {shortId(purchase.id)}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary">{purchase.supplier ?? 'No supplier'}</td>
                      <td className="px-4 py-2.5 text-text-secondary tabular-nums">
                        {formatDate(purchase.placed_at)}
                      </td>
                      <td className="px-4 py-2.5 text-text-secondary tabular-nums">{purchase.items.length}</td>
                      <td className="px-4 py-2.5 text-right font-medium text-text-primary tabular-nums">
                        {formatAmount(total, purchase.exchange_rate)}
                      </td>
                      <td className="px-5 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <ViewButton onClick={() => onViewDetail(purchase)} />
                          <InvoiceButton purchase={purchase} onViewInvoice={onViewInvoice} />
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

function PurchasesCards({ purchases, loading, onViewInvoice, onViewDetail }) {
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
      {purchases.map((purchase) => {
        const total = computeItemsTotal(purchase.items)
        return (
          <GlassCard key={purchase.id} className="flex flex-col gap-2 p-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-text-primary tabular-nums">{shortId(purchase.id)}</p>
                <p className="text-[12px] text-text-secondary">{purchase.supplier ?? 'No supplier'}</p>
              </div>
              <div className="text-right">
                <p className="font-medium text-text-primary tabular-nums">
                  {formatAmount(total, purchase.exchange_rate)}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between text-[12px] text-text-secondary">
              <span>
                {formatDate(purchase.placed_at)} · {purchase.items.length} items
              </span>
              <div className="flex items-center gap-1">
                <ViewButton onClick={() => onViewDetail(purchase)} />
                <InvoiceButton purchase={purchase} onViewInvoice={onViewInvoice} />
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
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-text-secondary hover:bg-canvas-2 hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}
