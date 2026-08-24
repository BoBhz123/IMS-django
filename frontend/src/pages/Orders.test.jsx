import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { resetOverlayStack } from '@/lib/overlayStack'
import { Orders } from './Orders'

const get = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}))

const ORDERS = [
  {
    id: 'aaaa1111-0000-0000-0000-000000000001',
    customer: 'Layal',
    placed_at: '2026-08-01T10:00:00Z',
    exchange_rate: 89000,
    payment_status: 'PAID',
    paid_amount: '50.00',
    remaining_amount: '0.00',
    items: [{ product: 1, quantity: 5, unit_price: '10.00' }],
  },
  {
    id: 'bbbb2222-0000-0000-0000-000000000002',
    customer: 'Rami',
    placed_at: '2026-08-02T10:00:00Z',
    exchange_rate: 89000,
    payment_status: 'PARTIALLY_PAID',
    paid_amount: '32.00',
    remaining_amount: '48.00',
    items: [{ product: 1, quantity: 8, unit_price: '10.00' }],
  },
  {
    id: 'cccc3333-0000-0000-0000-000000000003',
    customer: 'Nour',
    placed_at: '2026-08-03T10:00:00Z',
    exchange_rate: 89000,
    payment_status: 'UNPAID',
    paid_amount: '0.00',
    remaining_amount: '20.00',
    items: [{ product: 1, quantity: 2, unit_price: '10.00' }],
  },
]

function renderOrders() {
  render(
    <CurrencyProvider>
      <Orders />
    </CurrencyProvider>,
  )
}

/**
 * Every row is rendered twice — once in the table (`hidden sm:block`) and once as a card
 * (`sm:hidden`). Both are in the DOM under jsdom, which has no viewport to resolve the
 * breakpoint, so every row query has to be a *All variant.
 */
const rows = (text) => screen.findAllByText(text)

/** The most recent /inventory/orders/ request's query params. */
function lastOrdersParams() {
  const call = [...get.mock.calls].reverse().find(([url]) => url === '/inventory/orders/')
  return call?.[1]?.params
}

describe('Orders', () => {
  beforeEach(() => {
    resetOverlayStack()
    get.mockReset()
    get.mockImplementation((url) => {
      if (url === '/inventory/customers/') {
        return Promise.resolve({ data: [{ id: 8, name: 'Layal' }, { id: 7, name: 'Rami' }] })
      }
      return Promise.resolve({
        data: { count: ORDERS.length, next: null, previous: null, results: ORDERS },
      })
    })
  })

  it('keeps the filter controls behind one button', async () => {
    renderOrders()
    await rows('Layal')

    // The header used to carry three bare selects competing with the primary action.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show filters/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add order/i })).toBeInTheDocument()
  })

  it('opens the filters on demand', async () => {
    const user = userEvent.setup()
    renderOrders()
    await rows('Layal')

    await user.click(screen.getByRole('button', { name: /show filters/i }))

    expect(await screen.findByLabelText('Customer')).toBeInTheDocument()
    expect(screen.getByLabelText('Payment')).toBeInTheDocument()
    expect(screen.getByLabelText('Year')).toBeInTheDocument()
    expect(screen.getByLabelText('Month')).toBeInTheDocument()
  })

  it('queries the server when a payment status is chosen', async () => {
    const user = userEvent.setup()
    renderOrders()
    await rows('Layal')

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    await user.selectOptions(await screen.findByLabelText('Payment'), 'UNPAID')

    await waitFor(() => expect(lastOrdersParams()?.payment_status).toBe('UNPAID'))
  })

  it('counts the active filters on the trigger', async () => {
    const user = userEvent.setup()
    renderOrders()
    await rows('Layal')

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    await user.selectOptions(await screen.findByLabelText('Payment'), 'UNPAID')
    await user.selectOptions(screen.getByLabelText('Customer'), '8')

    // Without the count an empty result set looks like missing data rather than a filter.
    expect(
      await screen.findByRole('button', { name: /show filters \(2 active\)/i }),
    ).toBeInTheDocument()
  })

  it('clears every filter at once', async () => {
    const user = userEvent.setup()
    renderOrders()
    await rows('Layal')

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    await user.selectOptions(await screen.findByLabelText('Payment'), 'PAID')
    await waitFor(() => expect(lastOrdersParams()?.payment_status).toBe('PAID'))

    await user.click(screen.getByRole('button', { name: /clear all/i }))

    await waitFor(() => expect(lastOrdersParams()?.payment_status).toBeUndefined())
  })

  it('badges each order with how it was settled', async () => {
    renderOrders()

    // Two of each: the table row and the mobile card.
    expect(await rows('PAID')).toHaveLength(2)
    expect(screen.getAllByText('UNPAID')).toHaveLength(2)
    // The figure is what makes the badge actionable in a list.
    expect(screen.getAllByText('Partial ($48.00 due)')).toHaveLength(2)
  })
})
