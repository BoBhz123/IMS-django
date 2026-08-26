import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildShareSummary,
  canShareFiles,
  makeInvoiceFile,
  normalizePhone,
  paymentLabel,
  publicInvoiceUrl,
  shareInvoiceFile,
  telegramShareUrl,
  whatsappShareUrl,
} from './invoiceShare'

const usd = (value) => `$${Number(value).toFixed(2)}`

describe('paymentLabel', () => {
  it('spells out a partial payment', () => {
    expect(paymentLabel('PARTIALLY_PAID')).toBe('PARTIALLY PAID')
  })

  it('falls back to UNPAID for a status it does not know', () => {
    // An older cached payload, or a status added server-side before the SPA ships. Reading
    // "UNPAID" is the safe wrong answer; rendering "undefined" on an invoice is not.
    expect(paymentLabel(undefined)).toBe('UNPAID')
  })
})

describe('publicInvoiceUrl', () => {
  it('builds the link against the host actually serving the page', () => {
    // jsdom's default origin. The point is that it is read at call time rather than baked
    // in: a link minted on localhost has to open on localhost, because the token exists only
    // in the local database and production has never heard of it.
    expect(publicInvoiceUrl('tok3n')).toBe('http://localhost:3000/i/tok3n')
  })

  it('follows the origin wherever the bundle is served from', () => {
    // Neutral hosts on purpose. DomainConfigurationTests scans frontend/src for the old
    // subdomain this app migrated off, and a realistic-looking example in a test is exactly
    // how that string creeps back into the tree.
    const original = window.location
    for (const origin of ['https://myimsapp.com', 'https://shop.example.com']) {
      Object.defineProperty(window, 'location', {
        value: { origin }, configurable: true, writable: true,
      })
      expect(publicInvoiceUrl('tok3n')).toBe(`${origin}/i/tok3n`)
    }
    Object.defineProperty(window, 'location', {
      value: original, configurable: true, writable: true,
    })
  })

  it('returns null rather than a link ending in undefined', () => {
    // A caller with no token must omit the link, not send a URL that 404s at the customer.
    for (const token of [undefined, null, '']) expect(publicInvoiceUrl(token)).toBeNull()
  })
})

describe('the message summary', () => {
  const base = { reference: 'A3F2B1C9', sellerName: 'Acme Trading', total: 148, formatPrimary: usd }
  const INVOICE_URL = 'https://myimsapp.com/i/tok3n'

  it('summarises the invoice in one line', () => {
    expect(buildShareSummary(base)).toBe('Invoice #A3F2B1C9 — Acme Trading · Total: $148.00')
  })

  it('reads correctly with no seller name on the account', () => {
    // No dangling separator with nothing after it.
    expect(buildShareSummary({ ...base, sellerName: '' }))
      .toBe('Invoice #A3F2B1C9 · Total: $148.00')
  })

  it('renders the total in the account display currency', () => {
    const lbp = buildShareSummary({ ...base, formatPrimary: () => '13,172,000 LBP' })
    expect(lbp).toContain('13,172,000 LBP')
  })

  it('carries the public invoice link, which is what the recipient opens', () => {
    expect(buildShareSummary({ ...base, invoiceUrl: INVOICE_URL }))
      .toBe(`Invoice #A3F2B1C9 — Acme Trading · Total: $148.00 · View invoice: ${INVOICE_URL}`)
  })

  it('stays sendable when there is no link to carry', () => {
    // A purchase invoice has no public link at all, and a mint can fail. Neither may produce
    // a message with a dangling "View invoice:" and nothing after it.
    expect(buildShareSummary({ ...base, invoiceUrl: null })).not.toMatch(/View invoice/)
  })
})

