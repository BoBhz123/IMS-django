import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Package,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react'
import axios from 'axios'
import { api } from '@/lib/api'
import { useCurrency } from '@/context/CurrencyContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { StockBadge } from '@/components/ui/StockBadge'
import { ProductForm } from '@/components/forms/ProductForm'
import { ExportButton } from '@/components/ui/ExportButton'

export function Products() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [supplier, setSupplier] = useState('all')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [sort, setSort] = useState({ field: 'name', direction: 'asc' })
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)

  const [lookups, setLookups] = useState({ categories: [], suppliers: [] })
  const [result, setResult] = useState({ count: 0, next: null, previous: null, results: [] })
  const [status, setStatus] = useState('loading')
  const [editingProduct, setEditingProduct] = useState(null)
  const [formOpen, setFormOpen] = useState(false)

  // debounce the free-text search, then jump back to page 1
  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 350)
    return () => clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/inventory/categories/', { signal: controller.signal })
      .then(({ data }) => setLookups((prev) => ({ ...prev, categories: data })))
      .catch(() => {})
    api
      .get('/inventory/suppliers/', { signal: controller.signal })
      .then(({ data }) => setLookups((prev) => ({ ...prev, suppliers: data })))
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')

    const params = { page, ordering: sort.direction === 'desc' ? `-${sort.field}` : sort.field }
    if (search) params.search = search
    if (category !== 'all') params.category_id = category
    if (supplier !== 'all') params.supplier_id = supplier
    if (minPrice) params.default_sell_price__gt = minPrice
    if (maxPrice) params.default_sell_price__lt = maxPrice

    api
      .get('/inventory/products/', { params, signal: controller.signal })
      .then(({ data }) => {
        setResult(data)
        setStatus('ready')
      })
      .catch((error) => {
        if (!axios.isCancel(error)) setStatus('error')
      })

    return () => {
      controller.abort()
    }
  }, [search, category, supplier, minPrice, maxPrice, sort, page, refreshKey])

  const categoryMap = new Map(lookups.categories.map((c) => [c.id, c.name]))
  const supplierMap = new Map(lookups.suppliers.map((s) => [s.id, s.name]))

  function toggleSort(field) {
    setPage(1)
    setSort((current) =>
      current.field === field
        ? { field, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { field, direction: 'asc' },
    )
  }

  function updateFilter(setter) {
    return (value) => {
      setter(value)
      setPage(1)
    }
  }

  const hasFilters = search || category !== 'all' || supplier !== 'all' || minPrice || maxPrice

  function clearFilters() {
    setSearchInput('')
    setSearch('')
    setCategory('all')
    setSupplier('all')
    setMinPrice('')
    setMaxPrice('')
    setPage(1)
  }

  const pageSize = 10
  const from = result.count === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, result.count)

  function openAdd() {
    setEditingProduct(null)
    setFormOpen(true)
  }

  function openEdit(product) {
    setEditingProduct(product)
    setFormOpen(true)
  }

  const exportParams = {}
  if (search) exportParams.search = search
  if (category !== 'all') exportParams.category_id = category
  if (supplier !== 'all') exportParams.supplier_id = supplier
  if (minPrice) exportParams.default_sell_price__gt = minPrice
  if (maxPrice) exportParams.default_sell_price__lt = maxPrice

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <FilterBar
            searchInput={searchInput}
            onSearchChange={setSearchInput}
            category={category}
            onCategoryChange={updateFilter(setCategory)}
            supplier={supplier}
            onSupplierChange={updateFilter(setSupplier)}
            minPrice={minPrice}
            onMinPriceChange={updateFilter(setMinPrice)}
            maxPrice={maxPrice}
            onMaxPriceChange={updateFilter(setMaxPrice)}
            categories={lookups.categories}
            suppliers={lookups.suppliers}
            hasFilters={hasFilters}
            onClear={clearFilters}
          />
        </div>
        <ExportButton url="/inventory/products/export/csv/" params={exportParams} filename="products.csv" />
        <button
          type="button"
          onClick={openAdd}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={14} />
          Add product
        </button>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn't load products. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <ProductTable
            products={result.results}
            categoryMap={categoryMap}
            supplierMap={supplierMap}
            sort={sort}
            onSort={toggleSort}
            loading={status === 'loading'}
            onEdit={openEdit}
          />
          <ProductCards
            products={result.results}
            categoryMap={categoryMap}
            supplierMap={supplierMap}
            loading={status === 'loading'}
            onEdit={openEdit}
          />

          {status === 'ready' && result.results.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Package className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">No products match your filters.</p>
            </div>
          )}

          <div className="flex items-center justify-between px-1 text-[13px] text-text-secondary">
            <span className="tabular-nums">
              {result.count > 0 ? `Showing ${from}–${to} of ${result.count}` : ''}
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
        </>
      )}

      <ProductForm
        key={editingProduct?.id ?? 'new'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        product={editingProduct}
        categories={lookups.categories}
        suppliers={lookups.suppliers}
      />
    </div>
  )
}

