import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { PurchaseForm } from './PurchaseForm'

const PRODUCTS = [
  { id: 1, name: 'Widget', cost_price: 4, stock_quantity: 10, images: [] },
  { id: 2, name: 'Gadget', cost_price: 2, stock_quantity: 6, images: [] },
]

// PurchaseItemSerializer renders `product` as a name, not an id — the form has to resolve it
// back through the catalog before it can post anything.
const PURCHASE = {
  id: 'aa11bb22-0000-0000-0000-000000000002',
  supplier: 'Acme',
  exchange_rate: 91000,
  placed_at: '2026-08-02T10:00:00Z',
  // See OrderForm.edit.test.jsx — the API always sends these, and an edit must preserve them.
  payment_status: 'PARTIALLY_PAID',
  paid_amount: '15.00',
  items: [{ product: 'Widget', quantity: 10, unit_price: '4.00' }],
}

const SUPPLIERS = [{ id: 3, name: 'Acme' }, { id: 4, name: 'Other Co' }]

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

function renderEdit(purchase = PURCHASE) {
  render(
    <CurrencyProvider>
      <PurchaseForm
        open
        purchase={purchase}
        onClose={() => {}}
        onSaved={() => {}}
        suppliers={SUPPLIERS}
      />
    </CurrencyProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  api.put.mockResolvedValue({ data: {} })
})

describe('PurchaseForm in edit mode', () => {
  it('is titled for editing and offers to save rather than create', async () => {
    renderEdit()
    expect(await screen.findByText('Edit purchase')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
  })

  it('resolves a line named by product name back to a real product id', async () => {
    const user = userEvent.setup()
    renderEdit()

    expect(await screen.findByText('Widget')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      `/inventory/purchases/${PURCHASE.id}/`,
      {
        supplier: '3',
        exchange_rate: 91000,
        // A partial payment DOES carry its amount: the server refuses PARTIALLY_PAID without
        // one rather than guessing what "partly" meant.
        payment_status: 'PARTIALLY_PAID',
        paid_amount: 15,
        items: [{ product: 1, quantity: 10, unit_price: '4.00' }],
      },
    ))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('renders the per-product messages of a rejected reduction', async () => {
    // The server answers a stock-negative reduction with a list, not a string — a
    // string-only branch would render nothing and the save would look like it did nothing.
    const user = userEvent.setup()
    api.put.mockRejectedValue({
      response: {
        status: 400,
        data: { items: ["Cannot reduce 'Widget' to 1 units: only 2 in stock."] },
      },
    })
    renderEdit()

    await user.click(await screen.findByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/cannot reduce 'widget'/i)).toBeInTheDocument()
  })

  it('warns that saving replaces every line', async () => {
    renderEdit()
    expect(await screen.findByText(/replaces every line/i)).toBeInTheDocument()
  })
})
