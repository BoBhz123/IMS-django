import { CurrencyInput } from '@/components/ui/CurrencyInput'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { PAYMENT_OPTIONS, PAYMENT_STATUS, partialAmountMissing, remainingFor } from '@/lib/payment'

/**
 * How much of this transaction has been settled.
 *
 * Shared by the order and purchase forms — the settlement rules are identical on both sides of
 * the ledger, and a second copy would be the place they quietly diverge.
 *
 * The amount input and the balance line appear only for a partial payment. For the other two
 * states the amount is not merely implied, it is the server's to compute: `paid_amount` is the
 * source of truth and `payment_status` is derived from it, so the form sends the status alone
 * and lets the server settle it against the total it wrote. See lib/payment.js.
 */
export function PaymentSection({
  status,
  onStatusChange,
  paidAmount,
  onPaidAmountChange,
  total,
  exchangeRate,
  formatAmount,
  formatSecondary,
}) {
  const isPartial = status === PAYMENT_STATUS.PARTIALLY_PAID
  const remaining = remainingFor(total, status, paidAmount)
  const amountMissing = partialAmountMissing(status, paidAmount)

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] font-medium text-text-secondary">Payment</span>
      <SegmentedControl options={PAYMENT_OPTIONS} value={status} onChange={onStatusChange} />

      {isPartial && (
        <div className="flex flex-col gap-2 rounded-xl border border-hairline p-3">
          {/* A wrapping <label>, not a sibling <span>: CurrencyInput renders a bare <input> with
              no id of its own, and wrapping is the only association that works without one. */}
          <label className="block">
            <span className="mb-1 block text-[11px] text-text-tertiary">Amount paid</span>
            <CurrencyInput
              valueUsd={paidAmount}
              onChangeUsd={onPaidAmountChange}
              rate={exchangeRate}
            />
          </label>

          {amountMissing ? (
            // The server refuses PARTIALLY_PAID with no amount rather than guessing one. Saying
            // so here keeps the message beside the field instead of arriving as a 400.
            <p className="text-[12px] text-accent-red">
              Enter how much was paid, or choose Fully paid / Unpaid.
            </p>
          ) : (
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-text-secondary">Remaining balance</span>
              <span className="flex flex-col items-end">
                <span className="font-semibold text-accent-orange tabular-nums">
                  {formatAmount(remaining, exchangeRate)}
                </span>
                {formatSecondary?.(remaining, exchangeRate) && (
                  <span className="text-[11px] text-text-tertiary tabular-nums">
                    {formatSecondary(remaining, exchangeRate)}
                  </span>
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
