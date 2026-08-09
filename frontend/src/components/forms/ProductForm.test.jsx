import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CurrencyProvider } from '@/context/CurrencyContext'
import { ProductForm } from './ProductForm'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

// The real scanner drives a camera, which jsdom does not have. Standing in for it keeps this
// test about the form's half of the contract — that a decoded code reaches form.barcode — and
// leaves the camera itself to BarcodeScannerModal.test.jsx.
vi.mock('@/components/ui/BarcodeScannerModal', () => ({
  BarcodeScannerModal: ({ open, onScan }) =>
    open ? (
      <button type="button" onClick={() => onScan('5901234123457')}>
        Simulate scan
      </button>
    ) : null,
}))

function renderForm(product) {
  render(
    <CurrencyProvider>
      <ProductForm
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        product={product}
        categories={[]}
        suppliers={[]}
      />
    </CurrencyProvider>,
  )
}

// By role, not getByLabelText: the scan button's aria-label is "Scan barcode", so a label
// query for /barcode/i matches both it and the input.
const barcodeInput = () => screen.getByRole('textbox', { name: /barcode/i })

describe('ProductForm barcode entry', () => {
  it('fills the barcode field from a scan', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: /scan barcode/i }))
    await user.click(await screen.findByRole('button', { name: /simulate scan/i }))

    expect(barcodeInput()).toHaveValue('5901234123457')
  })

  it('closes the scanner once a code has been read', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: /scan barcode/i }))
    await user.click(await screen.findByRole('button', { name: /simulate scan/i }))

    // Leaving it open would keep decoding and immediately overwrite the field again.
    expect(screen.queryByRole('button', { name: /simulate scan/i })).not.toBeInTheDocument()
  })

  it('still accepts a typed barcode', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.type(barcodeInput(), '4006381333931')

    expect(barcodeInput()).toHaveValue('4006381333931')
  })

  it('lets a scan replace a code that was already there', async () => {
    const user = userEvent.setup()
    renderForm({
      id: 7,
      name: 'Widget',
      barcode: '0000000000000',
      description: '',
      cost_price: 1,
      default_sell_price: 2,
      stock_quantity: 3,
      images: [],
    })

    expect(barcodeInput()).toHaveValue('0000000000000')
    await user.click(screen.getByRole('button', { name: /scan barcode/i }))
    await user.click(await screen.findByRole('button', { name: /simulate scan/i }))

    expect(barcodeInput()).toHaveValue('5901234123457')
  })

  it('does not submit the form when the scan button is pressed', async () => {
    const { api } = await import('@/lib/api')
    const user = userEvent.setup()
    renderForm()

    await user.click(screen.getByRole('button', { name: /scan barcode/i }))

    // type="button" matters: inside a <form>, the default is submit, and opening the scanner
    // would post a half-filled product.
    expect(api.post).not.toHaveBeenCalled()
  })
})
