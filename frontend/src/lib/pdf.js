/**
 * A minimal PDF writer — enough to lay out an invoice, and nothing more.
 *
 * Why hand-rolled rather than jsPDF/pdf-lib: the entry bundle is already past Vite's 500 kB
 * warning, and the smallest credible combination for "render this invoice to PDF" is jsPDF
 * plus html2canvas at roughly half a megabyte — for a document whose content is text, rules
 * and filled rectangles. That is the whole feature surface used here, and PDF is a text
 * format, so the generator is smaller than the dependency's README.
 *
 * Scope, stated plainly so nobody reaches for this expecting a general library:
 *   - the standard 14 fonts only (no embedding, no subsetting)
 *   - WinAnsi/Latin-1 text (see `encodeLatin1`)
 *   - text, filled rectangles, no images, no transparency, no links
 *
 * Coordinates are given TOP-LEFT with y increasing downward, because that is how the layout
 * code thinks and how the HTML invoice it mirrors is written. PDF's own origin is
 * bottom-left; the flip happens in one place, `toPdfY`.
 */

const FONT_ALIASES = {
  regular: 'F1',
  bold: 'F2',
  mono: 'F3',
  monoBold: 'F4',
}

const FONT_BASES = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Courier',
  F4: 'Courier-Bold',
}

/**
 * Glyph advance widths per 1000 units of em, for ASCII 32..126, taken from the Adobe AFM
 * metrics for the standard fonts. Needed for right-aligning and for truncating a long
 * product name before it collides with the next column — without real widths, a name is
 * either clipped at a guessed character count or overlaps the Qty column, and both are
 * visible on every invoice with a long product name.
 *
 * Courier is monospaced at 600 throughout, so it needs no table.
 */
const HELVETICA_WIDTHS =
  '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 ' +
  '556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 ' +
  '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 ' +
  '667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 ' +
  '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 ' +
  '556 556 333 500 278 556 500 722 500 500 500 334 260 334 584'

const HELVETICA_BOLD_WIDTHS =
  '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 ' +
  '556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 ' +
  '975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 ' +
  '667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 ' +
  '333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 ' +
  '611 611 389 556 333 611 556 778 556 556 500 389 280 389 584'

const WIDTH_TABLES = {
  F1: HELVETICA_WIDTHS.trim().split(/\s+/).map(Number),
  F2: HELVETICA_BOLD_WIDTHS.trim().split(/\s+/).map(Number),
}

/**
 * Latin-1 with a substitution for everything else.
 *
 * The standard 14 fonts cannot represent a code point above 255 at all, and covering (say)
 * Arabic product names means embedding and subsetting a Unicode TTF — a font file plus a
 * subsetter, which is exactly the weight this module exists to avoid. Anything unmappable
 * therefore becomes '?', and the Print / Save PDF path stays the full-fidelity route for
 * non-Latin scripts because it renders through the browser's own text stack.
 *
 * A few punctuation marks that routinely appear in generated copy are folded to their ASCII
 * equivalents first, so an en dash does not become a '?' in the middle of a sentence.
 */
