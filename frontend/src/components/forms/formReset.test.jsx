import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { ProductForm } from './ProductForm'
import { CustomerForm } from './CustomerForm'
import { SupplierForm } from './SupplierForm'
import { ExpenseForm } from './ExpenseForm'
import { OrderForm } from './OrderForm'
import { PurchaseForm } from './PurchaseForm'

// Prices are strings here on purpose. This project sets COERCE_DECIMAL_TO_STRING=False, so the
// API sends numbers — but the form has to survive either, and strings are the shape that breaks
// naive arithmetic. The scan tests cover the numeric case.
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
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const noop = () => {}

/**
 * Mount a form open, run `dirty` against it, close it, reopen it, then run `expectClean`.
 *
 * Closing rather than unmounting is the point: the forms stay mounted so SlideOver can play its
 * exit animation, and a mounted component keeps its state unless something resets it.
 */
async function reopen(Form, props, dirty, expectClean) {
  const user = userEvent.setup()
  const view = (open) => (
    <CurrencyProvider>
      <Form open={open} onClose={noop} onSaved={noop} {...props} />
    </CurrencyProvider>
  )
  const { rerender } = render(view(true))

  await dirty(user)

  rerender(view(false))
  rerender(view(true))

  await expectClean(user)
}

const textbox = (name) => screen.getByRole('textbox', { name })

/**
 * Put the Widget on the transaction the way the UI now does it: "+ Add product" opens the
 * picker, and a tap on the product adds the line. There is no longer a blank row with its own
 * "Select product" dropdown to go through.
 *
 * The anchored regex matters — the empty-state prompt reads "No items yet — tap to add a
 * product", which an unanchored /add product/i also matches.
 */
async function pickWidget(user) {
  await user.click(screen.getByRole('button', { name: /^add product$/i }))
  await user.click(await screen.findByRole('button', { name: /Widget/i }))
}

describe('forms reset when reopened', () => {
  it('ProductForm clears the name', async () => {
    await reopen(
      ProductForm,
      { categories: [], suppliers: [] },
      async (user) => user.type(textbox(/name/i), 'Leftover Widget'),
      async () => expect(textbox(/name/i)).toHaveValue(''),
    )
  })

  it('ProductForm clears a scanned or typed barcode', async () => {
    await reopen(
      ProductForm,
      { categories: [], suppliers: [] },
      async (user) => user.type(textbox(/barcode/i), '5901234123457'),
      async () => expect(textbox(/barcode/i)).toHaveValue(''),
    )
  })

  it('CustomerForm clears the name', async () => {
    await reopen(
      CustomerForm,
      {},
      async (user) => user.type(textbox(/name/i), 'Leftover Customer'),
      async () => expect(textbox(/name/i)).toHaveValue(''),
    )
  })

  it('SupplierForm clears the name', async () => {
    await reopen(
      SupplierForm,
      {},
      async (user) => user.type(textbox(/name/i), 'Leftover Supplier'),
      async () => expect(textbox(/name/i)).toHaveValue(''),
    )
  })

  it('ExpenseForm clears the description', async () => {
    await reopen(
      ExpenseForm,
      {},
      async (user) => user.type(textbox(/description/i), 'Leftover rent'),
      async () => expect(textbox(/description/i)).toHaveValue(''),
    )
  })

  it('OrderForm drops the line items', async () => {
    await reopen(
      OrderForm,
      { customers: [] },
      pickWidget,
      async () => {
        // Back to the empty state, with no line and no leftover product picker.
        expect(screen.getByText(/no items yet/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /select product/i })).not.toBeInTheDocument()
      },
    )
  })

  it('PurchaseForm drops the line items', async () => {
    await reopen(
      PurchaseForm,
      { suppliers: [] },
      pickWidget,
      async () => {
        expect(screen.getByText(/no items yet/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /select product/i })).not.toBeInTheDocument()
      },
    )
  })

  it('ProductForm restores the record being edited, not a blank form', async () => {
    // The reset must not throw away the record being edited — only the leftovers of the last one.
    const user = userEvent.setup()
    const product = { id: 7, name: 'Editable', barcode: '111', description: '', cost_price: '1.00', default_sell_price: '2.00', stock_quantity: 3, images: [] }
    const view = (open) => (
      <CurrencyProvider>
        <ProductForm open={open} onClose={noop} onSaved={noop} product={product} categories={[]} suppliers={[]} />
      </CurrencyProvider>
    )
    const { rerender } = render(view(true))
    await user.clear(textbox(/name/i))
    await user.type(textbox(/name/i), 'Scribbled over')

    rerender(view(false))
    rerender(view(true))

    expect(textbox(/name/i)).toHaveValue('Editable')
  })
})

describe('selecting a product fills the line price', () => {
  it('orders use the default SELL price', async () => {
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <OrderForm open onClose={noop} onSaved={noop} customers={[]} />
      </CurrencyProvider>,
    )
    await pickWidget(user)

    expect(screen.getByDisplayValue('10.00')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('6.00')).not.toBeInTheDocument()
  })

  it('purchases use the COST price', async () => {
    const user = userEvent.setup()
    render(
      <CurrencyProvider>
        <PurchaseForm open onClose={noop} onSaved={noop} suppliers={[]} />
      </CurrencyProvider>,
    )
    await pickWidget(user)

    expect(screen.getByDisplayValue('6.00')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('10.00')).not.toBeInTheDocument()
  })
})
