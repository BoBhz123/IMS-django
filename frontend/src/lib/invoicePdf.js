/**
 * Lays an invoice out as a PDF, mirroring what `components/invoice/Invoice.jsx` renders.
 *
 * Kept out of React for the same reason the component takes its currency settings as props:
 * this is a document, not a screen. It is pure data in, bytes out, so the layout can be
 * exercised without a DOM — which matters here because the alternative way to check a PDF is
 * to open one, and browser automation is not available in this project.
 *
 * Formatters are injected rather than imported so the document renders in whatever currency
 * the account is configured for, and omits the conversion lines entirely when dual display is
 * off — `formatSecondary` returns null in that mode, exactly as it does on screen.
 */

import { createPdfDocument, measureText, truncateToWidth } from '@/lib/pdf'
import { paymentLabel } from '@/lib/invoiceShare'

const PAGE = { width: 595.28, height: 841.89 }
const MARGIN = 40
const RIGHT = PAGE.width - MARGIN
const CONTENT_WIDTH = RIGHT - MARGIN

// Mirrors the on-screen palette so a printed PDF and the modal are recognisably one document.
const INK = {
  accent: '#4F46E5',
  ink: '#0F172A',
  body: '#334155',
  muted: '#64748B',
  faint: '#94A3B8',
  hairline: '#E2E8F0',
  zebra: '#F1F5F9',
  white: '#FFFFFF',
  paid: '#0F9D58',
  partial: '#B45309',
  unpaid: '#DC2626',
}

const COLS = {
  index: MARGIN,
  name: MARGIN + 22,
  nameWidth: 242,
  qtyRight: MARGIN + 317,
  unitRight: MARGIN + 412,
  totalRight: RIGHT,
}

const ROW_HEIGHT = 17
const TABLE_HEADER_HEIGHT = 20
// Where a fresh page's table may start, and the last y a row may occupy before one is needed.
const BODY_TOP = MARGIN + 8
const BODY_BOTTOM = PAGE.height - MARGIN - 28

const STAMP_COLOR = {
  PAID: INK.paid,
  PARTIALLY_PAID: INK.partial,
  UNPAID: INK.unpaid,
}

/** Four thin filled rects — the primitive layer draws fills only, by design. */
function strokeRect(doc, x, y, w, h, color, thickness = 1.2) {
  doc.rect(x, y, w, thickness, color)
  doc.rect(x, y + h - thickness, w, thickness, color)
  doc.rect(x, y, thickness, h, color)
  doc.rect(x + w - thickness, y, thickness, h, color)
}

function drawTableHeader(doc, y) {
  doc.rect(MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, INK.accent)
  const baseline = y + 13.5
  const opts = { font: 'bold', size: 8, color: INK.white }
  doc.text('#', COLS.index + 6, baseline, opts)
  doc.text('ITEMS', COLS.name, baseline, opts)
  doc.textRight('QTY', COLS.qtyRight, baseline, opts)
  doc.textRight('UNIT COST', COLS.unitRight, baseline, opts)
  doc.textRight('TOTAL', COLS.totalRight - 6, baseline, opts)
  return y + TABLE_HEADER_HEIGHT
}

/**
 * Builds the document.
 *
 * Returns the `Uint8Array`; callers wanting a file use `invoicePdfBlob`, which is what the
 * share and download paths take.
 */
