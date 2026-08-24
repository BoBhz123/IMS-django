import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { OrderForm } from './OrderForm'
import { PurchaseForm } from './PurchaseForm'

const WIDGET = {
  id: 1,
  name: 'Widget',
  cost_price: '6.00',
  default_sell_price: '10.00',
  stock_quantity: 5,
  images: [],
}

vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: [WIDGET], status: 'ready' }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

const noop = () => {}

function renderOrder(props = {}) {
  render(
    <CurrencyProvider>
      <OrderForm open onClose={noop} onSaved={noop} customers={[]} {...props} />
    </CurrencyProvider>,
  )
}

async function addWidget(user) {
  await user.click(screen.getByRole('button', { name: /^add product$/i }))
  await user.click(await screen.findByRole('button', { name: /Widget/i }))
}

describe('payment controls', () => {
  it('offers the three settlement states', () => {
    renderOrder()

    expect(screen.getByRole('button', { name: /fully paid/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /partially paid/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^unpaid$/i })).toBeInTheDocument()
  })

  it('hides the amount field unless the payment is partial', async () => {
    const user = userEvent.setup()
    renderOrder()

    expect(screen.queryByText(/amount paid/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /partially paid/i }))
    expect(await screen.findByText(/amount paid/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /fully paid/i }))
    await waitFor(() => expect(screen.queryByText(/amount paid/i)).not.toBeInTheDocument())
  })

  it('shows the remaining balance as the amount paid changes', async () => {
    const user = userEvent.setup()
    renderOrder()
    await addWidget(user)

    // One Widget at 10.00 → a 4.00 payment leaves 6.00 owing.
    await user.click(screen.getByRole('button', { name: /partially paid/i }))
    const amount = await screen.findByLabelText(/amount paid/i)
    await user.clear(amount)
    await user.type(amount, '4')

    expect(await screen.findByText(/remaining balance/i)).toBeInTheDocument()
    expect(screen.getByText('$6.00')).toBeInTheDocument()
  })

  it('refuses to submit a partial payment with no amount', async () => {
    const { api } = await import('@/lib/api')
    const user = userEvent.setup()
    renderOrder()
    await addWidget(user)

    await user.click(screen.getByRole('button', { name: /partially paid/i }))

    // The message sits beside the amount field and the submit button is disabled on the same
    // condition — the server refuses PARTIALLY_PAID with no amount, so this saves a round trip
    // that could only end in a 400.
    expect(await screen.findByText(/enter how much was paid/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create order/i })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /create order/i }))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('sends the status alone for a fully paid order', async () => {
    const { api } = await import('@/lib/api')
    api.post.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderOrder()
    await addWidget(user)

    await user.click(screen.getByRole('button', { name: /create order/i }))

    // No paid_amount: the server settles PAID against the total it computed from the rows it
    // just wrote, so a stale browser-side total can never overwrite the real one.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/inventory/orders/',
        expect.objectContaining({ payment_status: 'PAID' }),
      ),
    )
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('paid_amount')
  })

  it('sends the amount alongside the status for a partial payment', async () => {
    const { api } = await import('@/lib/api')
    api.post.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderOrder()
    await addWidget(user)

    await user.click(screen.getByRole('button', { name: /partially paid/i }))
    const amount = await screen.findByLabelText(/amount paid/i)
    await user.clear(amount)
    await user.type(amount, '4')
    await user.click(screen.getByRole('button', { name: /create order/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/inventory/orders/',
        expect.objectContaining({ payment_status: 'PARTIALLY_PAID', paid_amount: 4 }),
      ),
    )
  })

  it('sends UNPAID when the user says nothing was paid', async () => {
    const { api } = await import('@/lib/api')
    api.post.mockResolvedValue({ data: {} })
    const user = userEvent.setup()
    renderOrder()
    await addWidget(user)

    await user.click(screen.getByRole('button', { name: /^unpaid$/i }))
    await user.click(screen.getByRole('button', { name: /create order/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/inventory/orders/',
        expect.objectContaining({ payment_status: 'UNPAID' }),
      ),
    )
  })

  it('offers the same controls on a purchase', async () => {
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <PurchaseForm open onClose={noop} onSaved={noop} suppliers={[]} />
      </CurrencyProvider>,
    )

    await user.click(screen.getByRole('button', { name: /partially paid/i }))
    expect(await screen.findByText(/amount paid/i)).toBeInTheDocument()
  })
})
