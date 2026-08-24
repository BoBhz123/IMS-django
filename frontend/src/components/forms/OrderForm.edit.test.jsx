import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { OrderForm } from './OrderForm'

// Widget has zero on the shelf: this order took the last 4. That is the whole point of these
// tests — an edit is judged against stock *plus* what it gives back.
const PRODUCTS = [
  { id: 1, name: 'Widget', default_sell_price: 10, stock_quantity: 0, images: [] },
  { id: 2, name: 'Gadget', default_sell_price: 8, stock_quantity: 6, images: [] },
]

const ORDER = {
  id: 'e3f1c2a4-0000-0000-0000-000000000001',
  customer: 'Layal',
  exchange_rate: 90000,
  placed_at: '2026-08-01T10:00:00Z',
  // The API always sends these; the fixture carries them so an edit is asserted to preserve the
  // settlement rather than silently resetting it.
  payment_status: 'PAID',
  paid_amount: '40.00',
  items: [{ product: 1, quantity: 4, unit_price: '10.00' }],
}

const CUSTOMERS = [{ id: 7, name: 'Rami' }, { id: 8, name: 'Layal' }]

vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: PRODUCTS, status: 'ready' }),
}))

vi.mock('@/hooks/useAllProducts', () => ({
  useAllProducts: () => ({ products: PRODUCTS, status: 'ready' }),
}))

const { api } = await import('@/lib/api')
vi.mock('@/lib/api', () => ({
  api: { post: vi.fn(), put: vi.fn(), get: vi.fn() },
}))

function renderEdit(order = ORDER, onSaved = () => {}) {
  render(
    <CurrencyProvider>
      <OrderForm
        open
        order={order}
        onClose={() => {}}
        onSaved={onSaved}
        customers={CUSTOMERS}
      />
    </CurrencyProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.put.mockResolvedValue({ data: {} })
})

describe('OrderForm in edit mode', () => {
  it('is titled for editing and offers to save rather than create', async () => {
    renderEdit()
    expect(await screen.findByText('Edit order')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create order/i })).not.toBeInTheDocument()
  })

  it('hydrates the saved lines, customer and exchange rate', async () => {
    renderEdit()
    // The picker only learns a name by being clicked, so seeing "Widget" proves the line was
    // hydrated with a selectedName and not just an id.
    expect(await screen.findByText('Widget')).toBeInTheDocument()
    expect(screen.getByDisplayValue('90000')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('8')
  })

  it('lets an unchanged order be saved even though its product is out of stock', async () => {
    // The regression this guards: judged against the bare stock_quantity of 0, every line of
    // this order reads as "over stock" and the form refuses to submit an edit that changes
    // no quantities at all.
    const user = userEvent.setup()
    renderEdit()

    const save = await screen.findByRole('button', { name: /save changes/i })
    expect(save).toBeEnabled()
    expect(screen.queryByText(/reduce quantities/i)).not.toBeInTheDocument()

    await user.click(save)
    await waitFor(() => expect(api.put).toHaveBeenCalled())
  })

  it('PUTs the whole order to its own URL', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    renderEdit(ORDER, onSaved)

    await user.click(await screen.findByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      `/inventory/orders/${ORDER.id}/`,
      {
        customer: '8',
        exchange_rate: 90000,
        // Status alone: the server settles PAID against the total it computes from the line
        // rows it just wrote, so no browser-side amount is sent. See lib/payment.js.
        payment_status: 'PAID',
        items: [{ product: 1, quantity: 4, unit_price: '10.00' }],
      },
    ))
    expect(api.post).not.toHaveBeenCalled()
    expect(onSaved).toHaveBeenCalled()
  })

  it('caps a quantity at stock plus what this order returns', async () => {
    // 0 on the shelf + 4 this order gives back = 4.
    renderEdit()
    const quantity = await screen.findByDisplayValue('4')
    expect(quantity).toHaveAttribute('max', '4')
  })

  it('warns that saving replaces every line', async () => {
    renderEdit()
    expect(await screen.findByText(/replaces every line/i)).toBeInTheDocument()
  })

  it('surfaces a server stock error against the edit', async () => {
    const user = userEvent.setup()
    api.put.mockRejectedValue({
      response: { status: 400, data: { items: ["Insufficient stock for 'Widget'."] } },
    })
    renderEdit()

    await user.click(await screen.findByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/insufficient stock for 'widget'/i)).toBeInTheDocument()
  })
})