export function buildInvoicePdf({
  documentType = 'Invoice',
  reference,
  placedAt,
  seller = {},
  partyLabel = 'customer',
  partyName = '',
  partyPhone = '',
  partyLocation = '',
  rows = [],
  paymentStatus = null,
  paidAmount = 0,
  remainingAmount = 0,
  secondaryCode = 'LBP',
  formatPrimary,
  formatSecondary = () => null,
  formatDate = (v) => String(v ?? ''),
  tagline = '',
  footerNote = '',
}) {
  const doc = createPdfDocument(PAGE)

  // --- letterhead -------------------------------------------------------------------------
  let y = MARGIN + 4
  doc.text(truncateToWidth(seller.name || 'IMS', 300, { font: 'bold', size: 15 }), MARGIN, y + 11, {
    font: 'bold',
    size: 15,
    color: INK.ink,
  })

  let sellerY = y + 25
  if (seller.phone) {
    doc.text(seller.phone, MARGIN, sellerY, { font: 'mono', size: 8.5, color: INK.muted })
    sellerY += 11
  }
  if (seller.email) {
    doc.text(truncateToWidth(seller.email, 260, { size: 8.5 }), MARGIN, sellerY, {
      size: 8.5,
      color: INK.muted,
    })
  }

  doc.textRight(documentType.toUpperCase(), RIGHT, y + 12, {
    font: 'bold',
    size: 17,
    color: INK.accent,
  })
  doc.textRight(`#${reference}`, RIGHT, y + 26, { font: 'monoBold', size: 9.5, color: INK.ink })
  doc.textRight(formatDate(placedAt), RIGHT, y + 38, { size: 8.5, color: INK.muted })

  y += 52
  doc.rect(MARGIN, y, CONTENT_WIDTH, 1.6, INK.accent)

  // --- bill to ----------------------------------------------------------------------------
  y += 18
  doc.text('BILL TO', MARGIN, y, { font: 'bold', size: 7.5, color: INK.faint })
  y += 13
  doc.text(
    truncateToWidth(partyName || `Walk-in ${partyLabel.toLowerCase()}`, 300, {
      font: 'bold',
      size: 11,
    }),
    MARGIN,
    y,
    { font: 'bold', size: 11, color: INK.ink },
  )

  let partyY = y + 12
  if (partyLocation) {
    doc.text(truncateToWidth(partyLocation, 300, { size: 8.5 }), MARGIN, partyY, {
      size: 8.5,
      color: INK.muted,
    })
    partyY += 11
  }
  if (partyPhone) {
    doc.text(partyPhone, MARGIN, partyY, { font: 'mono', size: 8.5, color: INK.muted })
    partyY += 11
  }
  if (!partyLocation && !partyPhone) {
    doc.text('No address on file', MARGIN, partyY, { size: 8.5, color: INK.faint })
    partyY += 11
  }

  // --- line items -------------------------------------------------------------------------
  y = Math.max(partyY, y + 14) + 12
  y = drawTableHeader(doc, y)

  rows.forEach((row, index) => {
    if (y + ROW_HEIGHT > BODY_BOTTOM) {
      doc.addPage()
      y = drawTableHeader(doc, BODY_TOP)
    }

    if (index % 2 === 1) doc.rect(MARGIN, y, CONTENT_WIDTH, ROW_HEIGHT, INK.zebra)
    const baseline = y + 11.5

    doc.text(String(index + 1), COLS.index + 6, baseline, { font: 'mono', size: 8.5, color: INK.faint })
    doc.text(
      truncateToWidth(row.name, COLS.nameWidth, { size: 9 }),
      COLS.name,
      baseline,
      { size: 9, color: INK.ink },
    )
    doc.textRight(String(row.quantity), COLS.qtyRight, baseline, {
      font: 'mono',
      size: 8.5,
      color: INK.body,
    })
    doc.textRight(formatPrimary(row.unitPrice), COLS.unitRight, baseline, {
      font: 'mono',
      size: 8.5,
      color: INK.body,
    })
    doc.textRight(formatPrimary(row.lineTotal), COLS.totalRight - 6, baseline, {
      font: 'monoBold',
      size: 8.5,
      color: INK.ink,
    })

    doc.rect(MARGIN, y + ROW_HEIGHT - 0.5, CONTENT_WIDTH, 0.5, INK.hairline)
    y += ROW_HEIGHT
  })

  // --- totals -----------------------------------------------------------------------------
  const subtotal = rows.reduce((sum, row) => sum + row.lineTotal, 0)
  const total = subtotal

  // The totals block, the stamp and the footer are one unit: splitting a total away from its
  // own invoice across a page break is the one break a reader cannot recover from.
  const tailHeight = 58 + (paymentStatus ? 46 : 0) + (tagline || footerNote ? 34 : 0)
  if (y + tailHeight > BODY_BOTTOM) {
    doc.addPage()
    y = BODY_TOP
  }

  y += 14
  const labelX = RIGHT - 190

  doc.text('Subtotal', labelX, y, { size: 9, color: INK.muted })
  doc.textRight(formatPrimary(subtotal), RIGHT, y, { font: 'mono', size: 9, color: INK.ink })
  y += 12

  const secondarySubtotal = formatSecondary(subtotal)
  if (secondarySubtotal) {
    doc.text(`Subtotal (${secondaryCode})`, labelX, y, { size: 7.5, color: INK.faint })
    doc.textRight(secondarySubtotal, RIGHT, y, { font: 'mono', size: 7.5, color: INK.muted })
    y += 12
  }

  y += 3
  doc.rect(labelX, y, RIGHT - labelX, 1.2, INK.ink)
  y += 14
  doc.text('TOTAL', labelX, y, { font: 'bold', size: 11, color: INK.ink })
  doc.textRight(formatPrimary(total), RIGHT, y, { font: 'monoBold', size: 11, color: INK.ink })
  y += 13

  const secondaryTotal = formatSecondary(total)
  if (secondaryTotal) {
    doc.text(`Total (${secondaryCode})`, labelX, y, { size: 8, color: INK.faint })
    doc.textRight(secondaryTotal, RIGHT, y, { font: 'mono', size: 8, color: INK.body })
    y += 12
  }

  // --- payment stamp ----------------------------------------------------------------------
  if (paymentStatus) {
    y += 10
    const color = STAMP_COLOR[paymentStatus] ?? INK.unpaid
    const label = paymentLabel(paymentStatus)
    const lines = []
    if (paymentStatus !== 'UNPAID') lines.push(`Paid ${formatPrimary(paidAmount)}`)
    if (paymentStatus !== 'PAID') lines.push(`Balance ${formatPrimary(remainingAmount)}`)

    const labelWidth = measureText(label, { font: 'bold', size: 13 })
    const linesWidth = Math.max(
      0,
      ...lines.map((line) => measureText(line, { font: 'mono', size: 8 })),
    )
    const boxWidth = Math.max(labelWidth, linesWidth) + 24
    const boxHeight = 22 + lines.length * 11
    const boxX = RIGHT - boxWidth

    strokeRect(doc, boxX, y, boxWidth, boxHeight, color, 1.6)
    doc.textCenter(label, boxX + boxWidth / 2, y + 15, { font: 'bold', size: 13, color })
    lines.forEach((line, i) => {
      doc.textCenter(line, boxX + boxWidth / 2, y + 27 + i * 11, {
        font: 'mono',
        size: 8,
        color,
      })
    })
    y += boxHeight
  }

  // --- footer -----------------------------------------------------------------------------
  if (tagline || footerNote) {
    y += 20
    doc.rect(MARGIN, y, CONTENT_WIDTH, 0.5, INK.hairline)
    y += 14
    if (tagline) {
      doc.textCenter(tagline, MARGIN + CONTENT_WIDTH / 2, y, {
        font: 'bold',
        size: 9,
        color: INK.body,
      })
      y += 12
    }
    if (footerNote) {
      doc.textCenter(footerNote, MARGIN + CONTENT_WIDTH / 2, y, { size: 7.5, color: INK.faint })
    }
  }

  return doc.toBytes()
}

/** The same document as a `Blob`, ready for `File`, `navigator.share` or a download. */
export function invoicePdfBlob(options) {
  return new Blob([buildInvoicePdf(options)], { type: 'application/pdf' })
}
