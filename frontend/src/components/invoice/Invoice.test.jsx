import { render, screen, waitFor, within } from '@testing-library/react'
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

/**
 * The two send targets live behind one "Share" menu, so every send test has to open it
 * first. Kept as a helper rather than repeated: the click is setup, not the thing under
 * test, and inlining it hides which assertion is actually failing when the menu changes.
 */
async function openShareMenu(user) {
  await user.click(screen.getByRole('button', { name: /^share$/i }))
  return within(screen.getByRole('menu', { name: /share invoice/i }))
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
  it('mints the public link when the share menu opens, not when the invoice does', async () => {
    // Opening the invoice must still not publish anything — that would turn every glance at
    // an order into a publication. Opening the *share menu* does, because the link has to
    // exist before a target is clicked: window.open reached after an await is treated as a
    // popup and blocked, so the token cannot be minted inside the send itself.
    const user = userEvent.setup()
    const onShare = vi.fn()
    renderInvoice({ onShare })
    expect(onShare).not.toHaveBeenCalled()

    await openShareMenu(user)
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('does not re-mint for an invoice that already has a link', async () => {
    // The endpoint is idempotent, so a second call is harmless rather than a second token —
    // but it is still a request per menu open for nothing.
    const user = userEvent.setup()
    const onShare = vi.fn()
    renderInvoice({ onShare, shareUrl: 'https://myimsapp.com/i/tok3n' })

    await openShareMenu(user)
    expect(onShare).not.toHaveBeenCalled()
  })

  it('holds the send targets until the link has arrived', async () => {
    // Sending mid-mint would compose a message with the link missing, which is the one thing
    // the recipient actually needs.
    const user = userEvent.setup()
    renderInvoice({ onShare: vi.fn(), sharing: true })

    const menu = await openShareMenu(user)
    // Both targets, so getAllByRole: while the mint is in flight neither says WhatsApp or
    // Telegram — they both read "Preparing link…", which is why this cannot be a getByRole.
    const items = menu.getAllByRole('menuitem', { name: /preparing link/i })
    expect(items).toHaveLength(2)
    for (const item of items) expect(item).toBeDisabled()
  })

  it('sends immediately for an invoice that can never have a link', async () => {
    // A purchase invoice passes no onShare at all. It must not sit disabled forever waiting
    // for a link that is never coming.
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)
    renderInvoice({})

    const menu = await openShareMenu(user)
    await user.click(menu.getByRole('menuitem', { name: /whatsapp/i }))
    expect(open).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('has no copy-link control anywhere', async () => {
    // Removed outright: the invoice sends the document, and a button whose whole output is
    // an invisible clipboard write was the least legible thing in the bar.
    const user = userEvent.setup()
    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument()

    await openShareMenu(user)
    expect(screen.queryByRole('menuitem', { name: /copy/i })).not.toBeInTheDocument()
  })

  it('offers the minted link itself once one exists, rather than stranding it', async () => {
    // Without this the mint action would produce a token with no way to reach it: press
    // "Create public link", the item disappears, and nothing observable happens.
    const user = userEvent.setup()
    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })

    const menu = await openShareMenu(user)
    expect(menu.queryByRole('menuitem', { name: /create public link/i })).not.toBeInTheDocument()
    expect(menu.getByRole('menuitem', { name: /open public link/i })).toHaveAttribute(
      'href',
      'https://myimsapp.com/i/tok3n',
    )
  })

  it('collapses both send targets behind one control', async () => {
    // The action bar carries Print, Download and Share — the two per-target buttons are not
    // loose in it any more.
    const user = userEvent.setup()
    renderInvoice({})
    expect(screen.queryByRole('button', { name: /whatsapp/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /telegram/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument()

    // And they are reachable, without a public link needing to exist first: gating a send on
    // a share token would publish the customer's details to a public URL never used.
    const menu = await openShareMenu(user)
    expect(menu.getByRole('menuitem', { name: /whatsapp/i })).toBeInTheDocument()
    expect(menu.getByRole('menuitem', { name: /telegram/i })).toBeInTheDocument()
  })

  it('closes only the menu on Escape, not the invoice underneath it', async () => {
    // The menu opens inside the invoice Modal, and both would answer one Escape if it bound
    // its own unconditional listener — the regression lib/overlayStack.js exists to prevent.
    // Closing the invoice here would discard nothing, but it is the same mistake that once
    // threw away every entered line item in the order form.
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderInvoice({ onClose })

    await openShareMenu(user)
    await user.keyboard('{Escape}')

    // waitFor, because AnimatePresence keeps the panel mounted through its exit animation —
    // a bare assertion runs a frame early and fails on a menu that is closing correctly.
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: /share invoice/i })).not.toBeInTheDocument(),
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('has no link to this application in the action bar itself', () => {
    // A share carries the invoice, not an invitation to open a web page. The one anchor that
    // may hold a share-token URL is "Open public link", which is inside the menu and is the
    // reader deliberately opening a link they minted — not something a send puts in a
    // message. The payload assertions below are what pin that distinction.
    const { container } = renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })

    for (const anchor of container.querySelectorAll('a[href]')) {
      expect(anchor.getAttribute('href')).not.toMatch(/wa\.me|t\.me|myimsapp\.com/)
    }
  })
})