function FilterBar({
  searchInput,
  onSearchChange,
  category,
  onCategoryChange,
  supplier,
  onSupplierChange,
  minPrice,
  onMinPriceChange,
  maxPrice,
  onMaxPriceChange,
  categories,
  suppliers,
  hasFilters,
  onClear,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2">
        <Search size={15} className="shrink-0 text-text-tertiary" />
        <input
          type="text"
          value={searchInput}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search products…"
          className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
      </div>

      <FilterSelect value={category} onChange={onCategoryChange} label="All categories">
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </FilterSelect>

      <FilterSelect value={supplier} onChange={onSupplierChange} label="All suppliers">
        {suppliers.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </FilterSelect>

      <div className="flex items-center gap-1.5">
        <PriceInput value={minPrice} onChange={onMinPriceChange} placeholder="Min $" />
        <span className="text-text-tertiary">–</span>
        <PriceInput value={maxPrice} onChange={onMaxPriceChange} placeholder="Max $" />
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 rounded-xl px-2.5 py-2 text-[13px] font-medium text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
        >
          <X size={14} />
          Clear
        </button>
      )}
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

function PriceInput({ value, onChange, placeholder }) {
  return (
    <input
      type="number"
      min="0"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-20 rounded-xl border border-hairline bg-canvas-2 px-2.5 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
    />
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

function Thumbnail({ product }) {
  const image = product.images[0]?.image
  if (image) {
    return (
      <img
        src={image}
        alt={product.name}
        className="h-10 w-10 shrink-0 rounded-xl border border-hairline object-cover"
        loading="lazy"
      />
    )
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-hairline bg-canvas-2 text-text-tertiary">
      <Package size={16} />
    </div>
  )
}

function ProductTable({ products, categoryMap, supplierMap, sort, onSort, loading, onEdit }) {
  const { formatAmount } = useCurrency()

  return (
    <GlassCard className="hidden overflow-hidden sm:block">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3">
                <SortHeader field="name" label="Product" sort={sort} onSort={onSort} />
              </th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Supplier</th>
              <th className="px-4 py-3 font-medium">Stock</th>
              <th className="px-4 py-3 text-right font-medium">Cost</th>
              <th className="px-4 py-3 text-right">
                <div className="flex justify-end">
                  <SortHeader field="default_sell_price" label="Price" sort={sort} onSort={onSort} />
                </div>
              </th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
              : products.map((product) => (
                  <tr key={product.id} className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-3">
                        <Thumbnail product={product} />
                        <span className="font-medium text-text-primary">{product.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {categoryMap.get(product.category) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {supplierMap.get(product.supplier) ?? 'No supplier'}
                    </td>
                    <td className="px-4 py-2.5">
                      <StockBadge quantity={product.stock_quantity} />
                    </td>
                    <td className="px-4 py-2.5 text-right text-text-secondary tabular-nums">
                      {formatAmount(product.cost_price)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-text-primary tabular-nums">
                      {formatAmount(product.default_sell_price)}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => onEdit(product)}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-blue hover:bg-accent-blue/10"
                      >
                        <Pencil size={12} />
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}

function SkeletonRow() {
  return (
    <tr className="border-b border-hairline/60 last:border-0">
      <td className="px-5 py-2.5" colSpan={7}>
        <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
      </td>
    </tr>
  )
}

function ProductCards({ products, categoryMap, supplierMap, loading, onEdit }) {
  const { formatAmount } = useCurrency()

  if (loading) {
    return (
      <div className="flex flex-col gap-2 sm:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-squircle-sm bg-canvas-2" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 sm:hidden">
      {products.map((product) => (
        <GlassCard
          key={product.id}
          as="button"
          onClick={() => onEdit(product)}
          className="flex items-center gap-3 p-3 text-left"
        >
          <Thumbnail product={product} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-text-primary">{product.name}</p>
            <p className="truncate text-[12px] text-text-secondary">
              {categoryMap.get(product.category) ?? '—'} · {supplierMap.get(product.supplier) ?? 'No supplier'}
            </p>
            <div className="mt-1">
              <StockBadge quantity={product.stock_quantity} />
            </div>
          </div>
          <span className="shrink-0 font-medium text-text-primary tabular-nums">
            {formatAmount(product.default_sell_price)}
          </span>
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
