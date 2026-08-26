import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BrandMark } from './BrandMark'

/**
 * One logo, three drawings. The SPA component is checked against the favicon source the
 * same way invoicePrint.test.js checks the stylesheet — the risk here is not that the
 * component breaks, it is that one of the three is updated and the others quietly are not.
 */
const favicon = readFileSync(resolve(process.cwd(), 'public/favicon-v2.svg'), 'utf8')
const source = readFileSync(resolve(process.cwd(), 'src/components/ui/BrandMark.jsx'), 'utf8')

describe('BrandMark', () => {
  it('carries an accessible name by default', () => {
    render(<BrandMark />)
    expect(screen.getByRole('img', { name: 'IMS' })).toBeInTheDocument()
  })

  it('is hidden from assistive tech when it has no title', () => {
    const { container } = render(<BrandMark title={null} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
  })

  it('scales from one size prop, keeping the 32-unit viewBox', () => {
    const { container } = render(<BrandMark size={56} />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('width', '56')
    expect(svg).toHaveAttribute('height', '56')
    expect(svg).toHaveAttribute('viewBox', '0 0 32 32')
  })

  it('gives every instance its own gradient id', () => {
    // Two marks sharing one id is a duplicate DOM id, and the second instance then resolves
    // url(#…) against the first one's definition — which is invisible until the first mark
    // unmounts and the second loses its fill. The dock and a page header can both be
    // mounted at once, so this is reachable.
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark />
      </>,
    )
    const ids = [...container.querySelectorAll('linearGradient')].map((node) => node.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      // Must be usable inside url(#…): React 19's useId emits «r0», whose delimiters are not.
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
    }
  })

  it('draws the same mark as the favicon', () => {
    for (const colour of ['#3B82F6', '#1D4ED8', '#FFFFFF', '#BFDBFE', '#7FA9F5']) {
      expect(favicon).toContain(colour)
      expect(source).toContain(colour)
    }
    // The bar geometry is the silhouette; a mismatch here is a different logo at a glance.
    for (const bar of [
      { x: '7', y: '9', width: '18' },
      { x: '7', y: '15', width: '14' },
      { x: '7', y: '21', width: '10' },
    ]) {
      const pattern = new RegExp(`x="${bar.x}"\\s+y="${bar.y}"\\s+width="${bar.width}"`)
      expect(favicon).toMatch(pattern)
      expect(source).toMatch(pattern)
    }
  })

  it('renders inline rather than fetching the favicon over the network', () => {
    // An <img src="/favicon-v2.svg"> cannot inherit a size or currentColor, costs a request,
    // and flashes in late on the sign-in card.
    const { container } = render(<BrandMark />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
