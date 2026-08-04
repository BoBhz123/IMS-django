import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { GlassCard } from '@/components/ui/GlassCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { SupplierForm } from '@/components/forms/SupplierForm'

const PAGE_SIZE = 10

export function Suppliers() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState({ field: 'name', direction: 'asc' })
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)

  const [suppliers, setSuppliers] = useState([])
  const [status, setStatus] = useState('loading')

  const [formOpen, setFormOpen] = useState(false)
  const [editingSupplier, setEditingSupplier] = useState(null)
  const [deletingSupplier, setDeletingSupplier] = useState(null)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 350)
    return () => clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')

    const params = { ordering: sort.direction === 'desc' ? `-${sort.field}` : sort.field }
    if (search) params.search = search

    api
      .get('/inventory/suppliers/', { params })
      .then(({ data }) => {
        if (!cancelled) {
          setSuppliers(data)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [search, sort, refreshKey])

  const pageCount = Math.max(1, Math.ceil(suppliers.length / PAGE_SIZE))
  const pageSuppliers = useMemo(
    () => suppliers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [suppliers, page],
  )

  function toggleSort(field) {
    setPage(1)
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' },
    )
  }

  function openAdd() {
    setEditingSupplier(null)
    setFormOpen(true)
  }

  function openEdit(supplier) {
    setEditingSupplier(supplier)
    setFormOpen(true)
  }

  async function handleDelete() {
    await api.delete(`/inventory/suppliers/${deletingSupplier.id}/`)
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2">
          <Search size={15} className="shrink-0 text-text-tertiary" />
          <input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search suppliers…"
            className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={14} />
          Add supplier
        </button>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn't load suppliers. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <SupplierTable
            suppliers={pageSuppliers}
            sort={sort}
            onSort={toggleSort}
            loading={status === 'loading'}
            onEdit={openEdit}
            onDelete={setDeletingSupplier}
          />
          <SupplierCards
            suppliers={pageSuppliers}
            loading={status === 'loading'}
            onEdit={openEdit}
            onDelete={setDeletingSupplier}
          />

          {status === 'ready' && suppliers.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Building2 className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">No suppliers match your search.</p>
            </div>
          )}

          {suppliers.length > 0 && (
            <div className="flex items-center justify-between px-1 text-[13px] text-text-secondary">
              <span className="tabular-nums">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, suppliers.length)} of{' '}
                {suppliers.length}
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

      <SupplierForm
        key={editingSupplier?.id ?? 'new'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        supplier={editingSupplier}
      />

      <ConfirmDialog
        open={Boolean(deletingSupplier)}
        onClose={() => setDeletingSupplier(null)}
        onConfirm={handleDelete}
        title="Delete supplier?"
        description={`"${deletingSupplier?.name}" will be permanently removed. This will fail if any products still reference this supplier.`}
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

function RowActions({ onEdit, onDelete }) {
  return (
    <div className="flex justify-end gap-1">
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-blue hover:bg-accent-blue/10"
      >
        <Pencil size={12} />
        Edit
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-red hover:bg-accent-red/10"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

function SupplierTable({ suppliers, sort, onSort, loading, onEdit, onDelete }) {
  return (
    <GlassCard className="hidden overflow-hidden sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3">
                <SortHeader field="name" label="Name" sort={sort} onSort={onSort} />
              </th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-2.5" colSpan={3}>
                      <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
                    </td>
                  </tr>
                ))
              : suppliers.map((supplier) => (
                  <tr key={supplier.id} className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60">
                    <td className="px-5 py-2.5 font-medium text-text-primary">{supplier.name}</td>
                    <td className="px-4 py-2.5 text-text-secondary">{supplier.phone_number || '—'}</td>
                    <td className="px-5 py-2.5">
                      <RowActions onEdit={() => onEdit(supplier)} onDelete={() => onDelete(supplier)} />
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}

function SupplierCards({ suppliers, loading, onEdit, onDelete }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 sm:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-squircle-sm bg-canvas-2" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 sm:hidden">
      {suppliers.map((supplier) => (
        <GlassCard key={supplier.id} className="flex items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="truncate font-medium text-text-primary">{supplier.name}</p>
            <p className="truncate text-[12px] text-text-secondary">{supplier.phone_number || 'No phone'}</p>
          </div>
          <RowActions onEdit={() => onEdit(supplier)} onDelete={() => onDelete(supplier)} />
        </GlassCard>
      ))}
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
