import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { OrderForm } from './OrderForm'

const WIDGET = { id: 1, name: 'Widget', default_sell_price: 10, stock_quantity: 5, images: [] }
const SCARCE = { id: 3, name: 'Scarce Thing', default_sell_price: 4, stock_quantity: 2, images: [] }
const RICE_A = { id: 4, name: 'Loose Rice 1kg', default_sell_price: 2, stock_quantity: 9, images: [] }
const RICE_B = { id: 5, name: 'Loose Rice 5kg', default_sell_price: 9, stock_quantity: 9, images: [] }

vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: [WIDGET, SCARCE, RICE_A, RICE_B], status: 'ready' }),
}))

vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

const lookupByBarcode = vi.fn()
vi.mock('@/hooks/useBarcodeLookup', () => ({
  lookupByBarcode: (...args) => lookupByBarcode(...args),
}))

// Stands in for the camera. The form's half of the contract is what a decoded code does to the
// order lines; the decoding itself is covered by BarcodeScannerModal.test.jsx.
vi.mock('@/components/ui/BarcodeScannerModal', () => ({
  BarcodeScannerModal: ({ open, onScan }) =>
    open ? (
      <button type="button" onClick={() => onScan('5901234123457')}>
        Simulate scan
      </button>
    ) : null,
}))

function renderForm() {
  render(
    <CurrencyProvider>
      <OrderForm open onClose={vi.fn()} onSaved={vi.fn()} customers={[]} />
    </CurrencyProvider>,
  )
}

/** One full trip through the scanner: open it, fire a decode, wait for the lookup to settle. */
async function scan(user) {
  await user.click(screen.getByRole('button', { name: /scan barcode/i }))
  await user.click(await screen.findByRole('button', { name: /simulate scan/i }))
}

/**
 * The quantity input of a line. Spinbuttons run [exchange rate, qty, ×per unit, qty, …], so the
 * quantities are the even-indexed ones once the exchange rate is dropped.
 */
const lineQuantity = (index = 0) =>
  screen.getAllByRole('spinbutton').slice(1).filter((_, i) => i % 2 === 0)[index]

describe('OrderForm barcode scanning', () => {
  beforeEach(() => {
    lookupByBarcode.mockReset()
  })

  it('adds a scanned product as a new line', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [WIDGET] })
    renderForm()

    await scan(user)

    expect(await screen.findByRole('button', { name: /Widget/i })).toBeInTheDocument()
    expect(lineQuantity(0)).toHaveValue(1)
  })

  it('increments the existing line when the same product is scanned twice', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [WIDGET] })
    renderForm()

    await scan(user)
    await scan(user)

    // One line, not two — a second scan of the same label means "another one of these".
    expect(screen.getAllByRole('button', { name: /Widget/i })).toHaveLength(1)
    expect(lineQuantity(0)).toHaveValue(2)
  })

  it('does not increment past the stock cap', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [SCARCE] })
    renderForm()

    await scan(user)
    await scan(user)
    await scan(user)

    expect(lineQuantity(0)).toHaveValue(2)
    expect(await screen.findByText(/only 2 .* in stock/i)).toBeInTheDocument()
  })

  it('shows a message when the code matches nothing, and adds no line', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'not_found', products: [] })
    renderForm()

    await scan(user)

    expect(await screen.findByText(/no product has the barcode/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /select product/i })).toBeInTheDocument()
  })

  it('tells the user to retry when the lookup fails, rather than offering to add a product', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'error', products: [] })
    renderForm()

    await scan(user)

    expect(await screen.findByText(/try again/i)).toBeInTheDocument()
  })

  it('asks which product when a barcode matches several', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'ambiguous', products: [RICE_A, RICE_B] })
    renderForm()

    await scan(user)

    // Barcodes are deliberately non-unique here, so guessing would add the wrong line.
    const choice = await screen.findByRole('button', { name: /Loose Rice 5kg/i })
    await user.click(choice)

    expect(screen.queryByRole('button', { name: /Loose Rice 1kg/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Loose Rice 5kg/i })).toBeInTheDocument()
    expect(lineQuantity(0)).toHaveValue(1)
  })

  it('leaves manual product search working', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: /select product/i }))
    await user.click(screen.getByRole('button', { name: /Widget/i }))

    expect(lookupByBarcode).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Widget/i })).toBeInTheDocument()
  })
})
