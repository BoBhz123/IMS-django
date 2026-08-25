import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('mints the public link on demand rather than whenever the invoice is opened', async () => {
    // Sharing publishes customer details to an unauthenticated URL, so it must be a
    // deliberate act — not a side effect of viewing.
    const user = userEvent.setup()
    const onShare = vi.fn()
    renderInvoice({ onShare })
    expect(onShare).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /share invoice/i }))
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('does not offer to copy a link before one exists', () => {
    renderInvoice({ onShare: vi.fn() })
    expect(screen.getByRole('button', { name: /share invoice/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument()
  })

  it('offers to copy the link once one exists', () => {
    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument()
  })

  it('sends the document without needing a public link to exist first', () => {
    // The send buttons carry the PDF and nothing else, so gating them on a share token
    // would force every send to publish the customer's details to a public URL that is
    // then never used.
    renderInvoice({})
    expect(screen.getByRole('button', { name: /whatsapp/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /telegram/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument()
  })

  it('has no link to this application anywhere in the action bar', () => {
    // The whole point of the change: a share carries the invoice, not an invitation to
    // open a web page. No wa.me, no t.me, no share-token URL.
    const { container } = renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })

    for (const anchor of container.querySelectorAll('a[href]')) {
      expect(anchor.getAttribute('href')).not.toMatch(/wa\.me|t\.me|myimsapp\.com/)
    }
  })
})

describe('Invoice PDF sharing', () => {
  function installShare({ canShare, share }) {
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true })
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  }

  afterEach(() => {
    for (const name of ['share', 'canShare']) {
      if (name in navigator) Reflect.deleteProperty(navigator, name)
    }
  })

  it('sends the actual PDF, and only the PDF, to the share sheet', async () => {
    const user = userEvent.setup()
    const share = vi.fn().mockResolvedValue(undefined)
    installShare({ canShare: () => true, share })

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n', paymentStatus: 'PAID', paidAmount: 98 })
    await user.click(screen.getByRole('button', { name: /whatsapp/i }))

    expect(share).toHaveBeenCalledTimes(1)
    const [payload] = share.mock.calls[0]
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0].type).toBe('application/pdf')
    expect(payload.files[0].name).toMatch(/^Invoice_\d{4}-\d{2}-\d{2}_.*\.pdf$/)
    // A PDF, not a stub: the header is the first four bytes of any valid file.
    expect(await payload.files[0].slice(0, 4).text()).toBe('%PDF')

    // No body, and above all no URL back into this app — even though this invoice has a
    // live share token, which is precisely the case that used to leak one.
    expect(payload.text).toBeUndefined()
    expect(payload.title).toMatch(/^Invoice #/)
    expect(JSON.stringify({ t: payload.title })).not.toMatch(/http|wa\.me|t\.me/)
  })

  it('shares the document from Telegram too', async () => {
    const user = userEvent.setup()
    const share = vi.fn().mockResolvedValue(undefined)
    installShare({ canShare: () => true, share })

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click(screen.getByRole('button', { name: /telegram/i }))

    expect(share).toHaveBeenCalledTimes(1)
    expect(share.mock.calls[0][0].files[0].type).toBe('application/pdf')
    expect(share.mock.calls[0][0].text).toBeUndefined()
  })

  it('opens the WhatsApp link with a summary where files cannot be shared', async () => {
    // Firefox and most desktop Linux. It must NOT download here — a press on WhatsApp that
    // silently drops a file in the downloads folder and opens nothing reads as broken.
    const user = userEvent.setup()
    const share = vi.fn()
    const open = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    installShare({ canShare: () => false, share })
    vi.stubGlobal('open', open)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL: vi.fn(),
    }))

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click(screen.getByRole('button', { name: /whatsapp/i }))

    expect(share).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)

    const [url] = open.mock.calls[0]
    expect(url).toContain('https://wa.me/?text=')
    const text = decodeURIComponent(url.split('text=')[1])
    expect(text).toContain('Invoice #C7BD9F4A')
    expect(text).toContain('$98.00')
    // Still no URL back into this app, even though this invoice has a live share token.
    expect(text).not.toContain('myimsapp.com')
    vi.unstubAllGlobals()
  })

  it('opens the Telegram link where files cannot be shared', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    installShare({ canShare: () => false, share: vi.fn() })
    vi.stubGlobal('open', open)

    renderInvoice({})
    await user.click(screen.getByRole('button', { name: /telegram/i }))

    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0][0]).toContain('t.me/share/url')
    vi.unstubAllGlobals()
  })

  it('falls back to the link when the share sheet itself fails', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    installShare({
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
    })
    vi.stubGlobal('open', open)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL: vi.fn(),
    }))

    renderInvoice({})
    await user.click(screen.getByRole('button', { name: /telegram/i }))

    expect(open).toHaveBeenCalledTimes(1)
    expect(createObjectURL).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does nothing further when the reader dismisses the share sheet', async () => {
    // The sheet did open — a dismissal is a decision, not a failure, and must not be
    // "recovered" by opening a web link or pushing a file into the downloads folder.
    const user = userEvent.setup()
    const open = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    installShare({ canShare: () => true, share: vi.fn().mockRejectedValue(abort) })
    vi.stubGlobal('open', open)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL: vi.fn(),
    }))

    renderInvoice({})
    await user.click(screen.getByRole('button', { name: /whatsapp/i }))

    expect(open).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('reserves the download for the Download PDF button alone', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    installShare({ canShare: () => false, share: vi.fn() })
    vi.stubGlobal('open', open)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL: vi.fn(),
    }))

    renderInvoice({})
    await user.click(screen.getByRole('button', { name: /download pdf/i }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/pdf')
    expect(open).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('offers a download that does not depend on the share sheet at all', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }))

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click(screen.getByRole('button', { name: /download pdf/i }))

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/pdf')
    vi.unstubAllGlobals()
  })

  it('does not need a share link before the PDF can be downloaded', () => {
    // The document exists whether or not it has been published to a public URL.
    renderInvoice({})
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument()
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
