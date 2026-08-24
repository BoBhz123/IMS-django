import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { OrderForm } from './OrderForm'

// The picker fetches its options; pin them so the test drives known stock levels.
const PRODUCTS = [
  { id: 1, name: 'Widget', default_sell_price: 10, stock_quantity: 5, images: [] },
  { id: 2, name: 'Sold Out Thing', default_sell_price: 8, stock_quantity: 0, images: [] },
]

vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: PRODUCTS, status: 'ready' }),
}))

vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

function renderForm() {
  render(
    <CurrencyProvider>
      <OrderForm open onClose={() => {}} onSaved={() => {}} customers={[]} />
    </CurrencyProvider>,
  )
}

/**
 * The one and only way a line gets onto an order from the UI: open the picker, tap a product.
 * The picker closes on select, so each call reopens it.
 *
 * There is no longer a blank seeded row with its own "Select product" dropdown — that is what
 * the tests below used to drive.
 */
async function addProduct(user, name) {
  const opener = screen.queryByRole('button', { name: /^add product$/i })
  if (opener) await user.click(opener)
  await user.click(
    await screen.findByRole('button', { name: new RegExp(`${name}.*(left|out of stock)`, 'i') }),
  )
}

/** Open the picker without choosing anything. */
async function openPicker(user) {
  await user.click(screen.getByRole('button', { name: /^add product$/i }))
}

const submitButton = () => screen.getByRole('button', { name: /create order/i })

describe('OrderForm stock gating', () => {
  it('shows remaining stock once a product is picked', async () => {
    const user = userEvent.setup()
    renderForm()
    await addProduct(user, 'Widget')

    // 1 of 5 requested by default → 4 left.
    expect(screen.getByText(/4 left — low/i)).toBeInTheDocument()
  })

  it('flags the exact limit and still allows submitting', async () => {
    const user = userEvent.setup()
    renderForm()
    await addProduct(user, 'Widget')

    const qty = screen.getAllByRole('spinbutton')[1] // exchange rate is [0]
    await user.clear(qty)
    await user.type(qty, '5')

    expect(screen.getByText(/reached limit/i)).toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
  })

  it('blocks submission once the order exceeds stock', async () => {
    const user = userEvent.setup()
    renderForm()
    await addProduct(user, 'Widget')

    const qty = screen.getAllByRole('spinbutton')[1]
    await user.clear(qty)
    await user.type(qty, '9')

    expect(screen.getByText(/over stock by 4/i)).toBeInTheDocument()
    expect(screen.getByText(/reduce quantities to available stock/i)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('flags a line that asks for more than is in stock', async () => {
    const user = userEvent.setup()
    renderForm()
    await addProduct(user, 'Widget')

    const [, qty] = screen.getAllByRole('spinbutton')
    await user.clear(qty)
    await user.type(qty, '6')

    // 6 units against 5 in stock.
    expect(screen.getByText(/over stock by 1/i)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('disables out-of-stock products in the picker', async () => {
    const user = userEvent.setup()
    renderForm()
    await openPicker(user)

    expect(screen.getByRole('button', { name: /sold out thing/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /widget/i })).toBeEnabled()
  })

  it('increments the existing line instead of adding a duplicate', async () => {
    // The one-step add replaced "Add row, then choose": picking a product already on the
    // order bumps its quantity rather than opening a second line for the same thing.
    const user = userEvent.setup()
    renderForm()
    await addProduct(user, 'Widget')
    await addProduct(user, 'Widget')

    // Still one line, now asking for 2 of 5.
    expect(screen.getAllByRole('spinbutton')).toHaveLength(2) // exchange rate + one quantity
    expect(screen.getByText(/3 left/i)).toBeInTheDocument()
  })

  it('refuses to increment past available stock', async () => {
    const user = userEvent.setup()
    renderForm()
    // Widget has 5. A sixth tap has nothing left to claim.
    for (let i = 0; i < 6; i += 1) await addProduct(user, 'Widget')

    expect(screen.getByText(/only 5 of widget in stock/i)).toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
  })

  it('does not offer an out-of-stock product for a sale', async () => {
    const user = userEvent.setup()
    renderForm()
    await openPicker(user)
    expect(screen.getByRole('button', { name: /sold out thing/i })).toBeDisabled()
  })
})
