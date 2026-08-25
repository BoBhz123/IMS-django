import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canShareFiles,
  makeInvoiceFile,
  paymentLabel,
  shareInvoiceFile,
} from './invoiceShare'

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
    // Firefox and most desktop Linux. The caller downloads the PDF there rather than
    // opening a share URL, which could not carry the file anyway.
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
