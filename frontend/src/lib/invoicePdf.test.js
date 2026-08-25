import { describe, expect, it } from 'vitest'
import { buildInvoicePdf, invoicePdfBlob } from '@/lib/invoicePdf'

function asText(bytes) {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('')
}

function makeRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `Product ${i + 1}`,
    quantity: 2,
    unitPrice: 5,
    lineTotal: 10,
  }))
}

const BASE = {
  documentType: 'Invoice',
  reference: 'C7BD9F4A',
  placedAt: '2026-08-24T10:00:00Z',
  seller: { name: 'Corner Shop', phone: '+961 71 234 567', email: 'sales@corner.lb' },
  partyLabel: 'Customer',
  partyName: 'Mahmoud Haidar',
  rows: makeRows(3),
  formatPrimary: (v) => `$${v.toFixed(2)}`,
  formatSecondary: () => null,
  formatDate: () => 'Aug 24, 2026',
  tagline: 'Thank you for your business',
  footerNote: 'Goods remain the property of the seller.',
}

describe('buildInvoicePdf', () => {
  it('renders a valid PDF', () => {
    const text = asText(buildInvoicePdf(BASE))
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('carries the parties, the reference and the line items', () => {
    const text = asText(buildInvoicePdf(BASE))

    expect(text).toContain('(Corner Shop) Tj')
    expect(text).toContain('(Mahmoud Haidar) Tj')
    expect(text).toContain('(#C7BD9F4A) Tj')
    expect(text).toContain('(Product 1) Tj')
    expect(text).toContain('(Product 3) Tj')
  })

  it('totals the lines rather than trusting a passed-in figure', () => {
    // 3 lines at 10 each. The document computes this the same way the component does.
    expect(asText(buildInvoicePdf(BASE))).toContain('($30.00) Tj')
  })

  it('names the party label when there is no customer on the record', () => {
    const text = asText(buildInvoicePdf({ ...BASE, partyName: '' }))
    expect(text).toContain('(Walk-in customer) Tj')
  })

  it('says so when no address is on file', () => {
    const text = asText(buildInvoicePdf({ ...BASE, partyPhone: '', partyLocation: '' }))
    expect(text).toContain('(No address on file) Tj')
  })

  // --- currency -----------------------------------------------------------------------------

  it('omits the conversion lines when dual display is off', () => {
    // formatSecondary returning null is how the whole app expresses "single currency"; the
    // document must not print an empty or zero conversion line in that mode.
    const text = asText(buildInvoicePdf(BASE))
    expect(text).not.toContain('Subtotal (')
    expect(text).not.toContain('Total (')
  })

  it('prints the conversion lines when dual display is on', () => {
    const text = asText(
      buildInvoicePdf({
        ...BASE,
        secondaryCode: 'LBP',
        formatSecondary: (v) => `${v * 89000} LBP`,
      }),
    )
    expect(text).toContain('(Subtotal \\(LBP\\)) Tj')
    expect(text).toContain('(Total \\(LBP\\)) Tj')
  })

  // --- payment ------------------------------------------------------------------------------

  it('stamps a partial payment with both figures', () => {
    const text = asText(
      buildInvoicePdf({
        ...BASE,
        paymentStatus: 'PARTIALLY_PAID',
        paidAmount: 20,
        remainingAmount: 10,
      }),
    )
    expect(text).toContain('(PARTIALLY PAID) Tj')
    expect(text).toContain('(Paid $20.00) Tj')
    expect(text).toContain('(Balance $10.00) Tj')
  })

  it('does not print a balance on a fully paid invoice', () => {
    const text = asText(
      buildInvoicePdf({ ...BASE, paymentStatus: 'PAID', paidAmount: 30, remainingAmount: 0 }),
    )
    expect(text).toContain('(PAID) Tj')
    expect(text).not.toContain('(Balance ')
  })

  it('does not print an amount paid on an unpaid invoice', () => {
    const text = asText(
      buildInvoicePdf({ ...BASE, paymentStatus: 'UNPAID', paidAmount: 0, remainingAmount: 30 }),
    )
    expect(text).toContain('(UNPAID) Tj')
    expect(text).not.toContain('(Paid ')
  })

  it('renders no stamp at all when the payload carries no status', () => {
    const text = asText(buildInvoicePdf(BASE))
    expect(text).not.toContain('(UNPAID) Tj')
    expect(text).not.toContain('(PAID) Tj')
  })

  // --- pagination ---------------------------------------------------------------------------

  it('stays on one page for a short invoice', () => {
    expect(asText(buildInvoicePdf(BASE))).toContain('/Count 1')
  })

  it('breaks onto further pages rather than running off the sheet', () => {
    const text = asText(buildInvoicePdf({ ...BASE, rows: makeRows(60) }))
    expect(text).toContain('/Count 2')
    // The header is redrawn, or the continuation columns are unlabelled.
    expect(text.match(/\(ITEMS\) Tj/g)).toHaveLength(2)
  })

  it('renders the totals block exactly once when the rows fill a page', () => {
    // A row count chosen to land the totals right at the bottom margin, which is where a
    // tail that is measured wrong duplicates or drops it. Asserted on 'Subtotal' rather than
    // 'TOTAL', which is also a column heading and so appears once per page of the table.
    const text = asText(buildInvoicePdf({ ...BASE, rows: makeRows(41) }))
    expect(text.match(/\(Subtotal\) Tj/g)).toHaveLength(1)
  })

  it('truncates a name too long for its column', () => {
    const text = asText(
      buildInvoicePdf({
        ...BASE,
        rows: [
          {
            name: 'Basmati rice premium extra long grain imported from India in a 5kg woven sack',
            quantity: 1,
            unitPrice: 5,
            lineTotal: 5,
          },
        ],
      }),
    )
    expect(text).toContain('...) Tj')
    expect(text).not.toContain('woven sack) Tj')
  })
})

describe('invoicePdfBlob', () => {
  it('is a PDF-typed blob', () => {
    const blob = invoicePdfBlob(BASE)
    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(500)
  })
})
