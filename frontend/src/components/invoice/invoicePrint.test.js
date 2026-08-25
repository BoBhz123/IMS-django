import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Print layout asserted against the stylesheet source, not by rendering.
 *
 * jsdom implements no layout and paints nothing, so a print rule cannot be observed by
 * mounting the invoice — `getBoundingClientRect` returns zeroes whether the rule is present
 * or not. Browser automation is not available in this project either, so the structural
 * invariants are checked the same way AppShell.test.jsx checks its clipping rule, and the
 * visual confirmation across real printers stays the owner's.
 */
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

const printBlock = css.slice(css.indexOf('@media print'))

describe('invoice print rules', () => {
  it('keeps the page box at zero margin', () => {
    // Load-bearing, and the thing most likely to be "tidied" into a normal-looking 10mm:
    // a non-zero @page margin hands Chrome and Safari back their default headers and
    // footers, which prints the source URL and a timestamp onto a customer's invoice.
    // The 10mm is supplied by .invoice-print's own padding instead — same geometry, no
    // browser chrome.
    const pageRule = printBlock.slice(printBlock.indexOf('@page'))
    expect(pageRule).toMatch(/@page\s*{[^}]*margin:\s*0;/)
  })

  it('supplies the paper margin from the invoice itself', () => {
    expect(printBlock).toMatch(/padding:\s*10mm;/)
  })

  it('sets print type in points rather than inheriting screen pixels', () => {
    // px is resolved against an assumed 96dpi by the print renderer, so it produces
    // whatever size that happened to be rather than a size chosen for paper.
    expect(printBlock).toMatch(/font-size:\s*[\d.]+pt\s*!important/)
  })

  it('compacts row padding, which is what decides how many lines fit a sheet', () => {
    expect(printBlock).toMatch(/padding-top:\s*[\d.]+mm\s*!important/)
    expect(printBlock).toMatch(/padding-bottom:\s*[\d.]+mm\s*!important/)
  })

  it('scales the on-screen preview inside a screen-only query', () => {
    // Inside @media screen, or the scale would follow the document onto paper and print
    // the invoice at 88%.
    const screenBlock = css.slice(css.indexOf('@media screen'))
    expect(screenBlock).toMatch(/\.invoice-preview\s*{[^}]*zoom:/)
  })

  it('scales with zoom rather than a transform', () => {
    // A transform scales the painted result but leaves the layout box at full height, so
    // the modal keeps reserving the unscaled space and the saving becomes empty room below
    // the invoice instead of more visible rows.
    const screenBlock = css.slice(css.indexOf('@media screen'))
    const previewRule = screenBlock.slice(
      screenBlock.indexOf('.invoice-preview'),
      screenBlock.indexOf('.invoice-preview') + 120,
    )
    expect(previewRule).not.toMatch(/transform:\s*scale/)
  })
})
