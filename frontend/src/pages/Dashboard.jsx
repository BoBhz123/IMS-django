import { useEffect, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'
import {
  computeItemsTotal,
  fillSeriesGaps,
  formatDate,
  formatPeriodLabel,
  parseMoney,
  shortId,
} from '@/lib/format'
import { useCurrency } from '@/context/CurrencyContext'
import { StatTile } from '@/components/ui/StatTile'
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
    cost: row.total_costs,
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

  if (state.status === 'loading') return <DashboardSkeleton />
  if (state.status === 'error') {
    return (
      <p className="py-16 text-center text-[13px] text-text-secondary">
        Couldn't load the dashboard. Check that the API is running and you're signed in with an
        account that has analytics access.
      </p>
    )
  }

  const { carouselTabs, sparkline, recentOrders, productsCount } = state.data
  const stats = statsState.data
  const periodRevenue = stats ? parseMoney(stats.value.total_revenue) : 0
  const periodCost = stats ? parseMoney(stats.value.total_costs) : 0
  const periodProfit = stats ? parseMoney(stats.value.net_profit) : 0
  const currentRevenue = stats ? parseMoney(stats.current.total_revenue) : 0
  const previousRevenue = stats ? parseMoney(stats.previous.total_revenue) : 0
  const currentCost = stats ? parseMoney(stats.current.total_costs) : 0
  const previousCost = stats ? parseMoney(stats.previous.total_costs) : 0
  const currentProfit = currentRevenue - currentCost
  const previousProfit = previousRevenue - previousCost
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

      <div
        className={`grid grid-cols-2 gap-4 lg:grid-cols-4 transition-opacity ${statsLoading ? 'opacity-60' : ''}`}
      >
        <StatTile
          index={0}
          label="Total revenue"
          value={formatAmount(periodRevenue)}
          delta={percentDelta(currentRevenue, previousRevenue, true)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.revenue)}
        />
        <StatTile
          index={1}
          label="Total costs"
          value={formatAmount(periodCost)}
          delta={percentDelta(currentCost, previousCost, false)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.cost)}
        />
        <StatTile
          index={2}
          label="Net profit"
          value={formatAmount(periodProfit)}
          delta={percentDelta(currentProfit, previousProfit, true)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.revenue - t.cost)}
        />
        <StatTile index={3} label="Products in catalog" value={productsCount.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <GlassCard className="p-5 lg:col-span-3">
          <DashboardCarousel tabs={carouselTabs} />
        </GlassCard>

        <GlassCard className="p-5 lg:col-span-2">
          <h2 className="mb-4 font-display text-[14px] font-semibold text-text-primary">
            Top products
          </h2>
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

function RecentOrdersTable({ orders }) {
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
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-squircle bg-canvas-2" />
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
