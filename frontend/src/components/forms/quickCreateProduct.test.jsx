import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { resetOverlayStack } from '@/lib/overlayStack'
import { OrderForm } from './OrderForm'
import { PurchaseForm } from './PurchaseForm'

// Deliberately empty: the picker offers nothing, so "+ New product" is the only way forward —
// which is exactly the situation the crash was reported in.
vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: [], status: 'ready' }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

const CREATED = {
  id: 42,
  name: 'Fresh Widget',
  cost_price: '3.50',
  default_sell_price: '9.25',
  stock_quantity: 12,
  images: [],
}

const noop = () => {}

async function setupApi() {
  const { api } = await import('@/lib/api')
  api.get.mockImplementation((url) =>
    Promise.resolve({
      data: url.includes('categories')
        ? [{ id: 3, name: 'Widgets' }]
        : [{ id: 9, name: 'Acme Supply' }],
    }),
  )
  api.post.mockResolvedValue({ data: CREATED })
  return api
}

/** Open the picker, then the quick-create form inside it. */
async function openQuickCreate(user) {
  await user.click(screen.getByRole('button', { name: /^add product$/i }))
  await user.click(await screen.findByRole('button', { name: /new product/i }))
}

/**
 * The product form's submit button.
 *
 * "Add product" is on screen twice while the quick-create is open — the transaction form's
 * picker opener and this submit — so the query filters on type, which is the thing that
 * actually distinguishes them.
 */
function submitProductButton() {
  const matches = screen.getAllByRole('button', { name: /^add product$/i })
  const submit = matches.find((button) => button.type === 'submit')
  if (!submit) throw new Error('no submit button named "Add product" is on screen')
  return submit
}

/** Fill the minimum a product needs — name and the required category — and submit it. */
async function saveProduct(user) {
  await user.type(await screen.findByRole('textbox', { name: /^name$/i }), 'Fresh Widget')
  await user.selectOptions(await screen.findByRole('combobox', { name: /category/i }), '3')
  await user.click(submitProductButton())
}

describe('quick-creating a product from a transaction form', () => {
  beforeEach(() => {
    resetOverlayStack()
  })

  it('opens the product form instead of crashing the transaction form', async () => {
    // The reported "modal freeze". ProductFormBody spreads its `categories` prop, and neither
    // transaction form passed one — spreading undefined threw, React unmounted the tree, and
    // the user was left with a backdrop and nothing on it.
    await setupApi()
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)

    expect(await screen.findByRole('textbox', { name: /^name$/i })).toBeInTheDocument()
    // The order form underneath survived.
    expect(screen.getByRole('heading', { name: /add order/i })).toBeInTheDocument()
  })

  it('populates the new product form with real categories to choose from', async () => {
    await setupApi()
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)

    // Defaulting the prop to [] would have stopped the crash and still left a required select
    // with nothing in it, i.e. a form that can never be submitted.
    expect(await screen.findByRole('option', { name: 'Widgets' })).toBeInTheDocument()
  })

  it('does not lock the page after the quick-create closes', async () => {
    // Modal and SlideOver used to blank document.body.style.overflow independently, so a nested
    // close handed scrolling back while overlays were still open — and the reverse order left
    // the page locked with nothing on screen to explain it.
    await setupApi()
    const user = userEvent.setup()
    const { rerender } = render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)
    expect(document.body.style.overflow).toBe('hidden')

    rerender(
      <CurrencyProvider>
        <OrderForm open={false} onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await waitFor(() => expect(document.body.style.overflow).toBe(''))
  })

  it('puts the created product on the order at its default sell price', async () => {
    const api = await setupApi()
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)
    await saveProduct(user)

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/inventory/products/', expect.anything()))
    // 9.25 is the sell price. An order sells, so it must not pick up the 3.50 cost price.
    expect(await screen.findByDisplayValue('9.25')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('3.50')).not.toBeInTheDocument()
  })

  it('puts the created product on a purchase at its cost price', async () => {
    const api = await setupApi()
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <PurchaseForm open onClose={noop} onSaved={noop} suppliers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)
    await saveProduct(user)

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/inventory/products/', expect.anything()))
    // A purchase buys, so it takes the cost price, not the sell price.
    expect(await screen.findByDisplayValue('3.50')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('9.25')).not.toBeInTheDocument()
  })

  it('closes the picker once the new product has been added', async () => {
    await setupApi()
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )

    await openQuickCreate(user)
    await saveProduct(user)

    // The reason the user opened the picker is now done, so both overlays get out of the way.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /new product/i })).not.toBeInTheDocument(),
    )
  })
})
