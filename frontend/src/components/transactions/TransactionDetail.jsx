import { useMemo } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { useAllProducts } from '@/hooks/useAllProducts'
import { useCurrency } from '@/context/CurrencyContext'
import { SlideOver } from '@/components/ui/SlideOver'
import { GlassCard } from '@/components/ui/GlassCard'
import { ProductThumbnail } from '@/components/ui/ProductThumbnail'
import { formatDate, shortId } from '@/lib/format'

/**
 * Read-only drill-down for an order/purchase. Orders' items carry a product ID (`productKey="id"`);
 * purchases' items carry the product name directly (PurchaseItemSerializer.product is a StringRelatedField)
 * — either way we resolve against the full catalog (fetched here, only while open) to get the thumbnail.
 */
export function TransactionDetail({
  open,
  onClose,
  documentType,
  id,
  placedAt,
  exchangeRate,
  partyLabel,
  partyName,
  items,
  productKey,
}) {
  const { formatAmount } = useCurrency()
  const { products } = useAllProducts(open)

  const productMap = useMemo(() => {
    const map = new Map()
    products.forEach((product) => {
      map.set(productKey === 'name' ? product.name : String(product.id), product)
    })
    return map
  }, [products, productKey])

  const rows = items.map((item) => {
    const key = productKey === 'name' ? item.product : String(item.product)
    const product = productMap.get(key)
    return {
      name: product?.name ?? (productKey === 'name' ? item.product : `Product #${item.product}`),
      image: product?.images?.[0]?.image,
      quantity: item.quantity,
      unitMultiplier: item.unit_multiplier,
      unitPrice: item.unit_price,
    }
  })
  const total = rows.reduce((sum, row) => sum + row.quantity * row.unitMultiplier * row.unitPrice, 0)

  return (
    <SlideOver open={open} onClose={onClose} title={documentType}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-display text-[15px] font-semibold text-text-primary tabular-nums">#{shortId(id)}</p>
            <p className="text-[12px] text-text-secondary">{formatDate(placedAt)}</p>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-green/14 px-2 py-0.5 text-[12px] font-medium text-accent-green">
            <CheckCircle2 size={12} strokeWidth={2.5} />
            Completed
          </span>
        </div>

        <div className="rounded-xl border border-hairline p-3">
          <p className="text-[11px] tracking-wide text-text-tertiary uppercase">{partyLabel}</p>
          <p className="text-[14px] font-medium text-text-primary">
            {partyName ?? `No ${partyLabel.toLowerCase()}`}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-medium text-text-secondary">Items</span>
          {rows.map((row, index) => (
            <GlassCard key={index} className="flex items-center gap-3 p-3">
              <ProductThumbnail image={row.image} name={row.name} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-primary">{row.name}</p>
                <p className="text-[12px] text-text-secondary tabular-nums">
                  {row.quantity}
                  {row.unitMultiplier > 1 ? ` × ${row.unitMultiplier}` : ''} @{' '}
                  {formatAmount(row.unitPrice, exchangeRate)}
                </p>
              </div>
              <span className="shrink-0 text-[13px] font-medium text-text-primary tabular-nums">
                {formatAmount(row.quantity * row.unitMultiplier * row.unitPrice, exchangeRate)}
              </span>
            </GlassCard>
          ))}
        </div>

        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Total</span>
          <span className="font-semibold text-text-primary tabular-nums">{formatAmount(total, exchangeRate)}</span>
        </div>
      </div>
    </SlideOver>
  )
}
