import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupByBarcode } from '@/hooks/useBarcodeLookup'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...args) => get(...args) } }))

describe('lookupByBarcode', () => {
  // Braces, not a concise arrow: mockReset() returns the mock, and Vitest treats a function
  // returned from a hook as a teardown callback — it would call get() after every test,
  // firing the rejecting implementation below with nobody awaiting it.
  beforeEach(() => {
    get.mockReset()
  })

  it('queries the exact-match filter, not the fuzzy search', async () => {
    get.mockResolvedValue({ data: { count: 1, results: [{ id: 1 }] } })
    await lookupByBarcode('5901234123457')
    expect(get.mock.calls[0][1].params).toEqual({ barcode: '5901234123457' })
  })

  it('reports a single match as found', async () => {
    get.mockResolvedValue({ data: { count: 1, results: [{ id: 1, name: 'Widget' }] } })
    const result = await lookupByBarcode('5901234123457')
    expect(result.status).toBe('found')
    expect(result.products[0].name).toBe('Widget')
  })

  it('reports several matches as ambiguous rather than guessing', async () => {
    // Barcodes are deliberately non-unique. Picking the first would add the wrong product.
    get.mockResolvedValue({ data: { count: 2, results: [{ id: 1 }, { id: 2 }] } })
    expect((await lookupByBarcode('2000000000001')).status).toBe('ambiguous')
  })

  it('reports no match', async () => {
    get.mockResolvedValue({ data: { count: 0, results: [] } })
    expect((await lookupByBarcode('0000000000000')).status).toBe('not_found')
  })

  it('reports a failed request as an error, not as not_found', async () => {
    // The difference matters: not_found tells the user to add the product, error tells them
    // to try again. Collapsing them sends people off to create duplicates while offline.
    get.mockRejectedValue(new Error('offline'))
    expect((await lookupByBarcode('5901234123457')).status).toBe('error')
  })

  it('survives a response with no results array', async () => {
    get.mockResolvedValue({ data: {} })
    expect((await lookupByBarcode('5901234123457')).status).toBe('not_found')
  })
})
