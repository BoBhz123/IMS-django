import { describe, expect, it } from 'vitest'
import {
  buildShareMessage, paymentLabel, telegramShareUrl, whatsappShareUrl,
} from './invoiceShare'

const usd = (value) => `$${Number(value).toFixed(2)}`

const base = {
  reference: 'A3F2B1C9',
  sellerName: 'Acme Trading',
  total: 148,
  itemCount: 3,
  shareUrl: 'https://myimsapp.com/i/tok3n',
  formatPrimary: usd,
}

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

describe('buildShareMessage', () => {
  it('states the balance still owing on a partial payment', () => {
    const message = buildShareMessage({
      ...base, paymentStatus: 'PARTIALLY_PAID', paidAmount: 100, remainingAmount: 48,
    })
    expect(message).toContain('PARTIALLY PAID · Paid $100.00 · Balance $48.00')
    expect(message).toContain('3 items · Total $148.00')
    expect(message).toContain('https://myimsapp.com/i/tok3n')
  })

  it('does not print a balance line for a paid invoice', () => {
    const message = buildShareMessage({
      ...base, paymentStatus: 'PAID', paidAmount: 148, remainingAmount: 0,
    })
    expect(message).toContain('PAID · $148.00')
    expect(message).not.toContain('Balance')
  })

  it('includes the converted total only when dual currency is on', () => {
    const dual = buildShareMessage({
      ...base, paymentStatus: 'UNPAID', remainingAmount: 148,
      formatSecondary: () => '13,172,000 LBP',
    })
    expect(dual).toContain('(13,172,000 LBP)')

    const single = buildShareMessage({ ...base, paymentStatus: 'UNPAID', remainingAmount: 148 })
    expect(single).not.toContain('LBP')
  })

  it('says "item" for a single line', () => {
    const message = buildShareMessage({
      ...base, itemCount: 1, paymentStatus: 'UNPAID', remainingAmount: 148,
    })
    expect(message).toContain('1 item ·')
  })

  it('omits the link when the invoice has not been shared', () => {
    const message = buildShareMessage({
      ...base, shareUrl: null, paymentStatus: 'UNPAID', remainingAmount: 148,
    })
    expect(message).not.toContain('http')
  })
})

describe('share links', () => {
  it('encodes the whole message into wa.me, newlines included', () => {
    const url = whatsappShareUrl('Invoice A3F2\nTotal $10.00')
    expect(url).toBe('https://wa.me/?text=Invoice%20A3F2%0ATotal%20%2410.00')
  })

  it('sends url and text as separate telegram parameters', () => {
    const url = telegramShareUrl('Invoice A3F2', 'https://myimsapp.com/i/tok3n')
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('url')).toBe('https://myimsapp.com/i/tok3n')
    expect(params.get('text')).toBe('Invoice A3F2')
  })

  it('still builds a telegram link with nothing to link to', () => {
    expect(telegramShareUrl('Invoice A3F2', null)).toContain('text=Invoice+A3F2')
  })
})
