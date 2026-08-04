import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'

const LOW_STOCK_THRESHOLD = 10

export function StockBadge({ quantity }) {
  if (quantity <= 0) {
    return (
      <Badge icon={XCircle} color="var(--accent-red)">
        Out of stock
      </Badge>
    )
  }
  if (quantity < LOW_STOCK_THRESHOLD) {
    return (
      <Badge icon={AlertTriangle} color="var(--accent-orange)">
        {quantity} left — low
      </Badge>
    )
  }
  return (
    <Badge icon={CheckCircle2} color="var(--accent-green)">
      {quantity} in stock
    </Badge>
  )
}

function Badge({ icon: Icon, color, children }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums"
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }}
    >
      <Icon size={12} strokeWidth={2.5} />
      {children}
    </span>
  )
}
