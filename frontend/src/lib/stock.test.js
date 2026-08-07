import { describe, expect, it } from 'vitest'
import { hasBlockingStockError, lineUnits, requestedByProduct, stockStateFor } from './stock'

const line = (product, quantity, unit_multiplier = 1, stock_quantity = 10) => ({
  product, quantity, unit_multiplier, stock_quantity, unit_price: 10,
})

describe('lineUnits', () => {
  it('multiplies quantity by the multiplier, matching the server deduction', () => {
    expect(lineUnits(line('1', 4, 3))).toBe(12)
  })

  it('treats blank and non-numeric inputs as zero rather than NaN', () => {
    expect(lineUnits({ quantity: '', unit_multiplier: 2 })).toBe(0)
    expect(lineUnits({ quantity: 'abc', unit_multiplier: 1 })).toBe(0)
  })

  it('reads numeric strings, which is what number inputs actually produce', () => {
    expect(lineUnits({ quantity: '3', unit_multiplier: '2' })).toBe(6)
  })
})

describe('requestedByProduct', () => {
  it('sums duplicate lines for the same product', () => {
    const totals = requestedByProduct([line('1', 6), line('1', 6)])
    expect(totals.get('1')).toBe(12)
  })

  it('keeps different products separate', () => {
    const totals = requestedByProduct([line('1', 2), line('2', 5)])
    expect(totals.get('1')).toBe(2)
    expect(totals.get('2')).toBe(5)
  })

  it('ignores lines with no product selected', () => {
    expect(requestedByProduct([line('', 5)]).size).toBe(0)
  })
})

describe('stockStateFor', () => {
  it('reports ok below the cap', () => {
    expect(stockStateFor([line('1', 3)], 0)).toMatchObject({ status: 'ok', remaining: 7 })
  })

  it('reports limit exactly at the cap', () => {
    expect(stockStateFor([line('1', 10)], 0)).toMatchObject({ status: 'limit', remaining: 0 })
  })

  it('reports over past the cap', () => {
    expect(stockStateFor([line('1', 11)], 0)).toMatchObject({ status: 'over', remaining: -1 })
  })

  it('reports out when the product has no stock at all', () => {
    expect(stockStateFor([line('1', 1, 1, 0)], 0).status).toBe('out')
  })

  it('reports none when no product is selected', () => {
    expect(stockStateFor([line('', 1)], 0).status).toBe('none')
  })

  it('charges duplicate lines against one shared pool', () => {
    const items = [line('1', 6), line('1', 6)]
    expect(stockStateFor(items, 0).status).toBe('over')
    expect(stockStateFor(items, 1).status).toBe('over')
  })

  it('counts the multiplier against the cap', () => {
    expect(stockStateFor([line('1', 4, 3)], 0).status).toBe('over')
  })
})

describe('hasBlockingStockError', () => {
  it('blocks when any line is over', () => {
    expect(hasBlockingStockError([line('1', 3), line('2', 99, 1, 5)])).toBe(true)
  })

  it('blocks an out-of-stock product', () => {
    expect(hasBlockingStockError([line('1', 1, 1, 0)])).toBe(true)
  })

  it('allows an order sitting exactly at the cap', () => {
    expect(hasBlockingStockError([line('1', 10)])).toBe(false)
  })
})
