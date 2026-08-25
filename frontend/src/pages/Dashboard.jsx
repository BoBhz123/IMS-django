import { memo, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'
import {
  computeItemsTotal,
  fillSeriesGaps,
  formatDate,
  formatPeriodLabel,
  shortId,
} from '@/lib/format'
import { useCurrency } from '@/context/CurrencyContext'
import { HeroStatTile, StatFootnote } from '@/components/ui/HeroStatTile'
import { MetricGroup } from '@/components/ui/MetricGroup'
import { GlassCard } from '@/components/ui/GlassCard'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { DashboardCarousel } from '@/components/charts/DashboardCarousel'
import { TopProductsChart } from '@/components/charts/TopProductsChart'

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function addUTCDays(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

/** Monday-aligned so client-side gap-filling lines up with Django's TruncWeek (ISO week) buckets. */
function mondayOnOrBefore(date) {
  const result = new Date(date)
  const day = result.getUTCDay() || 7
  if (day !== 1) result.setUTCDate(result.getUTCDate() - (day - 1))
  return result
}

function toChartSeries(series, granularity) {
  return series.map((row) => ({
    label: formatPeriodLabel(row.period, granularity),
    revenue: row.total_revenue,
    // Purchases. The series deliberately keeps the total_costs key while the summary tile
    // renamed to inventory_outlays — here it sits nowhere near a COGS figure.
    cost: row.total_costs,
    expenses: row.total_expenses ?? 0,
    grossProfit: row.gross_profit ?? 0,
    netProfit: row.net_profit ?? 0,
    // Cash, as opposed to the accrued figures above. `revenue` is what was invoiced in the
    // period; `collected` is how much of it has actually been paid.
    collected: row.revenue_collected ?? 0,
    outstanding: row.revenue_outstanding ?? 0,
    netCashFlow: row.net_cash_flow ?? 0,
  }))
}

const PERIOD_OPTIONS = [
  { value: 'all_time', label: 'All time' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_year', label: 'Last year' },
]

const PERIOD_WINDOW_DAYS = { last_month: 30, last_year: 365 }

/** How many rows the "Recent orders" panel shows — and therefore how many we ask the API for. */
const RECENT_ORDERS_COUNT = 8

/**
 * Params for the selected stat-tile value plus a comparable prior window for the trend delta.
 * For last_month/last_year, "current" and "value" are the same query (the backend period filter);
 * all_time keeps the original this-month-vs-last-month comparison since it has no natural window.
 */
function periodQuery(period, now) {
  if (period in PERIOD_WINDOW_DAYS) {
    const days = PERIOD_WINDOW_DAYS[period]
    const currentStart = addUTCDays(now, -days)
    const previousEnd = addUTCDays(currentStart, -1)
    const previousStart = addUTCDays(previousEnd, -(days - 1))
    const params = { period }
    return {
      valueParams: params,
      currentParams: params,
      previousParams: { start_date: isoDate(previousStart), end_date: isoDate(previousEnd) },
      deltaLabel: period === 'last_month' ? 'vs. prior 30 days' : 'vs. prior 365 days',
    }
  }

  const thisMonth = { year: now.getFullYear(), month: now.getMonth() + 1 }
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonth = { year: lastMonthDate.getFullYear(), month: lastMonthDate.getMonth() + 1 }
  return {
    valueParams: {},
    currentParams: thisMonth,
    previousParams: lastMonth,
    deltaLabel: 'vs. last month',
  }
}

export function Dashboard() {
  const { formatAmount } = useCurrency()
  const [period, setPeriod] = useState('all_time')
  const [state, setState] = useState({ status: 'loading', data: null, error: null })
  const [statsState, setStatsState] = useState({ status: 'loading', data: null, error: null })

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller

    async function load() {
      try {
        const now = new Date()
        const today = isoDate(now)

        const weekStart = new Date(now)
        weekStart.setUTCDate(weekStart.getUTCDate() - 6)

        const threeMonthsStart = new Date(now)
        threeMonthsStart.setUTCDate(threeMonthsStart.getUTCDate() - 90)
        const alignedThreeMonthsStart = mondayOnOrBefore(threeMonthsStart)

        const [weekRes, threeMonthRes, yearRes, ordersRes] = await Promise.all([
          api.get('/inventory/analytics/', {
            params: { start_date: isoDate(weekStart), end_date: today, group_by: 'day' },
            signal,
          }),
          api.get('/inventory/analytics/', {
            params: { start_date: isoDate(alignedThreeMonthsStart), end_date: today, group_by: 'week' },
            signal,
          }),
          api.get('/inventory/analytics/', { params: { group_by: 'year' }, signal }),
          // Only the 8 rows the "Recent orders" panel renders. This previously fetched every
          // order the tenant had ever placed — with all nested line items — and threw away
          // everything past the first 8, which was the single slowest request on the page.
          api.get('/inventory/orders/', {
            params: { ordering: '-placed_at', page_size: RECENT_ORDERS_COUNT },
            signal,
          }),
        ])

        const weekSeries = fillSeriesGaps(weekRes.data.series, {
          start: isoDate(weekStart),
          end: today,
          stepDays: 1,
        })
        const threeMonthSeries = fillSeriesGaps(threeMonthRes.data.series, {
          start: isoDate(alignedThreeMonthsStart),
          end: today,
          stepDays: 7,
        })

        const carouselTabs = [
          { key: 'week', label: 'Last week', data: toChartSeries(weekSeries, 'day') },
          { key: 'quarter', label: 'Last 3 months', data: toChartSeries(threeMonthSeries, 'week') },
          { key: 'year', label: 'By year', data: toChartSeries(yearRes.data.series, 'year') },
        ]

        setState({
          status: 'ready',
          data: {
            carouselTabs,
            sparkline: toChartSeries(weekSeries, 'day'),
            recentOrders: ordersRes.data.results,
            // Comes back on the analytics payload now, so the catalog-size tile no longer
            // costs its own request to /products/ (a full serialized page, nested product
            // images and all, read for a single integer).
            productsCount: yearRes.data.products_count,
          },
          error: null,
        })
      } catch (error) {
        if (!axios.isCancel(error)) setState({ status: 'error', data: null, error })
      }
    }

    load()
    return () => {
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller

    async function loadStats() {
      setStatsState((prev) => ({ status: 'loading', data: prev.data, error: null }))
      try {
        const { valueParams, currentParams, previousParams, deltaLabel } = periodQuery(period, new Date())

        // For last_month/last_year, periodQuery returns the *same params object* for the
        // headline value and the "current" side of the trend delta — so firing both sent two
        // byte-identical analytics queries every time the period changed. Reusing the one
        // promise keeps the shape below unchanged while halving that work.
        const valuePromise = api.get('/inventory/analytics/', { params: valueParams, signal })
        const currentPromise =
          currentParams === valueParams
            ? valuePromise
            : api.get('/inventory/analytics/', { params: currentParams, signal })

        const [valueRes, currentRes, previousRes] = await Promise.all([
          valuePromise,
          currentPromise,
          api.get('/inventory/analytics/', { params: previousParams, signal }),
        ])

        setStatsState({
          status: 'ready',
          data: { value: valueRes.data, current: currentRes.data, previous: previousRes.data, deltaLabel },
          error: null,
        })
      } catch (error) {
        if (!axios.isCancel(error)) setStatsState({ status: 'error', data: null, error })
      }
    }

    loadStats()
    return () => {
      controller.abort()
    }
  }, [period])

  const stats = statsState.data
  const sparkline = state.data?.sparkline

  // Every derived figure on the page, in one memo.
  //
  // These are cheap individually and there are around thirty of them, each re-derived on any
  // render of this component — and this component re-renders on a currency toggle, a period
  // change, and every AuthContext update. The sparkline arrays matter most: a fresh array is a
  // new prop identity, which defeats the memo on every tile that receives one, so recomputing
  // them is what would make React.memo below decorative.
  const figures = useMemo(() => {
    // Analytics money arrives as raw numbers since Phase 3. It used to be pre-formatted as
    // "$1,234.00" and parsed straight back out here so the LBP toggle could reformat it.
    const money = (source, key) => (stats ? Number(stats[source][key] ?? 0) : 0)

    // Each delta compares the server's own figure for each window. The profit delta used to be
    // computed here as revenue − purchases, which was the cash-flow definition wearing the
    // profit label — the confusion this phase set out to remove.
    const delta = (key, goodWhenUp) =>
      percentDelta(money('current', key), money('previous', key), goodWhenUp)

    const revenue = money('value', 'total_revenue')
    const grossProfit = money('value', 'gross_profit')

    return {
      revenue,
      grossProfit,
      netProfit: money('value', 'net_profit'),
      expenses: money('value', 'total_expenses'),
      outlays: money('value', 'inventory_outlays'),
      collected: money('value', 'revenue_collected'),
      receivable: money('value', 'revenue_outstanding'),
      payable: money('value', 'outlays_outstanding'),
      netCashFlow: money('value', 'net_cash_flow'),
      // Margin, not profit: the same $500 profit is a different business at $1k of sales than
      // at $50k. Null rather than 0 when there is no revenue — 0% margin claims a fact about a
      // period in which nothing was sold, and the tile renders nothing instead.
      grossMargin: revenue > 0 ? (grossProfit / revenue) * 100 : null,
      deltas: {
        revenue: delta('total_revenue', true),
        netProfit: delta('net_profit', true),
        collected: delta('revenue_collected', true),
        netCashFlow: delta('net_cash_flow', true),
      },
      spark: {
        revenue: sparkline?.map((t) => t.revenue),
        netProfit: sparkline?.map((t) => t.netProfit),
        collected: sparkline?.map((t) => t.collected),
        netCashFlow: sparkline?.map((t) => t.netCashFlow),
      },
    }
  }, [stats, sparkline])

  if (state.status === 'loading') return <DashboardSkeleton />
  if (state.status === 'error') {
    return (
      <p className="py-16 text-center text-[13px] text-text-secondary">
        Couldn't load the dashboard. Check that the API is running and you're signed in with an
        account that has analytics access.
      </p>
    )
  }

  const { carouselTabs, recentOrders, productsCount } = state.data
  const deltaLabel = stats?.deltaLabel ?? 'vs. last month'
  const statsLoading = statsState.status === 'loading'

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[15px] font-semibold text-text-primary">Overview</h1>
        <div className="w-64">
          <SegmentedControl options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
        </div>
      </div>

      {/* The hero row: the four figures a shopkeeper opens the app to see. Did I sell, did I
          make money on it, has the money arrived, and am I up or down on cash. Everything
          else is context for one of these, and is grouped below rather than competing here. */}
      <div
        className={`grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-4 ${
          statsLoading ? 'opacity-60' : ''
        }`}
      >
        <HeroStatTile
          index={0}
          label="Total revenue"
          value={formatAmount(figures.revenue)}
          delta={figures.deltas.revenue}
          deltaLabel={deltaLabel}
          sparkline={figures.spark.revenue}
          accent="var(--accent-blue)"
          footnote={
            figures.receivable > 0 ? (
              // Invoiced revenue includes money that has not arrived, and that gap is the
              // single most useful caveat on this number. Carried as a badge on the tile
              // rather than as its own card, so the two are read together.
              <StatFootnote tone="warn">{formatAmount(figures.receivable)} owed to you</StatFootnote>
            ) : (
              <StatFootnote tone="good">All invoices settled</StatFootnote>
            )
          }
        />
        <HeroStatTile
          index={1}
          label="Net profit"
          value={formatAmount(figures.netProfit)}
          delta={figures.deltas.netProfit}
          deltaLabel={deltaLabel}
          sparkline={figures.spark.netProfit}
          accent="var(--accent-green)"
          footnote={
            figures.grossMargin !== null && (
              <StatFootnote>{figures.grossMargin.toFixed(1)}% gross margin</StatFootnote>
            )
          }
        />
        {/* The cash pair. These move when a payment is recorded; the accrual figures beside
            them deliberately do not, so a sale stays profitable while the customer owes. */}
        <HeroStatTile
          index={2}
          label="Collected"
          value={formatAmount(figures.collected)}
          delta={figures.deltas.collected}
          deltaLabel={deltaLabel}
          sparkline={figures.spark.collected}
          accent="var(--accent-teal)"
          footnote={<StatFootnote>Cash actually in</StatFootnote>}
        />
        <HeroStatTile
          index={3}
          label="Net cash flow"
          value={formatAmount(figures.netCashFlow)}
          delta={figures.deltas.netCashFlow}
          deltaLabel={deltaLabel}
          sparkline={figures.spark.netCashFlow}
          accent={figures.netCashFlow < 0 ? 'var(--accent-red)' : 'var(--accent-purple)'}
          footnote={<StatFootnote>In, less stock and expenses</StatFootnote>}
        />
      </div>

      {/* Secondary metrics, grouped by the question they answer rather than given a tile
          each. Quieter by construction — see MetricGroup. */}
      <div
        className={`grid grid-cols-1 gap-4 transition-opacity lg:grid-cols-2 ${
          statsLoading ? 'opacity-60' : ''
        }`}
      >
        <MetricGroup
          index={0}
          title="Working capital"
          hint="Unsettled both ways"
          items={[
            {
              label: 'Owed to you',
              value: formatAmount(figures.receivable),
              hint: 'Accounts receivable',
              tone: figures.receivable > 0 ? 'var(--accent-orange)' : undefined,
            },
            {
              label: 'Owed to suppliers',
              value: formatAmount(figures.payable),
              hint: 'Accounts payable',
              tone: figures.payable > 0 ? 'var(--accent-orange)' : undefined,
            },
          ]}
        />
        <MetricGroup
          index={1}
          title="Cost & outlays"
          hint="Stock spend sits outside profit"
          items={[
            {
              label: 'Inventory outlays',
              value: formatAmount(figures.outlays),
              hint: 'Cash flow, not a cost of sales',
            },
            {
              label: 'Operating expenses',
              value: formatAmount(figures.expenses),
              hint: 'Subtracted from gross profit',
            },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <GlassCard className="p-5 lg:col-span-3">
          <DashboardCarousel tabs={carouselTabs} />
        </GlassCard>

        <GlassCard className="p-5 lg:col-span-2">
          {/* Catalog size lives here rather than in a tile of its own. It is not a financial
              figure and never moved with the period selector, so sitting in the KPI grid it
              read as one more money number that happened to be stuck. Next to the products
              that actually sold, it is the denominator: five of how many. */}
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="font-display text-[14px] font-semibold text-text-primary">
              Top products
            </h2>
            <span className="text-[12px] text-text-tertiary">
              <span className="font-semibold text-text-secondary tabular-nums">
                {productsCount.toLocaleString()}
              </span>{' '}
              in catalog
            </span>
          </div>
          {stats?.value.top_products?.length ? (
            <TopProductsChart data={stats.value.top_products} />
          ) : (
            <p className="py-12 text-center text-[13px] text-text-secondary">No sales yet.</p>
          )}
        </GlassCard>
      </div>

      <GlassCard className="overflow-hidden">
        <h2 className="px-5 pt-5 font-display text-[14px] font-semibold text-text-primary">
          Recent orders
        </h2>
        <RecentOrdersTable orders={recentOrders} />
      </GlassCard>
    </div>
  )
}

function percentDelta(current, previous, goodWhenUp) {
  if (!previous) return null
  const percent = ((current - previous) / previous) * 100
  return { percent: Math.abs(percent), direction: percent >= 0 ? 'up' : 'down', goodWhenUp }
}

/**
 * memo'd: it renders eight rows of formatted money and is the most expensive thing on the
 * page after the charts, but `orders` only changes when the dashboard reloads — not when the
 * period selector moves, which re-renders everything above it.
 *
 * It reads useCurrency itself rather than taking formatAmount as a prop. A context consumer
 * re-renders on a context change whatever memo says, which is correct here (the toggle must
 * reformat these rows); taking the function as a prop would break the memo on every parent
 * render instead, which is not.
 */
const RecentOrdersTable = memo(function RecentOrdersTable({ orders }) {
  const { formatAmount } = useCurrency()

  if (!orders.length) {
    return <p className="px-5 py-10 text-center text-[13px] text-text-secondary">No orders yet.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="mt-3 w-full min-w-[560px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-hairline text-[12px] text-text-tertiary">
            <th className="px-5 py-2 font-medium">Order</th>
            <th className="px-5 py-2 font-medium">Customer</th>
            <th className="px-5 py-2 font-medium">Date</th>
            <th className="px-5 py-2 font-medium">Items</th>
            <th className="px-5 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60">
              <td className="px-5 py-2.5 font-medium text-text-primary tabular-nums">{shortId(order.id)}</td>
              <td className="px-5 py-2.5 text-text-secondary">{order.customer ?? 'No customer'}</td>
              <td className="px-5 py-2.5 text-text-secondary tabular-nums">{formatDate(order.placed_at)}</td>
              <td className="px-5 py-2.5 text-text-secondary tabular-nums">{order.items.length}</td>
              <td className="px-5 py-2.5 text-right font-medium text-text-primary tabular-nums">
                {formatAmount(computeItemsTotal(order.items), order.exchange_rate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-squircle bg-canvas-2" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-squircle bg-canvas-2" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="h-64 animate-pulse rounded-squircle bg-canvas-2 lg:col-span-3" />
        <div className="h-64 animate-pulse rounded-squircle bg-canvas-2 lg:col-span-2" />
      </div>
      <div className="h-48 animate-pulse rounded-squircle bg-canvas-2" />
    </div>
  )
}
