import { describe, expect, it } from 'vitest'
import {
  createPdfDocument,
  encodeLatin1,
  escapePdfText,
  measureText,
  truncateToWidth,
} from '@/lib/pdf'

/** The content streams are uncompressed, so the file can be read back as Latin-1 text. */
function asText(bytes) {
  return Array.from(bytes, (b) => String.fromCharCode(b)).join('')
}

describe('encodeLatin1', () => {
  it('keeps accented Latin, which is most of what product names carry', () => {
    expect(encodeLatin1('Nescafé Crème')).toBe('Nescafé Crème')
  })

  it('folds typographic punctuation to ASCII rather than dropping it', () => {
    // An en dash arriving as '?' mid-sentence is worse than a hyphen.
    expect(encodeLatin1('a — b')).toBe('a - b')
    expect(encodeLatin1('it’s “quoted”')).toBe('it\'s "quoted"')
    expect(encodeLatin1('more…')).toBe('more...')
  })

  it('substitutes anything the standard fonts cannot represent', () => {
    // Documented limitation: no font embedding, so non-Latin scripts cannot render. The
    // substitution is deliberate and the Print path stays the route for those.
    expect(encodeLatin1('حليب')).toBe('????')
  })
})

describe('escapePdfText', () => {
  it('escapes the characters that would terminate a PDF string', () => {
    expect(escapePdfText('a(b)c\\d')).toBe('a\\(b\\)c\\\\d')
  })

  it('leaves ordinary text alone', () => {
    expect(escapePdfText('Sunflower oil 1.8L')).toBe('Sunflower oil 1.8L')
  })
})

describe('measureText', () => {
  it('measures Courier at exactly 0.6em per character', () => {
    expect(measureText('123456', { font: 'mono', size: 10 })).toBeCloseTo(36, 5)
  })

  it('gives proportional widths for Helvetica', () => {
    // 'i' is narrow and 'W' is wide; a table that was mis-indexed would make these equal.
    expect(measureText('i', { size: 10 })).toBeLessThan(measureText('W', { size: 10 }))
    expect(measureText('W', { size: 10 })).toBeCloseTo(9.44, 2)
    expect(measureText('i', { size: 10 })).toBeCloseTo(2.22, 2)
  })

  it('scales linearly with size', () => {
    expect(measureText('Total', { size: 20 })).toBeCloseTo(measureText('Total', { size: 10 }) * 2, 5)
  })

  it('measures bold wider than regular for the same string', () => {
    expect(measureText('Balance', { font: 'bold', size: 10 })).toBeGreaterThan(
      measureText('Balance', { size: 10 }),
    )
  })
})

describe('truncateToWidth', () => {
  it('returns a string that already fits unchanged, with no ellipsis', () => {
    expect(truncateToWidth('Black tea', 200, { size: 9 })).toBe('Black tea')
  })

  it('truncates to something that actually fits the budget', () => {
    const long = 'Basmati rice premium extra long grain imported 5kg sack'
    const out = truncateToWidth(long, 60, { size: 9 })

    expect(out.endsWith('...')).toBe(true)
    // The point of measuring rather than guessing a character count: the result has to fit,
    // or the name overlaps the next column on the printed invoice.
    expect(measureText(out, { size: 9 })).toBeLessThanOrEqual(60)
  })
})

describe('createPdfDocument', () => {
  it('produces a file with a PDF header and terminator', () => {
    const doc = createPdfDocument()
    doc.text('Hello', 40, 40)
    const text = asText(doc.toBytes())

    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  it('writes an xref offset that points at the xref table', () => {
    // A wrong offset here is the classic way a hand-built PDF opens in one viewer and is
    // rejected by another, so it is checked arithmetically rather than by eye.
    const doc = createPdfDocument()
    doc.text('Hello', 40, 40)
    const text = asText(doc.toBytes())

    const startxref = Number(text.match(/startxref\n(\d+)/)[1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
  })

  it('declares a stream length matching the actual stream bytes', () => {
    const doc = createPdfDocument()
    doc.text('Hello', 40, 40).rect(0, 0, 10, 10, '#FF0000')
    const text = asText(doc.toBytes())

    // Captured with one regex rather than split('stream\n'), which also matches inside
    // 'endstream' and silently hands back four extra characters.
    const [, declared, body] = text.match(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/)
    expect(body.length).toBe(Number(declared))
  })

  it('counts pages in the page tree', () => {
    const doc = createPdfDocument()
    doc.text('one', 40, 40)
    doc.addPage()
    doc.text('two', 40, 40)

    expect(doc.pageCount).toBe(2)
    expect(asText(doc.toBytes())).toContain('/Count 2')
  })

  it('escapes text on the way into the content stream', () => {
    const doc = createPdfDocument()
    doc.text('Rice (5kg)', 40, 40)
    expect(asText(doc.toBytes())).toContain('(Rice \\(5kg\\)) Tj')
  })

  it('hands back a blob typed as a PDF', () => {
    const doc = createPdfDocument()
    doc.text('Hello', 40, 40)
    const blob = doc.toBlob()

    expect(blob.type).toBe('application/pdf')
    expect(blob.size).toBeGreaterThan(0)
  })

  it('right-aligns by placing the text end at the anchor', () => {
    const doc = createPdfDocument()
    doc.textRight('$10.00', 500, 100, { font: 'mono', size: 10 })
    const text = asText(doc.toBytes())

    // 6 characters of Courier at 10pt is 36pt wide, so the left edge must be 500 - 36.
    expect(text).toContain('1 0 0 1 464 ')
  })
})
