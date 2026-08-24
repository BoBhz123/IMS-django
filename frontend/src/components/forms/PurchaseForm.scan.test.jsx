import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { PurchaseForm } from './PurchaseForm'

const WIDGET = { id: 1, name: 'Widget', cost_price: 6, stock_quantity: 5, images: [] }
const SCARCE = { id: 3, name: 'Scarce Thing', cost_price: 3, stock_quantity: 2, images: [] }
const RICE_A = { id: 4, name: 'Loose Rice 1kg', cost_price: 1, stock_quantity: 9, images: [] }
const RICE_B = { id: 5, name: 'Loose Rice 5kg', cost_price: 5, stock_quantity: 9, images: [] }

vi.mock('@/hooks/useProductSearch', () => ({
  useProductSearch: () => ({ products: [WIDGET, SCARCE, RICE_A, RICE_B], status: 'ready' }),
}))

vi.mock('@/lib/api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

const lookupByBarcode = vi.fn()
vi.mock('@/hooks/useBarcodeLookup', () => ({
  lookupByBarcode: (...args) => lookupByBarcode(...args),
}))

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
      <PurchaseForm open onClose={vi.fn()} onSaved={vi.fn()} suppliers={[]} />
    </CurrencyProvider>,
  )
}

async function scan(user) {
  await user.click(screen.getByRole('button', { name: /scan barcode/i }))
  await user.click(await screen.findByRole('button', { name: /simulate scan/i }))
}

/** One spinbutton per line now, after the exchange rate. */
const lineQuantity = (index = 0) => screen.getAllByRole('spinbutton').slice(1)[index]

describe('PurchaseForm barcode scanning', () => {
  beforeEach(() => {
    lookupByBarcode.mockReset()
  })

  it('selects the scanned product on a line', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [WIDGET] })
    renderForm()

    await scan(user)

    expect(await screen.findByRole('button', { name: /Widget/i })).toBeInTheDocument()
    expect(lineQuantity(0)).toHaveValue(1)
  })

  it('fills the unit cost from the product cost price', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [WIDGET] })
    renderForm()

    await scan(user)

    // Matches what picking the product by hand does — a scan must not leave the line at $0.
    expect(await screen.findByDisplayValue('6')).toBeInTheDocument()
  })

  it('increments the existing line when the same product is scanned twice', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [WIDGET] })
    renderForm()

    await scan(user)
    await scan(user)

    expect(screen.getAllByRole('button', { name: /Widget/i })).toHaveLength(1)
    expect(lineQuantity(0)).toHaveValue(2)
  })

  it('keeps counting past the current stock level', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'found', products: [SCARCE] })
    renderForm()

    await scan(user)
    await scan(user)
    await scan(user)
    await scan(user)

    // A purchase adds stock, so the order flow's cap must not apply here: buying 4 of
    // something you hold 2 of is the whole point.
    expect(lineQuantity(0)).toHaveValue(4)
    expect(screen.queryByText(/in stock/i)).not.toBeInTheDocument()
  })

  it('shows a message when the code matches nothing, and adds no line', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'not_found', products: [] })
    renderForm()

    await scan(user)

    expect(await screen.findByText(/no product has the barcode/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /select product/i })).toBeInTheDocument()
  })

  it('asks which product when a barcode matches several', async () => {
    const user = userEvent.setup()
    lookupByBarcode.mockResolvedValue({ status: 'ambiguous', products: [RICE_A, RICE_B] })
    renderForm()

    await scan(user)
    await user.click(await screen.findByRole('button', { name: /Loose Rice 5kg/i }))

    expect(screen.queryByRole('button', { name: /Loose Rice 1kg/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Loose Rice 5kg/i })).toBeInTheDocument()
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
