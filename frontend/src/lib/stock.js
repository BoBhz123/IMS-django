/**
 * Stock arithmetic for the order form, kept separate from React so the one rule that is
 * easy to get wrong — duplicate lines for the same product share a single pool — is
 * unit-tested on its own.
 *
 * These mirror the server's rules in CreateOrderSerializer. They are a convenience gate,
 * not a guard: the server validates independently and is the authority.
 */

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Units one line consumes: quantity × multiplier, matching the server's deduction. */
export function lineUnits(item) {
  return toCount(item?.quantity) * toCount(item?.unit_multiplier)
}

/** Map of product id → units requested across every line, so duplicates aggregate. */
export function requestedByProduct(items) {
  const totals = new Map()
  for (const item of items) {
    if (!item?.product) continue
    const key = String(item.product)
    totals.set(key, (totals.get(key) || 0) + lineUnits(item))
  }
  return totals
}

/**
 * Stock state for one line, judged against everything else in the order.
 * status: 'none' (nothing picked) | 'out' (product has zero stock) |
 *         'over' (past the cap) | 'limit' (exactly at it) | 'ok'
 */
export function stockStateFor(items, index) {
  const item = items[index]
  if (!item?.product) {
    return { status: 'none', available: null, requested: 0, remaining: null }
  }

  const available = Number(item.stock_quantity)
  if (!Number.isFinite(available)) {
    return { status: 'none', available: null, requested: 0, remaining: null }
  }

  const requested = requestedByProduct(items).get(String(item.product)) || 0
  const remaining = available - requested

  let status = 'ok'
  if (available <= 0) status = 'out'
  else if (remaining < 0) status = 'over'
  else if (remaining === 0) status = 'limit'

  return { status, available, requested, remaining }
}

/** True when the order cannot legally be submitted as it stands. */
export function hasBlockingStockError(items) {
  return items.some((_, index) => ['over', 'out'].includes(stockStateFor(items, index).status))
}
