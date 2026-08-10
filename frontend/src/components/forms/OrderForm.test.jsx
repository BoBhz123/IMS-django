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

/** Open the line's product dropdown and choose `name`. */
async function selectProduct(user, name) {
  await user.click(screen.getByRole('button', { name: /select product/i }))
  await user.click(screen.getByRole('button', { name: new RegExp(name, 'i') }))
}

const submitButton = () => screen.getByRole('button', { name: /create order/i })

describe('OrderForm stock gating', () => {
  it('shows remaining stock once a product is picked', async () => {
    const user = userEvent.setup()
    renderForm()
    await selectProduct(user, 'Widget')

    // 1 of 5 requested by default → 4 left.
    expect(screen.getByText(/4 left — low/i)).toBeInTheDocument()
  })

  it('flags the exact limit and still allows submitting', async () => {
    const user = userEvent.setup()
    renderForm()
    await selectProduct(user, 'Widget')

    const qty = screen.getAllByRole('spinbutton')[1] // exchange rate is [0]
    await user.clear(qty)
    await user.type(qty, '5')

    expect(screen.getByText(/reached limit/i)).toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
  })

  it('blocks submission once the order exceeds stock', async () => {
    const user = userEvent.setup()
    renderForm()
    await selectProduct(user, 'Widget')

    const qty = screen.getAllByRole('spinbutton')[1]
    await user.clear(qty)
    await user.type(qty, '9')

    expect(screen.getByText(/over stock by 4/i)).toBeInTheDocument()
    expect(screen.getByText(/reduce quantities to available stock/i)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('counts the multiplier against stock, not bare quantity', async () => {
    const user = userEvent.setup()
    renderForm()
    await selectProduct(user, 'Widget')

    const [, qty, multiplier] = screen.getAllByRole('spinbutton')
    await user.clear(qty)
    await user.type(qty, '2')
    await user.clear(multiplier)
    await user.type(multiplier, '3')

    // 2 x 3 = 6 units against 5 in stock, even though quantity alone (2) fits.
    expect(screen.getByText(/over stock by 1/i)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('disables out-of-stock products in the picker', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /select product/i }))

    expect(screen.getByRole('button', { name: /sold out thing/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /widget/i })).toBeEnabled()
  })

  it('charges two lines of the same product against one shared pool', async () => {
    const user = userEvent.setup()
    renderForm()
    await selectProduct(user, 'Widget')

    await user.click(screen.getByRole('button', { name: /add item/i }))
    const pickers = screen.getAllByRole('button', { name: /select product/i })
    await user.click(pickers[pickers.length - 1])
    const options = screen.getAllByRole('button', { name: /widget/i })
    await user.click(options[options.length - 1])

    const spinbuttons = screen.getAllByRole('spinbutton')
    const firstQty = spinbuttons[1]
    await user.clear(firstQty)
    await user.type(firstQty, '4')

    const refreshed = screen.getAllByRole('spinbutton')
    const secondQty = refreshed[3]
    await user.clear(secondQty)
    await user.type(secondQty, '4')

    // 4 + 4 = 8 against 5. Each line alone fits; together they do not.
    expect(submitButton()).toBeDisabled()
  })
})