export function encodeLatin1(text) {
  return String(text ?? '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\xFF]/g, '?')
}

/** Escapes the three characters that terminate or nest a PDF literal string. */
export function escapePdfText(text) {
  return encodeLatin1(text).replace(/([\\()])/g, '\\$1')
}

/** Width of `text` in points at `size`, for one of the four fonts above. */
export function measureText(text, { font = 'regular', size = 10 } = {}) {
  const key = FONT_ALIASES[font] ?? font
  const encoded = encodeLatin1(text)
  const table = WIDTH_TABLES[key]

  let units = 0
  for (const char of encoded) {
    const code = char.charCodeAt(0)
    if (!table) {
      units += 600 // Courier is monospaced.
    } else {
      // Outside the tabulated ASCII range, the average lowercase advance is a far better
      // guess than zero — which would make a truncation check silently pass.
      units += code >= 32 && code <= 126 ? table[code - 32] : 556
    }
  }
  return (units / 1000) * size
}

/**
 * Shortens `text` until it fits `maxWidth`, appending an ellipsis. Returns it unchanged when
 * it already fits, so the common case costs one measurement.
 */
export function truncateToWidth(text, maxWidth, options = {}) {
  const encoded = encodeLatin1(text)
  if (measureText(encoded, options) <= maxWidth) return encoded

  let out = encoded
  while (out.length > 1 && measureText(`${out}...`, options) > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}...`
}

/** PDF wants a plain decimal; JS gives exponent notation for small numbers. */
function num(value) {
  return Number.parseFloat(value.toFixed(3)).toString()
}

function colorOps(hex) {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255)
  return `${num(r)} ${num(g)} ${num(b)}`
}

/**
 * Builds one document. `width`/`height` are in points; the default is A4.
 *
 * Returns a recorder — every call appends operators to the current page's content stream,
 * and `toBytes()`/`toBlob()` assemble the file. Nothing is validated lazily: an unclosed
 * state would surface as a corrupt file in a viewer, so the operators are emitted balanced.
 */
export function createPdfDocument({ width = 595.28, height = 841.89 } = {}) {
  const pages = []
  let current = null

  function addPage() {
    current = { ops: [] }
    pages.push(current)
    return current
  }
  addPage()

  const toPdfY = (y) => height - y

  const api = {
    width,
    height,
    addPage,
    get pageCount() {
      return pages.length
    },

    /** Draws `text` with its LEFT edge at x and its BASELINE at y. */
    text(value, x, y, { font = 'regular', size = 10, color = '#000000' } = {}) {
      const key = FONT_ALIASES[font] ?? font
      current.ops.push(
        'q',
        `${colorOps(color)} rg`,
        'BT',
        `/${key} ${num(size)} Tf`,
        `1 0 0 1 ${num(x)} ${num(toPdfY(y))} Tm`,
        `(${escapePdfText(value)}) Tj`,
        'ET',
        'Q',
      )
      return api
    },

    /** Same, but the text's RIGHT edge lands on x. */
    textRight(value, x, y, options = {}) {
      return api.text(value, x - measureText(value, options), y, options)
    },

    /** Same, but centred on x. */
    textCenter(value, x, y, options = {}) {
      return api.text(value, x - measureText(value, options) / 2, y, options)
    },

    /** Filled rectangle, y being its TOP edge. */
    rect(x, y, w, h, color = '#000000') {
      current.ops.push(
        'q',
        `${colorOps(color)} rg`,
        `${num(x)} ${num(toPdfY(y + h))} ${num(w)} ${num(h)} re`,
        'f',
        'Q',
      )
      return api
    },

    /** A horizontal rule, drawn as a thin rect so no stroke state has to be tracked. */
    line(x, y, w, { color = '#000000', thickness = 0.6 } = {}) {
      return api.rect(x, y, w, thickness, color)
    },

    toBytes() {
      return assemble({ pages, width, height })
    },

    toBlob() {
      return new Blob([api.toBytes()], { type: 'application/pdf' })
    },
  }

  return api
}

/**
 * Serialises the object graph and the cross-reference table.
 *
 * Byte offsets in the xref must be exact or viewers reject the file. Every string here is
 * Latin-1 by construction (see `encodeLatin1`), so one character is one byte and
 * `String.length` is the byte length — which is what makes the running offset correct
 * without encoding each chunk twice.
 */
function assemble({ pages, width, height }) {
  const fontIds = Object.keys(FONT_BASES)
  const firstPageId = 3
  const objectCount = 2 + pages.length * 2 + fontIds.length

  const fontStartId = firstPageId + pages.length * 2
  const fontRefs = fontIds
    .map((key, i) => `/${key} ${fontStartId + i} 0 R`)
    .join(' ')

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'

  const kids = pages.map((_, i) => `${firstPageId + i * 2} 0 R`).join(' ')
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`

  pages.forEach((page, i) => {
    const pageId = firstPageId + i * 2
    const contentId = pageId + 1
    const stream = page.ops.join('\n')
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ` +
      `/Resources << /Font << ${fontRefs} >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  fontIds.forEach((key, i) => {
    objects[fontStartId + i] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_BASES[key]} /Encoding /WinAnsiEncoding >>`
  })

  let file = '%PDF-1.4\n'
  const offsets = []
  for (let id = 1; id <= objectCount; id += 1) {
    offsets[id] = file.length
    file += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }

  const xrefStart = file.length
  file += `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= objectCount; id += 1) {
    file += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  file += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  const bytes = new Uint8Array(file.length)
  for (let i = 0; i < file.length; i += 1) bytes[i] = file.charCodeAt(i) & 0xff
  return bytes
}
