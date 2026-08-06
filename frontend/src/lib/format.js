export function parseMoney(value) {
  if (typeof value === 'number') return value
  if (!value) return 0
  return parseFloat(value.replace(/[^0-9.-]/g, '')) || 0
}

export function formatMoney(value, { compact = false } = {}) {
  const number = typeof value === 'number' ? value : parseMoney(value)
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(number)
}

export function formatDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Date(value).toLocaleDateString('en-US', options)
}

export function formatMonthLabel(year, month) {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
}

export function shortId(id) {
  return id.toString().slice(0, 8).toUpperCase()
}

/** e.g. invoiceFileName('2026-08-04T10:00:00Z', 'c7bd9f4a-...') -> "Invoice_2026-08-04_C7BD9F4A.pdf" */
export function invoiceFileName(placedAt, id) {
  const datePart = new Date(placedAt).toISOString().slice(0, 10)
  return `Invoice_${datePart}_${shortId(id)}.pdf`
}

/**
 * Line-items total: quantity * unit_multiplier * unit_price.
 * Agrees with the API's `total_price` field (inventory/models.py::LINE_TOTAL is the shared
 * definition on that side) — this stays because the tables already hold the items and can
 * total them without trusting a second field to be present on every payload shape.
 */
export function computeItemsTotal(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_multiplier * item.unit_price, 0)
}

export function formatLBP(usdAmount, exchangeRate, { compact = false } = {}) {
  const lbp = usdAmount * exchangeRate
  return `${new Intl.NumberFormat('en-US', {
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(lbp)} LBP`
}

export function formatPeriodLabel(period, granularity) {
  const date = new Date(`${period}T00:00:00Z`)
  if (granularity === 'year') {
    return date.toLocaleDateString('en-US', { year: 'numeric', timeZone: 'UTC' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10)
}

/** Fills gaps in a sparse {period,total_revenue,total_costs}[] series so charts don't show false drops to zero-width gaps. */
export function fillSeriesGaps(series, { start, end, stepDays }) {
  const byPeriod = new Map(series.map((row) => [row.period, row]))
  const filled = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)

  while (cursor <= endDate) {
    const key = toDateKey(cursor)
    const row = byPeriod.get(key)
    filled.push({
      period: key,
      total_revenue: row?.total_revenue ?? 0,
      total_costs: row?.total_costs ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + stepDays)
  }

  return filled
}
