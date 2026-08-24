import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { resetOverlayStack } from '@/lib/overlayStack'
import { Purchases } from './Purchases'

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

const PURCHASES = [
  {
    id: 'dddd4444-0000-0000-0000-000000000001',
    supplier: 'Acme',
    placed_at: '2026-08-01T10:00:00Z',
    exchange_rate: 89000,
    payment_status: 'PAID',
    paid_amount: '40.00',
    remaining_amount: '0.00',
    items: [{ product: 'Widget', quantity: 10, unit_price: '4.00' }],
  },
  {
    id: 'eeee5555-0000-0000-0000-000000000002',
    supplier: 'Other Co',
    placed_at: '2026-08-02T10:00:00Z',
    exchange_rate: 89000,
    payment_status: 'PARTIALLY_PAID',
    paid_amount: '10.00',
    remaining_amount: '30.00',
    items: [{ product: 'Widget', quantity: 10, unit_price: '4.00' }],
  },
]

/** See Orders.test.jsx — the table and the mobile cards both render under jsdom. */
const rows = (text) => screen.findAllByText(text)

function lastPurchasesParams() {
  const call = [...get.mock.calls].reverse().find(([url]) => url === '/inventory/purchases/')
  return call?.[1]?.params
}

describe('Purchases', () => {
  beforeEach(() => {
    resetOverlayStack()
    get.mockReset()
    get.mockImplementation((url) => {
      if (url === '/inventory/suppliers/') {
        return Promise.resolve({ data: [{ id: 3, name: 'Acme' }, { id: 4, name: 'Other Co' }] })
      }
      return Promise.resolve({
        data: { count: PURCHASES.length, next: null, previous: null, results: PURCHASES },
      })
    })
  })

  it('keeps the filter controls behind one button', async () => {
    render(<CurrencyProvider><Purchases /></CurrencyProvider>)
    await rows('Acme')

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show filters/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add purchase/i })).toBeInTheDocument()
  })

  it('queries the server when a payment status is chosen', async () => {
    const user = userEvent.setup()
    render(<CurrencyProvider><Purchases /></CurrencyProvider>)
    await rows('Acme')

    await user.click(screen.getByRole('button', { name: /show filters/i }))
    await user.selectOptions(await screen.findByLabelText('Payment'), 'PARTIALLY_PAID')

    await waitFor(() => expect(lastPurchasesParams()?.payment_status).toBe('PARTIALLY_PAID'))
  })

  it('badges each purchase with how it was settled', async () => {
    render(<CurrencyProvider><Purchases /></CurrencyProvider>)

    expect(await rows('PAID')).toHaveLength(2)
    expect(screen.getAllByText('Partial ($30.00 due)')).toHaveLength(2)
  })
})
