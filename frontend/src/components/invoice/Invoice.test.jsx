import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@/context/AuthContext'
import { INVOICE_FALLBACK_NAME, INVOICE_TAGLINE } from '@/lib/invoiceConfig'
import { Invoice } from './Invoice'

const ITEMS = [
  { name: 'Widget', quantity: 36, unitPrice: 2.5 },
  { name: 'Gadget', quantity: 1, unitPrice: 8 },
]

const ACCOUNT = {
  business_name: 'Beirut Hardware',
  phone: '+961 70 123 456',
  email: 'shop@beiruthardware.lb',
}

function renderInvoice(props = {}, account = ACCOUNT) {
  return render(
    <AuthContext.Provider value={{ account }}>
      <Invoice
        open
        onClose={() => {}}
        documentType="Invoice"
        id="c7bd9f4a-1111-2222-3333-444444444444"
        placedAt="2026-08-04T10:00:00Z"
        exchangeRate={89000}
        partyLabel="Customer"
        partyName="Layal"
        partyPhone="+961 71 999 888"
        partyLocation="Hamra, Beirut"
        items={ITEMS}
        {...props}
      />
    </AuthContext.Provider>,
  )
}

describe('Invoice letterhead', () => {
  it('prints the account business name, phone and email', () => {
    renderInvoice()
    expect(screen.getByText('Beirut Hardware')).toBeInTheDocument()
    expect(screen.getByText('+961 70 123 456')).toBeInTheDocument()
    expect(screen.getByText('shop@beiruthardware.lb')).toBeInTheDocument()
  })

  it('falls back to a placeholder name when the account has none', () => {
    // Never a blank letterhead: an account that skipped the business name at signup still
    // gets a printable document.
    renderInvoice({}, { business_name: '', phone: '', email: '' })
    expect(screen.getByText(INVOICE_FALLBACK_NAME)).toBeInTheDocument()
  })

  it('renders without an auth session at all', () => {
    // useSellerIdentity reads the context directly rather than through useAuth, which throws
    // outside a provider. A missing session must not crash the print dialog.
    render(
      <Invoice
        open
        onClose={() => {}}
        documentType="Invoice"
        id="c7bd9f4a-1111-2222-3333-444444444444"
        placedAt="2026-08-04T10:00:00Z"
        exchangeRate={89000}
        partyLabel="Customer"
        partyName="Layal"
        items={ITEMS}
      />,
    )
    expect(screen.getByText(INVOICE_FALLBACK_NAME)).toBeInTheDocument()
  })
})

describe('Invoice bill-to block', () => {
  it('labels the recipient BILL TO with their name and address', () => {
    renderInvoice()
    expect(screen.getByText(/bill to/i)).toBeInTheDocument()
    expect(screen.getByText('Layal')).toBeInTheDocument()
    expect(screen.getByText('Hamra, Beirut')).toBeInTheDocument()
  })

  it('names a walk-in when there is no customer on the order', () => {
    renderInvoice({ partyName: null, partyPhone: null, partyLocation: null })
    expect(screen.getByText(/walk-in customer/i)).toBeInTheDocument()
    expect(screen.getByText(/no address on file/i)).toBeInTheDocument()
  })

  it('says nothing about an address it does not have', () => {
    renderInvoice({ partyLocation: null })
    expect(screen.queryByText('Hamra, Beirut')).not.toBeInTheDocument()
    // The phone is still there, so the "nothing on file" line must not appear.
    expect(screen.queryByText(/no address on file/i)).not.toBeInTheDocument()
  })
})

describe('Invoice line table', () => {
  it('has the reference columns in order', () => {
    renderInvoice()
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent.trim())
    expect(headers).toEqual(['#', 'Items', 'Qty', 'Unit cost', 'Total'])
  })

  it('numbers the lines from one', () => {
    renderInvoice()
    const rows = screen.getAllByRole('row').slice(1) // drop the header row
    expect(within(rows[0]).getByText('1')).toBeInTheDocument()
    expect(within(rows[1]).getByText('2')).toBeInTheDocument()
  })

  it('shows one quantity column, in physical units', () => {
    // The old layout split UNIT (pack size) from QTY (number of packs). unit_multiplier was
    // removed on 2026-08-24, so a case of 12 is recorded as 36 units and there is one column.
    renderInvoice()
    const row = screen.getAllByRole('row')[1]
    const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent.trim())
    expect(cells).toEqual(['1', 'Widget', '36', '$2.50', '$90.00'])
  })
})