describe('the WhatsApp deep link', () => {
  it('addresses the customer by number and carries the whole message', () => {
    const url = whatsappShareUrl('Invoice #A3F2 · Total: $10.00', { phone: '+961 71 999 888' })
    const params = new URLSearchParams(url.split('?')[1])

    expect(url.startsWith('https://api.whatsapp.com/send?')).toBe(true)
    expect(params.get('phone')).toBe('96171999888')
    expect(params.get('text')).toBe('Invoice #A3F2 · Total: $10.00')
  })

  it('strips the plus, which would otherwise arrive as a space', () => {
    // `+` is a literal space in a query string, so phone=+961… reaches WhatsApp as " 961…"
    // and the chat silently does not open. Digits only is also what WhatsApp documents.
    const url = whatsappShareUrl('m', { phone: '+961-71-999-888' })
    expect(url).toContain('phone=96171999888')
    expect(url).not.toContain('+961')
  })

  it('omits the phone parameter entirely when there is no number', () => {
    // Omitted, not empty: `phone=` with nothing after it is a different request from no
    // phone at all — WhatsApp reads it as an address it cannot resolve and shows an error
    // instead of the picker. The URL stays the same endpoint either way.
    for (const phone of [undefined, null, '', '   ', 'n/a', '-']) {
      const url = whatsappShareUrl('Invoice #A3F2', { phone })
      expect(url).toBe('https://api.whatsapp.com/send?text=Invoice+%23A3F2')
      expect(url).not.toContain('phone')
    }
  })

  it('still carries the summary and the invoice link with no phone', () => {
    // The fallback has to remain a working send, not a degraded one: same message, same
    // link, the seller just picks who receives it.
    const message = 'Invoice #A3F2 · Total: $98.00 · View invoice: https://myimsapp.com/i/tok3n'
    const params = new URLSearchParams(whatsappShareUrl(message, {}).split('?')[1])
    expect(params.get('text')).toBe(message)
    expect(params.has('phone')).toBe(false)
  })

  it('puts the invoice link in the text, because there is no url parameter', () => {
    const message = 'Invoice #A3F2 · View invoice: https://myimsapp.com/i/tok3n'
    const params = new URLSearchParams(whatsappShareUrl(message, { phone: '96171' }).split('?')[1])
    expect(params.get('text')).toContain('https://myimsapp.com/i/tok3n')
  })
})

describe('normalizePhone', () => {
  it('reduces an international number to E.164 digits', () => {
    for (const input of ['+961 71 999 888', '+961-71-999-888', '(+961) 71/999.888']) {
      expect(normalizePhone(input)).toBe('96171999888')
    }
  })

  it('accepts 00 as the international prefix', () => {
    expect(normalizePhone('00961 71 999 888')).toBe('96171999888')
  })

  it('refuses a national number, because the country code is unknowable', () => {
    // `03 123 456` is complete inside its own country and meaningless outside it, and this
    // app stores no country to complete it with. Sending it anyway is not a broken link —
    // it is a link to a *different real person*, which is how a customer's invoice reaches
    // a stranger. Refusing falls the send back to the contact picker, where a human looks.
    for (const input of ['03 123 456', '0712345678', '0-71-999-888']) {
      expect(normalizePhone(input)).toBe('')
    }
  })

  it('refuses anything that is not a phone number', () => {
    for (const input of [undefined, null, '', '   ', 'n/a', '-', 'ext. 4', '1234567']) {
      expect(normalizePhone(input)).toBe('')
    }
  })

  it('refuses more digits than E.164 allows', () => {
    // A merged pair of numbers, or a note typed into the field. 15 is the E.164 ceiling.
    expect(normalizePhone('+9617199988812345')).toBe('')
    expect(normalizePhone('+961719998881')).toBe('961719998881')
  })
})

describe('the Telegram share link', () => {
  it('sends the invoice URL and the summary', () => {
    const params = new URLSearchParams(
      telegramShareUrl('Invoice #A3F2', { url: 'https://myimsapp.com/i/tok3n' }).split('?')[1],
    )
    expect(params.get('text')).toBe('Invoice #A3F2')
    expect(params.get('url')).toBe('https://myimsapp.com/i/tok3n')
  })

  it('still composes with no link at all', () => {
    const params = new URLSearchParams(telegramShareUrl('Invoice #A3F2').split('?')[1])
    expect(params.get('text')).toBe('Invoice #A3F2')
    expect(params.get('url')).toBe('')
  })

  it('takes no phone number, because Telegram cannot use one', () => {
    // Not an omission: a bot or a share link reaches a person by chat id or @username, and
    // there is no way to open a Telegram chat from a bare phone number. Passing it would
    // build a parameter Telegram ignores and imply an addressing that does not happen.
    const url = telegramShareUrl('Invoice #A3F2', { url: 'https://myimsapp.com/i/t', phone: '9617' })
    expect(url).not.toContain('phone')
    expect(url).not.toContain('9617')
  })
})

