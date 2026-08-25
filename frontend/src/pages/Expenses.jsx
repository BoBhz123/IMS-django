import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrency } from '@/context/CurrencyContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ExpenseForm } from '@/components/forms/ExpenseForm'
import { FilterField, FilterPopover, filterControlClass } from '@/components/ui/FilterPopover'
import { btnPrimary } from '@/lib/buttonStyles'
import { EXPENSE_CATEGORIES, categoryLabel } from '@/lib/expenses'

const PAGE_SIZE = 10

export function Expenses() {
  const { formatAmount } = useCurrency()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [spentAfter, setSpentAfter] = useState('')
  const [spentBefore, setSpentBefore] = useState('')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)

  const [result, setResult] = useState({ count: 0, results: [] })
  const [status, setStatus] = useState('loading')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 350)
    return () => clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    // AbortController, not a `cancelled` flag. The flag only suppressed the *response* — the
    // request itself still crossed the network and still held a connection, so every
    // superseded query ran to completion. See Orders.jsx, which was converted first.
    const controller = new AbortController()
    setStatus('loading')

    const params = { page, ordering: '-spent_at' }
    if (search) params.search = search
    if (category !== 'all') params.category = category
    if (spentAfter) params.spent_after = spentAfter
    if (spentBefore) params.spent_before = spentBefore

    api
      .get('/inventory/expenses/', { params, signal: controller.signal })
      .then(({ data }) => {
        setResult(data)
        setStatus('ready')
      })
      .catch((error) => {
        // A cancelled request is not a failure. Painting an error here would replace the
        // spinner of the load that superseded it.
        if (!axios.isCancel(error)) setStatus('error')
      })

    return () => controller.abort()
  }, [search, category, spentAfter, spentBefore, page, refreshKey])

  // The page's own total, not the account's. Labelled as such so it is never mistaken for
  // the dashboard's windowed total_expenses.
  const pageTotal = useMemo(
    () => result.results.reduce((sum, expense) => sum + Number(expense.amount), 0),
    [result],
  )

  const pageCount = Math.max(1, Math.ceil(result.count / PAGE_SIZE))
  const from = result.count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, result.count)

  function updateFilter(setter) {
    return (value) => {
      setter(value)
      setPage(1)
    }
  }

  // `searchInput`, not the debounced `search`: the badge should react as the user types rather
  // than 350ms later, which would read as the control being broken.
  const activeFilters = [
    searchInput,
    category !== 'all' ? category : '',
    spentAfter,
    spentBefore,
  ].filter(Boolean).length

  function clearFilters() {
    setSearchInput('')
    setSearch('')
    setCategory('all')
    setSpentAfter('')
    setSpentBefore('')
    setPage(1)
  }

  function openAdd() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(expense) {
    setEditing(expense)
    setFormOpen(true)
  }

  async function handleDelete() {
    await api.delete(`/inventory/expenses/${deleting.id}/`)
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPopover activeCount={activeFilters} onClear={clearFilters}>
          <FilterField label="Search">
            <div className="flex items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2">
              <Search size={15} className="shrink-0 text-text-tertiary" />
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search expenses…"
                aria-label="Search expenses"
                className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
          </FilterField>

          <FilterField label="Category">
            <select
              aria-label="Category"
              value={category}
              onChange={(event) => updateFilter(setCategory)(event.target.value)}
              className={filterControlClass}
            >
              <option value="all">All categories</option>
              {EXPENSE_CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterField>

          {/* Both boxes render the UA's identical mm/dd/yyyy hint, which says nothing about
              which end of the range it is — hence a visible label on each, not just an
              aria-label. */}
          <div className="grid grid-cols-2 gap-2">
            <DateFilter
              label="Start date"
              value={spentAfter}
              onChange={updateFilter(setSpentAfter)}
            />
            <DateFilter
              label="End date"
              value={spentBefore}
              onChange={updateFilter(setSpentBefore)}
            />
          </div>
        </FilterPopover>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={openAdd} className={btnPrimary}>
            <Plus size={14} />
            Add expense
          </button>
        </div>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn&apos;t load expenses. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <ExpenseTable
            expenses={result.results}
            loading={status === 'loading'}
            formatAmount={formatAmount}
            onEdit={openEdit}
            onDelete={setDeleting}
          />

          {status === 'ready' && result.count === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Receipt className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">
                No expenses match these filters.
              </p>
            </div>
          )}

          {result.count > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px] text-text-secondary">
              <span className="tabular-nums">
                Showing {from}–{to} of {result.count} · this page totals{' '}
                <span className="font-medium text-text-primary">{formatAmount(pageTotal)}</span>
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

      <ExpenseForm
        key={editing?.id ?? 'new'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        expense={editing}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete expense?"
        description={`"${deleting?.description}" will be permanently removed and will no longer count against net profit.`}
      />
    </div>
  )
}

// color-scheme is inherited from :root / .dark in index.css, so the native picker and its
// calendar glyph already follow the theme. Restating it here — tied to the theme, never
// hardcoded to dark — keeps that true if this input is ever moved inside a container that
// resets it, and is what stops a light-on-light glyph in dark mode.
const DATE_FILTER_CLASS = `${filterControlClass} scheme-light dark:scheme-dark [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100`

function DateFilter({ label, value, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-text-tertiary">{label}</span>
      <input
        type="date"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={DATE_FILTER_CLASS}
      />
    </label>
  )
}

function ExpenseTable({ expenses, loading, formatAmount, onEdit, onDelete }) {
  return (
    <GlassCard className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Date spent</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-2.5" colSpan={5}>
                      <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
                    </td>
                  </tr>
                ))
              : expenses.map((expense) => (
                  <tr
                    key={expense.id}
                    className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-text-primary">
                      {expense.description}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {expense.category_display ?? categoryLabel(expense.category)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-secondary">
                      {expense.spent_at?.slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-text-primary">
                      {formatAmount(Number(expense.amount))}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(expense)}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-blue hover:bg-accent-blue/10"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${expense.description}`}
                          onClick={() => onDelete(expense)}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-red hover:bg-accent-red/10"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
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
