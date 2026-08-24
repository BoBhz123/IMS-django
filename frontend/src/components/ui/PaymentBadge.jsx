import { AlertCircle, CheckCircle2, CircleDashed } from 'lucide-react'
import { paymentLabel } from '@/lib/invoiceShare'

/**
 * Settlement state, colour-coded: green paid, orange part-paid, red unpaid.
 *
 * Colour is never the only signal — the label is spelled out beside it, and each state has a
 * distinct icon shape. Red/green alone is unreadable to the most common form of colour
 * blindness, and this badge is the one thing on the screen a user scans for.
 *
 * `remaining` + `formatAmount` are optional and only change a PARTIALLY_PAID badge, which reads
 * "Partial ($48.00 due)". The number is what makes the badge actionable in a list: "partially
 * paid" tells the user to open the row, "$48.00 due" tells them whether they need to. They are
 * injected rather than read from CurrencyContext so the badge stays usable from a print or PDF
 * path with no provider mounted — the same reason Invoice takes its currency settings as props.
 */
export function PaymentBadge({ status, remaining, formatAmount, className = '' }) {
  const variant = {
    PAID: {
      icon: CheckCircle2,
      classes: 'bg-accent-green/14 text-accent-green',
    },
    PARTIALLY_PAID: {
      icon: CircleDashed,
      classes: 'bg-accent-orange/14 text-accent-orange',
    },
    UNPAID: {
      icon: AlertCircle,
      classes: 'bg-accent-red/14 text-accent-red',
    },
  }[status] ?? { icon: AlertCircle, classes: 'bg-accent-red/14 text-accent-red' }

  const Icon = variant.icon

  // Only a partial payment carries a due figure. "Paid ($0.00 due)" is noise, and an unpaid
  // badge's balance is just the total, which the row already shows in its own column.
  const showsDue =
    status === 'PARTIALLY_PAID' && typeof formatAmount === 'function' && Number(remaining) > 0

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap ${variant.classes} ${className}`}
    >
      <Icon size={12} strokeWidth={2.5} />
      {showsDue ? `Partial (${formatAmount(Number(remaining))} due)` : paymentLabel(status)}
    </span>
  )
}
