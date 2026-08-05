import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Search } from 'lucide-react'
import { ProductThumbnail } from '@/components/ui/ProductThumbnail'
import { useProductSearch } from '@/hooks/useProductSearch'

/** Native <select> can't render option thumbnails across browsers, so this is a small custom listbox instead. */
export function ProductPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState(null)
  const rootRef = useRef(null)
  const { products, status } = useProductSearch(query, open)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleSelect(product) {
    setSelectedProduct(product)
    onChange(String(product.id), product)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-left text-[13px] text-text-primary focus:outline-none"
      >
        <ProductThumbnail image={selectedProduct?.images?.[0]?.image} name={selectedProduct?.name} size="xs" />
        <span className={`min-w-0 flex-1 truncate ${selectedProduct ? 'text-text-primary' : 'text-text-tertiary'}`}>
          {selectedProduct ? selectedProduct.name : 'Select product'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-glass-border bg-glass-strong backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
          <div className="flex items-center gap-1.5 border-b border-hairline px-2 py-1.5">
            <Search size={13} className="shrink-0 text-text-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {status === 'loading' && (
              <div className="flex justify-center py-3">
                <Loader2 size={14} className="animate-spin text-text-tertiary" />
              </div>
            )}
            {status !== 'loading' && products.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-text-secondary">No products found.</p>
            )}
            {status !== 'loading' &&
              products.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => handleSelect(product)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-canvas-2 ${
                    String(product.id) === String(value) ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary'
                  }`}
                >
                  <ProductThumbnail image={product.images?.[0]?.image} name={product.name} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
