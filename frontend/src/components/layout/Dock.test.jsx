import { describe, expect, it } from 'vitest'
import { NAV_ITEMS } from './Dock'

describe('NAV_ITEMS', () => {
  it('does not carry Settings', () => {
    // Settings lives behind the account dropdown, not in the primary rail. The dropdown is
    // rendered twice — in the Dock for desktop and in WindowChrome for mobile — so removing
    // it here does not strand /settings on any viewport.
    expect(NAV_ITEMS.map((item) => item.to)).not.toContain('/settings')
  })

  it('still carries every business section', () => {
    expect(NAV_ITEMS.map((item) => item.to)).toEqual([
      '/', '/products', '/categories', '/orders', '/purchases', '/expenses',
      '/customers', '/suppliers',
    ])
  })

  it('gives every item a label and an icon for the aria-label and tooltip', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy()
      expect(item.icon).toBeTruthy()
    }
  })
})