describe('sharing the document itself', () => {
  const pdf = () =>
    makeInvoiceFile(new Blob([new Uint8Array([0x25, 0x50])], { type: 'application/pdf' }),
      'Invoice_2026-08-24_A3F2B1C9.pdf')

  /** jsdom ships neither `share` nor `canShare`, so both are installed per test. */
  function installShare({ canShare, share }) {
    for (const [name, value] of Object.entries({ canShare, share })) {
      if (value === undefined) continue
      Object.defineProperty(navigator, name, { value, configurable: true, writable: true })
    }
  }

  afterEach(() => {
    for (const name of ['share', 'canShare']) {
      if (name in navigator) Reflect.deleteProperty(navigator, name)
    }
  })

  it('names the file so the recipient sees an invoice, not a blob', () => {
    const file = pdf()
    expect(file.name).toBe('Invoice_2026-08-24_A3F2B1C9.pdf')
    expect(file.type).toBe('application/pdf')
  })

  it('reports no file sharing on a browser without the Web Share API', () => {
    // Firefox and most desktop Linux. The caller opens the wa.me / t.me link with a text
    // summary there — it does not download, which would look like a broken button.
    expect(canShareFiles(pdf())).toBe(false)
  })

  it('reports no file sharing when share exists but files are unsupported', () => {
    // Older Safari: navigator.share is present for text but rejects files.
    installShare({ share: vi.fn(), canShare: () => false })
    expect(canShareFiles(pdf())).toBe(false)
  })

  it('reports no file sharing when canShare throws on the payload', () => {
    installShare({ share: vi.fn(), canShare: () => { throw new TypeError('bad payload') } })
    expect(canShareFiles(pdf())).toBe(false)
  })

  it('reports file sharing when the platform accepts the file', () => {
    installShare({ share: vi.fn(), canShare: () => true })
    expect(canShareFiles(pdf())).toBe(true)
  })

  it('passes the file itself to the share sheet', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    installShare({ share, canShare: () => true })

    const file = pdf()
    await expect(shareInvoiceFile({ file, title: 'Invoice', text: 'body' })).resolves.toBe('shared')
    expect(share).toHaveBeenCalledWith({ files: [file], title: 'Invoice', text: 'body' })
  })

  it('shares the file and title alone when there is no body', async () => {
    // The invoice path sends no text at all. `text: undefined` is not the same as no text —
    // some implementations validate the payload shape — so the key must be absent, not
    // present and empty.
    const share = vi.fn().mockResolvedValue(undefined)
    installShare({ share, canShare: () => true })

    const file = pdf()
    await shareInvoiceFile({ file, title: 'Invoice #A3F2B1C9' })

    expect(share).toHaveBeenCalledWith({ files: [file], title: 'Invoice #A3F2B1C9' })
    expect(Object.keys(share.mock.calls[0][0])).not.toContain('text')
  })

  it('calls navigator.share synchronously, inside the click gesture', () => {
    // Load-bearing: browsers decide whether a share is user-initiated from the call stack,
    // and an await anywhere before the call moves it to a microtask where Safari and Chrome
    // on Android reject it with NotAllowedError. Asserted by checking the call has already
    // happened before control returns — an `async` shareInvoiceFile would fail this.
    const share = vi.fn().mockResolvedValue(undefined)
    installShare({ share, canShare: () => true })

    shareInvoiceFile({ file: pdf(), title: 'Invoice #A3F2B1C9' })

    expect(share).toHaveBeenCalledTimes(1)
  })

  it('does not attempt a share the platform cannot do', async () => {
    const share = vi.fn()
    installShare({ share, canShare: () => false })

    await expect(shareInvoiceFile({ file: pdf() })).resolves.toBe('unsupported')
    expect(share).not.toHaveBeenCalled()
  })

  it('treats a dismissed share sheet as not an error', async () => {
    // The reader opened the sheet and changed their mind. Painting a failure over that
    // reports a broken feature to someone who just cancelled.
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' })
    installShare({ share: vi.fn().mockRejectedValue(abort), canShare: () => true })

    await expect(shareInvoiceFile({ file: pdf() })).resolves.toBe('dismissed')
  })

  it('reports a genuine failure so the caller can fall back', async () => {
    installShare({
      share: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
      canShare: () => true,
    })
    await expect(shareInvoiceFile({ file: pdf() })).resolves.toBe('error')
  })
})
