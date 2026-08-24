import { useState } from 'react'
import { Loader2, Plus, Search } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { ProductThumbnail } from '@/components/ui/ProductThumbnail'
import { useProductSearch } from '@/hooks/useProductSearch'

/**
 * Pick a product to add straight to an order or purchase.
 *
 * This is the one-step replacement for "Add row, then open the row's dropdown": the caller
 * opens this, a tap appends the product as a line, and the modal stays open so several items
 * can be added in a row — which is what a counter actually does.
 *
 * `disableOutOfStock` is the sales/receiving split. An order cannot sell what is not there, so
 * the option is disabled; a purchase is how stock arrives, so a zero-stock product is exactly
 * the one being bought.
 */
export function ProductSearchModal({
  open,
  onClose,
  onSelect,
  onCreateNew,
  disableOutOfStock = true,
  title = 'Add product',
}) {
  const [query, setQuery] = useState('')
  const { products, status } = useProductSearch(query, open)

  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <div className="flex flex-col gap-3 p-5">
        <h2 className="font-display text-[15px] font-semibold text-text-primary">{title}</h2>

        <div className="flex items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2">
          <Search size={15} className="shrink-0 text-text-tertiary" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search products…"
            aria-label="Search products"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>

        <div className="-mx-1 max-h-72 overflow-y-auto px-1">
          {status === 'loading' && (
            <div className="flex justify-center py-6">
              <Loader2 size={16} className="animate-spin text-text-tertiary" />
            </div>
          )}
          {status !== 'loading' && products.length === 0 && (
            <p className="py-6 text-center text-[13px] text-text-secondary">No products found.</p>
          )}
          {status !== 'loading' &&
            products.map((product) => {
              const soldOut = disableOutOfStock && product.stock_quantity <= 0
              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={soldOut}
                  // Stays open on purpose — adding three items should be three taps, not
                  // three round trips through the "Add product" button.
                  onClick={() => onSelect(product)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-[14px] enabled:hover:bg-canvas-2 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <ProductThumbnail image={product.images?.[0]?.image} name={product.name} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-text-primary">{product.name}</span>
                  <span
                    className={`shrink-0 text-[12px] tabular-nums ${
                      product.stock_quantity <= 0 ? 'text-accent-red' : 'text-text-tertiary'
                    }`}
                  >
                    {product.stock_quantity <= 0 ? 'Out of stock' : `${product.stock_quantity} left`}
                  </span>
                </button>
              )
            })}
        </div>

        {onCreateNew && (
          <button
            type="button"
            onClick={onCreateNew}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-hairline-strong px-3 py-2 text-[13px] font-medium text-accent-blue hover:bg-canvas-2"
          >
            <Plus size={15} />
            New product
          </button>
        )}
      </div>
    </Modal>
  )
}