describe('Invoice message sharing', () => {
  function installShare({ canShare, share }) {
    Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true })
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  }

  afterEach(() => {
    for (const name of ['share', 'canShare']) {
      if (name in navigator) Reflect.deleteProperty(navigator, name)
    }
  })

  it('opens the customer own WhatsApp chat with the invoice link', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)

    renderInvoice({
      shareUrl: 'https://myimsapp.com/i/tok3n',
      paymentStatus: 'PAID',
      paidAmount: 98,
    })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /whatsapp/i }))

    expect(open).toHaveBeenCalledTimes(1)
    const params = new URLSearchParams(open.mock.calls[0][0].split('?')[1])
    // The customer's own number off the order — +961 71 999 888 — reduced to digits, because
    // a `+` in a query string is a space and the chat then does not open.
    expect(params.get('phone')).toBe('96171999888')

    const text = params.get('text')
    expect(text).toContain('Invoice #C7BD9F4A')
    expect(text).toContain('$98.00')
    expect(text).toContain('https://myimsapp.com/i/tok3n')
    vi.unstubAllGlobals()
  })

  it('sends the invoice URL to Telegram, which cannot be addressed', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /telegram/i }))

    expect(open).toHaveBeenCalledTimes(1)
    const [url] = open.mock.calls[0]
    expect(url).toContain('t.me/share/url')

    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('url')).toBe('https://myimsapp.com/i/tok3n')
    // No phone: Telegram reaches a person by chat id or @username and has no way to open a
    // chat from a phone number, so the one we hold is unusable here.
    expect(params.get('phone')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('opens the contact picker for a walk-in with no phone on file', async () => {
    // Same endpoint, no phone parameter — which is what puts WhatsApp on the contact picker
    // instead of an "invalid number" error. The message is unchanged: the seller picks who
    // receives it and the link is already in the box.
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)

    renderInvoice({ partyPhone: null, shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /whatsapp/i }))

    const [url] = open.mock.calls[0]
    expect(url.startsWith('https://api.whatsapp.com/send?')).toBe(true)
    expect(new URLSearchParams(url.split('?')[1]).has('phone')).toBe(false)
    expect(decodeURIComponent(url)).toContain('https://myimsapp.com/i/tok3n')
    vi.unstubAllGlobals()
  })

  it('falls back to the picker for a number stored in national format', async () => {
    // `03 123 456` cannot be completed to E.164 without a country this app does not store,
    // and a guess would open a chat with a real stranger. The picker is the safe answer.
    const user = userEvent.setup()
    const open = vi.fn()
    vi.stubGlobal('open', open)

    renderInvoice({ partyPhone: '03 123 456', shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /whatsapp/i }))

    const params = new URLSearchParams(open.mock.calls[0][0].split('?')[1])
    expect(params.has('phone')).toBe(false)
    expect(params.get('text')).toContain('https://myimsapp.com/i/tok3n')
    vi.unstubAllGlobals()
  })

  it('sends the link even where the OS share sheet is available', async () => {
    // The reversal, pinned. The sheet can carry the actual PDF but cannot preselect WhatsApp
    // and cannot say who to send to; an addressed link does both, so it wins even on a phone
    // that supports file sharing. If this starts failing, the two paths have been swapped
    // back and the customer's number is no longer being used.
    const user = userEvent.setup()
    const share = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn()
    installShare({ canShare: () => true, share })
    vi.stubGlobal('open', open)

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /whatsapp/i }))

    expect(share).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('never downloads on a send, on any platform', async () => {
    // A press on "WhatsApp" that drops a file in the downloads folder and opens nothing
    // reads as a broken button.
    const user = userEvent.setup()
    const open = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:invoice')
    installShare({ canShare: () => false, share: vi.fn() })
    vi.stubGlobal('open', open)
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL, revokeObjectURL: vi.fn(),
    }))

    renderInvoice({ shareUrl: 'https://myimsapp.com/i/tok3n' })
    await user.click((await openShareMenu(user)).getByRole('menuitem', { name: /telegram/i }))

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
