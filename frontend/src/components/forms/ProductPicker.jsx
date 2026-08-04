import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ProductThumbnail } from '@/components/ui/ProductThumbnail'

/** Native <select> can't render option thumbnails across browsers, so this is a small custom listbox instead. */
export function ProductPicker({ products, value, onChange }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const selected = products.find((p) => String(p.id) === String(value))

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

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-left text-[13px] text-text-primary focus:outline-none"
      >
        <ProductThumbnail image={selected?.images?.[0]?.image} name={selected?.name} size="xs" />
        <span className={`min-w-0 flex-1 truncate ${selected ? 'text-text-primary' : 'text-text-tertiary'}`}>
          {selected ? selected.name : 'Select product'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-glass-border bg-glass-strong p-1 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
          {products.length === 0 && (
            <p className="px-2 py-3 text-center text-[12px] text-text-secondary">No products.</p>
          )}
          {products.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onChange(String(product.id))
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-canvas-2 ${
                String(product.id) === String(value) ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary'
              }`}
            >
              <ProductThumbnail image={product.images?.[0]?.image} name={product.name} size="xs" />
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
