import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { Dashboard } from './Dashboard'

const get = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { get: (...args) => get(...args) },
}))

// recharts measures its container, and jsdom reports every box as 0x0 — ResponsiveContainer
// then renders nothing and logs a width/height warning. The charts are not what these tests
// are about; stubbing them keeps the output readable and the assertions about the figures.
vi.mock('@/components/charts/DashboardCarousel', () => ({
  DashboardCarousel: () => <div data-testid="carousel" />,
}))
vi.mock('@/components/charts/TopProductsChart', () => ({
  TopProductsChart: () => <div data-testid="top-products" />,
}))

/** The analytics summary, with every key the dashboard reads. */
function analytics(overrides = {}) {
  return {
    total_revenue: 1000,
    total_cogs: 400,
    gross_profit: 600,
    total_expenses: 100,
    net_profit: 500,
    inventory_outlays: 250,
    revenue_collected: 700,
    revenue_outstanding: 300,
    outlays_paid: 150,
    outlays_outstanding: 100,
    net_cash_flow: 450,
    top_products: [{ product__name: 'Widget', total_sold: 12 }],
    products_count: 42,
    series: [],
    ...overrides,
  }
}

function mockAnalytics(summary) {
  get.mockImplementation((url) => {
    if (url === '/inventory/orders/') return Promise.resolve({ data: { results: [] } })
    return Promise.resolve({ data: summary })
  })
}

function renderDashboard() {
  return render(
    <CurrencyProvider>
      <Dashboard />
    </CurrencyProvider>,
  )
}

beforeEach(() => {
  get.mockReset()
})

describe('Dashboard hero KPIs', () => {
  it('leads with the four headline figures', async () => {
    mockAnalytics(analytics())
    renderDashboard()

    for (const label of ['Total revenue', 'Net profit', 'Collected', 'Net cash flow']) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
  })

  it('shows the outstanding balance as a badge on revenue, not as its own card', async () => {
    // Invoiced revenue includes money that has not arrived, and that gap is the most useful
    // caveat on the number. Read together or it is not read at all.
    mockAnalytics(analytics())
    renderDashboard()

    expect(await screen.findByText(/\$300\.00 owed to you/i)).toBeInTheDocument()
  })

  it('says so plainly when nothing is outstanding', async () => {
    mockAnalytics(analytics({ revenue_outstanding: 0 }))
    renderDashboard()

    expect(await screen.findByText(/all invoices settled/i)).toBeInTheDocument()
  })

  it('carries the gross margin under net profit', async () => {
    // 600 gross on 1000 revenue.
    mockAnalytics(analytics())
    renderDashboard()

    expect(await screen.findByText(/60\.0% gross margin/i)).toBeInTheDocument()
  })

  it('omits the margin rather than claiming 0% when nothing was sold', async () => {
    // 0% margin is a statement about a period in which there were no sales to have a margin
    // on. Dividing by zero revenue would print NaN%.
    mockAnalytics(analytics({ total_revenue: 0, gross_profit: 0, net_profit: -100 }))
    renderDashboard()

    await screen.findByText('Net profit')
    expect(screen.queryByText(/gross margin/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })
})

describe('Dashboard secondary widgets', () => {
  it('groups receivable and payable under working capital', async () => {
    mockAnalytics(analytics())
    renderDashboard()

    const widget = (await screen.findByText('Working capital')).closest('div[class*="rounded"]')
    expect(within(widget).getByText('Owed to you')).toBeInTheDocument()
    expect(within(widget).getByText('Owed to suppliers')).toBeInTheDocument()
    expect(within(widget).getByText('$100.00')).toBeInTheDocument()
  })

  it('groups outlays and expenses under cost & outlays', async () => {
    mockAnalytics(analytics())
    renderDashboard()

    const widget = (await screen.findByText('Cost & outlays')).closest('div[class*="rounded"]')
    expect(within(widget).getByText('Inventory outlays')).toBeInTheDocument()
    expect(within(widget).getByText('Operating expenses')).toBeInTheDocument()
    // Stock spend is cash flow, never a cost of what was sold — the hint says so on screen.
    expect(within(widget).getByText(/not a cost of sales/i)).toBeInTheDocument()
  })

  it('moves the catalog count beside the products that sold', async () => {
    // It never moved with the period selector, so in the KPI grid it read as a money figure
    // that was stuck. Next to top products it is the denominator.
    mockAnalytics(analytics())
    renderDashboard()

    const widget = (await screen.findByText('Top products')).closest('div[class*="rounded"]')
    expect(within(widget).getByText('42')).toBeInTheDocument()
    expect(within(widget).getByText(/in catalog/i)).toBeInTheDocument()
  })
})

describe('Dashboard reactivity to payment state', () => {
  it('reflects a settlement without any change to the accrual figures', async () => {
    // The contract the backend guarantees: recording a payment moves the cash figures and
    // leaves revenue and profit alone. If a future refactor wires a tile to the wrong key,
    // this is what catches it.
    mockAnalytics(analytics({ revenue_collected: 1000, revenue_outstanding: 0 }))
    const { unmount } = renderDashboard()

    expect(await screen.findByText(/all invoices settled/i)).toBeInTheDocument()
    expect(screen.getByText('$500.00')).toBeInTheDocument() // net profit, unchanged
    unmount()

    get.mockReset()
    mockAnalytics(analytics({ revenue_collected: 250, revenue_outstanding: 750 }))
    renderDashboard()

    expect(await screen.findByText(/\$750\.00 owed to you/i)).toBeInTheDocument()
    expect(screen.getByText('$500.00')).toBeInTheDocument() // still unchanged
  })
})

describe('Dashboard request handling', () => {
  it('aborts its in-flight requests on unmount', async () => {
    // Navigating away mid-load used to leave ten analytics requests running to completion.
    mockAnalytics(analytics())
    const { unmount } = renderDashboard()
    await screen.findByText('Total revenue')

    const signals = get.mock.calls.map(([, config]) => config?.signal).filter(Boolean)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)

    unmount()
    await waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true))
  })
})
