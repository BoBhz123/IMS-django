import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A source-level guard, deliberately.
 *
 * The bug this protects against is *visual clipping*, and jsdom implements no layout or
 * painting — `getBoundingClientRect` returns zeroes and nothing is ever actually clipped. A
 * test that rendered the shell and asserted "the popover is visible" would pass just as
 * happily with the bug present, which is worse than no test at all.
 *
 * What can be checked honestly is the structural invariant that caused it: the card every page
 * renders inside must not establish a clipping context.
 */
// Resolved from the Vitest root rather than import.meta.url — Vitest rewrites import.meta in
// transformed modules, and the rewritten value is not a file: URL.
const source = readFileSync(
  resolve(process.cwd(), 'src/components/layout/AppShell.jsx'),
  'utf8',
)

/** The line declaring the max-w-6xl window card that wraps WindowChrome + the page outlet. */
function windowCardClasses() {
  const match = source.match(/className="([^"]*max-w-6xl[^"]*)"/)
  if (!match) throw new Error('could not find the max-w-6xl window card in AppShell.jsx')
  return match[1]
}

describe('AppShell overflow', () => {
  it('does not clip content floated out of a page', () => {
    // `overflow-hidden` here sliced the filter popover off at the card's bottom border whenever
    // the table underneath was shorter than the open panel. Border-radius already clips this
    // card's own background and border, and nothing inside paints a background of its own, so
    // overflow-hidden bought nothing and cost every popover on every page.
    expect(windowCardClasses()).not.toMatch(/\boverflow-hidden\b/)
  })

  it('keeps the card rounded, which is what overflow-hidden was there for', () => {
    expect(windowCardClasses()).toMatch(/\brounded-squircle\b/)
  })

  it('contains the ambient background on the x axis only', () => {
    // The root clipped both axes. Horizontal clipping is load-bearing — the blurred blobs are
    // wider than the viewport and would otherwise scroll — but the vertical axis has to stay
    // open for the same reason as the card above.
    expect(source).toMatch(/min-h-screen overflow-x-hidden/)
    expect(source).not.toMatch(/min-h-screen overflow-hidden/)
  })
})