describe('Invoice totals and badging', () => {
  it('shows a subtotal and a total in USD', () => {
    renderInvoice()
    // 3 * 12 * 2.50 + 1 * 1 * 8 = 98
    expect(screen.getAllByText('$98.00')).toHaveLength(2)
    expect(screen.getByText('Subtotal')).toBeInTheDocument()
    // Exact match: 'Total' is also a column header and the prefix of 'Total (LBP)'.
    expect(screen.getAllByText('Total', { exact: true }).length).toBeGreaterThan(0)
  })

  it('shows the secondary LBP conversion alongside', () => {
    renderInvoice()
    expect(screen.getAllByText('8,722,000 LBP').length).toBeGreaterThan(0)
  })

  it('omits the LBP lines when no exchange rate was recorded', () => {
    renderInvoice({ exchangeRate: 0 })
    expect(screen.queryByText(/LBP/)).not.toBeInTheDocument()
  })

  it('carries a PAID badge dated to the transaction', () => {
    renderInvoice()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getAllByText('Aug 4, 2026').length).toBeGreaterThan(0)
  })

  it('signs off with the configured tagline', () => {
    renderInvoice()
    expect(screen.getByText(INVOICE_TAGLINE)).toBeInTheDocument()
  })
})

describe('Invoice print scaffolding', () => {
  it('marks the document with the class the print stylesheet targets', () => {
    // index.css hangs the whole @media print block off .invoice-print — renaming it here
    // would silently return printing to the clipped, dark-barred default. Queried off the
    // document, not the render container: Modal renders through a portal.
    renderInvoice()
    expect(document.querySelector('.invoice-print')).not.toBeNull()
  })

  it('keeps the print control out of the printed output', () => {
    renderInvoice()
    const printButton = screen.getByRole('button', { name: /print/i })
    expect(printButton.closest('.no-print')).not.toBeNull()
  })
})

describe('Invoice payment stamp', () => {
  it('shows no stamp when the order carries no payment state', () => {
    // An older cached payload, or a bare render. Better nothing than "undefined" stamped
    // across a document a customer receives.
    renderInvoice()
    expect(screen.queryByText(/^PAID$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/UNPAID/)).not.toBeInTheDocument()
  })

  it('stamps a paid invoice with what was paid and no balance line', () => {
    renderInvoice({ paymentStatus: 'PAID', paidAmount: 98, remainingAmount: 0 })
    expect(screen.getByText('PAID')).toBeInTheDocument()
    expect(screen.getByText(/Paid \$98\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/Balance/)).not.toBeInTheDocument()
  })

  it('stamps a partial payment with both figures', () => {
    renderInvoice({ paymentStatus: 'PARTIALLY_PAID', paidAmount: 40, remainingAmount: 58 })
    expect(screen.getByText('PARTIALLY PAID')).toBeInTheDocument()
    expect(screen.getByText(/Paid \$40\.00/)).toBeInTheDocument()
    expect(screen.getByText(/Balance \$58\.00/)).toBeInTheDocument()
  })

  it('stamps an unpaid invoice with the balance only', () => {
    renderInvoice({ paymentStatus: 'UNPAID', paidAmount: 0, remainingAmount: 98 })
    expect(screen.getByText('UNPAID')).toBeInTheDocument()
    expect(screen.getByText(/Balance \$98\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/Paid \$/)).not.toBeInTheDocument()
  })
})

describe('Invoice sharing', () => {
  it('offers to create a link before one exists, and no share targets yet', () => {
    renderInvoice({ onShare: vi.fn() })
    expect(screen.getByRole('button', { name: /share invoice/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /whatsapp/i })).not.toBeInTheDocument()
  })

  it('mints the link on demand rather than whenever the invoice is opened', async () => {
    // Sharing publishes customer details to an unauthenticated URL, so it must be a
    // deliberate act — not a side effect of viewing.
    const user = userEvent.setup()
    const onShare = vi.fn()
    renderInvoice({ onShare })
    expect(onShare).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /share invoice/i }))
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('shows the share targets once a link exists', () => {
    renderInvoice({
      shareUrl: 'https://myimsapp.com/i/tok3n',
      paymentStatus: 'PAID',
      paidAmount: 98,
    })
    const whatsapp = screen.getByRole('link', { name: /whatsapp/i })
    expect(whatsapp).toHaveAttribute('href', expect.stringContaining('https://wa.me/?text='))
    expect(decodeURIComponent(whatsapp.getAttribute('href'))).toContain(
      'https://myimsapp.com/i/tok3n',
    )
    expect(screen.getByRole('link', { name: /telegram/i })).toHaveAttribute(
      'href', expect.stringContaining('t.me/share/url'),
    )
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument()
  })

  it('opens share targets in a new tab without leaking the opener', () => {
    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    for (const name of [/whatsapp/i, /telegram/i]) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveAttribute('target', '_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })

  it('has a close action in the toolbar', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderInvoice({ onClose })
    // Two controls close this: the Modal's own icon-only X and the toolbar button. Pick the
    // toolbar one by its visible label — the X has none.
    const closeButton = screen
      .getAllByRole('button', { name: /close/i })
      .find((button) => button.textContent.trim() === 'Close')
    await user.click(closeButton)
    expect(onClose).toHaveBeenCalled()
  })
})
