/*
 * Intl formatters are built once per distinct option set and reused.
 *
 * Constructing an `Intl.NumberFormat` is roughly 20µs; calling `.format` on an existing one
 * is roughly 0.4µs — measured at ~54x on this project's Node version, and the same
 * asymmetry exists in browsers because the cost is in resolving the locale, not in
 * formatting the number. Every function in this file used to build a fresh formatter per
 * call, and `toLocaleDateString` does exactly the same thing internally.
 *
 * It adds up where the app is most interactive: a list page renders ten rows twice (a table
 * and a card stack — see the Working Log), each row carrying several money figures, and the
 * dashboard formats about thirty. That put hundreds of locale resolutions on every
 * keystroke of a debounced search.
 *
 * The caches are keyed by the option object and so are bounded by the number of distinct
 * shapes in the source, not by anything a user can influence — there are under a dozen.
 */
const numberFormatters = new Map()
const dateFormatters = new Map()

function numberFormatter(options) {
  const key = JSON.stringify(options)
  let formatter = numberFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', options)
    numberFormatters.set(key, formatter)
  }
  return formatter
}

function dateFormatter(options) {
  const key = JSON.stringify(options)
  let formatter = dateFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', options)
    dateFormatters.set(key, formatter)
  }
  return formatter
}

export function parseMoney(value) {
  if (typeof value === 'number') return value
  if (!value) return 0
  return parseFloat(value.replace(/[^0-9.-]/g, '')) || 0
}

export function formatMoney(value, { compact = false } = {}) {
  const number = typeof value === 'number' ? value : parseMoney(value)
  return numberFormatter({
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? 'compact' : 'standard',
  }).format(number)
}

export function formatDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  return dateFormatter(options).format(new Date(value))
}

export function formatMonthLabel(year, month) {
  return dateFormatter({
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)))
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
 * Line-items total: quantity * unit_price.
 * Agrees with the API's `total_price` field (inventory/models.py::LINE_TOTAL is the shared
 * definition on that side) — this stays because the tables already hold the items and can
 * total them without trusting a second field to be present on every payload shape.
 */
export function computeItemsTotal(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
}

/**
 * A USD amount rendered as Lebanese pounds.
 *
 * LBP is never written with decimals — there is no subunit in practical circulation, and a
 * figure like "1,112,500.00 LBP" reads as a mistake. The value is rounded to a whole number
 * *before* formatting, not merely displayed without its decimals, so the string and the number
 * a reader would add up agree. Thousands separators come from Intl.
 *
 * `compact` keeps one decimal on purpose — that path is for chart axes and stat tiles, where
 * "1.5M LBP" is an abbreviation of the magnitude rather than a fractional pound amount, and
 * forcing it to zero digits would collapse 1.5M and 2.4M both to "2M".
 */
export function formatLBP(usdAmount, exchangeRate, { compact = false } = {}) {
  const lbp = Math.round((typeof usdAmount === 'number' ? usdAmount : parseMoney(usdAmount)) * exchangeRate)
  return `${numberFormatter({
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(lbp)} LBP`
}

export function formatPeriodLabel(period, granularity) {
  const date = new Date(`${period}T00:00:00Z`)
  if (granularity === 'year') {
    return dateFormatter({ year: 'numeric', timeZone: 'UTC' }).format(date)
  }
  return dateFormatter({ month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
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
    // Every key is named explicitly, so a field added to the analytics series and not added
    // here is silently dropped — and renders as a plausible flat-zero sparkline rather than
    // an error.
    filled.push({
      period: key,
      total_revenue: row?.total_revenue ?? 0,
      total_costs: row?.total_costs ?? 0,
      total_expenses: row?.total_expenses ?? 0,
      total_cogs: row?.total_cogs ?? 0,
      gross_profit: row?.gross_profit ?? 0,
      // ?? rather than ||: a real -80 must survive, and 0 is a legitimate value here.
      net_profit: row?.net_profit ?? 0,
      // The cash half. A gap here means no transaction was placed in that bucket, so nothing
      // was collected or owed against it — zero is the true value, not a missing one.
      revenue_collected: row?.revenue_collected ?? 0,
      revenue_outstanding: row?.revenue_outstanding ?? 0,
      outlays_paid: row?.outlays_paid ?? 0,
      net_cash_flow: row?.net_cash_flow ?? 0,
    })
    cursor.setUTCDate(cursor.getUTCDate() + stepDays)
  }

  return filled
}
