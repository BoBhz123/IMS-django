/**
 * Settlement arithmetic and wire format for the payment controls on the order and purchase forms.
 *
 * Pure, and kept out of React so the three-state logic can be tested without rendering a form.
 *
 * The rule the server enforces, mirrored here only as far as it has to be: `paid_amount` is the
 * source of truth and `payment_status` is derived from it (inventory/serializers.py::_settle_payment).
 * This module therefore never computes a status — it reports what the user picked, and builds the
 * smallest payload that lets the server do the deriving.
 */

export const PAYMENT_STATUS = {
  PAID: 'PAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  UNPAID: 'UNPAID',
}

export const PAYMENT_OPTIONS = [
  { value: PAYMENT_STATUS.PAID, label: 'Fully paid' },
  { value: PAYMENT_STATUS.PARTIALLY_PAID, label: 'Partially paid' },
  { value: PAYMENT_STATUS.UNPAID, label: 'Unpaid' },
]

function toNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** How much of `total` this settlement covers. */
export function paidFor(total, status, paidAmount) {
  if (status === PAYMENT_STATUS.PAID) return toNumber(total)
  if (status === PAYMENT_STATUS.UNPAID) return 0
  return toNumber(paidAmount)
}

/**
 * What is still owed.
 *
 * Clamped at zero to match `PaymentTrackedTransaction.remaining_amount` on the server. Rounding a
 * cash settlement up is routine here, and a negative remainder would render on the invoice as a
 * refund the business does not owe.
 */
export function remainingFor(total, status, paidAmount) {
  return Math.max(0, toNumber(total) - paidFor(total, status, paidAmount))
}

/**
 * True when the form cannot be submitted as it stands.
 *
 * Only one state can be invalid: PARTIALLY_PAID needs an amount. The server refuses it without
 * one — "partly paid" has no defensible default — so checking here just keeps the message next to
 * the field instead of arriving as a 400 after a round trip.
 */
export function partialAmountMissing(status, paidAmount) {
  if (status !== PAYMENT_STATUS.PARTIALLY_PAID) return false
  if (paidAmount === '' || paidAmount === null || paidAmount === undefined) return true
  const parsed = Number(paidAmount)
  return !Number.isFinite(parsed) || parsed <= 0
}

/**
 * The payment half of a create/update payload.
 *
 * PAID and UNPAID send the status alone and let the server settle them against the total it
 * computed from the line rows it just wrote. Sending a browser-computed `paid_amount` for those
 * would let a stale total in the form overwrite the real one — which is the same class of bug as
 * writing `payment_status` directly.
 */
export function paymentPayload(status, paidAmount) {
  if (status === PAYMENT_STATUS.PARTIALLY_PAID) {
    return { payment_status: status, paid_amount: toNumber(paidAmount) }
  }
  return { payment_status: status }
}
