import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildShareSummary,
  canShareFiles,
  makeInvoiceFile,
  paymentLabel,
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

describe('the text fallback', () => {
  const base = { reference: 'A3F2B1C9', sellerName: 'Acme Trading', total: 148, formatPrimary: usd }

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

  it('never carries a URL back into the app', () => {
    // The summary is the whole message on the fallback path, so a link smuggled in here
    // would reach exactly the recipients the change was meant to stop sending links to.
    expect(buildShareSummary(base)).not.toMatch(/http|myimsapp/)
  })

  it('encodes the whole summary into wa.me', () => {
    expect(whatsappShareUrl('Invoice #A3F2 · Total: $10.00'))
      .toBe('https://wa.me/?text=Invoice%20%23A3F2%20%C2%B7%20Total%3A%20%2410.00')
  })

  it('sends the summary to telegram as text with an empty url', () => {
    const params = new URLSearchParams(telegramShareUrl('Invoice #A3F2').split('?')[1])
    expect(params.get('text')).toBe('Invoice #A3F2')
    expect(params.get('url')).toBe('')
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
