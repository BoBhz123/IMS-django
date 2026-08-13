import { describe, expect, it } from 'vitest'
import {
  availableStock, creditedUnitsByProductId, partyIdByName, toFormLines,
} from './transactionEdit'

const CATALOG = [
  { id: 1, name: 'Widget', stock_quantity: 4 },
  { id: 2, name: 'Gadget', stock_quantity: 0 },
]

// Order items name a product by id; purchase items name it by name.
const orderItem = (product, quantity, unit_multiplier = 1, unit_price = '10.00') => ({
  product, quantity, unit_multiplier, unit_price,
})

describe('creditedUnitsByProductId', () => {
  it('counts quantity times multiplier, the way stock is deducted', () => {
    const credited = creditedUnitsByProductId([orderItem(1, 3, 2)], CATALOG)
    expect(credited.get('1')).toBe(6)
  })

  it('sums duplicate lines for one product into a single credit', () => {
    // The same trap as the server's aggregation: two lines share one stock pool, so
    // crediting them separately would understate what the edit hands back.
    const credited = creditedUnitsByProductId([orderItem(1, 2), orderItem(1, 3)], CATALOG)
    expect(credited.get('1')).toBe(5)
  })

  it('resolves purchase items by name', () => {
    const credited = creditedUnitsByProductId(
      [{ product: 'Widget', quantity: 2, unit_multiplier: 3 }], CATALOG, 'name',
    )
    // Keyed by id even though the item named the product — that is what the form's lines hold.
    expect(credited.get('1')).toBe(6)
  })

  it('skips a product that is no longer in the catalog', () => {
    // A deleted product cannot be credited back, and guessing would inflate the cap.
    const credited = creditedUnitsByProductId([orderItem(99, 5)], CATALOG)
    expect(credited.size).toBe(0)
  })
})

describe('availableStock', () => {
  it('adds the credit to what is on the shelf', () => {
    const credited = new Map([['1', 6]])
    expect(availableStock(CATALOG[0], credited)).toBe(10)
  })

  it('is just the shelf count when nothing is credited', () => {
    expect(availableStock(CATALOG[0], new Map())).toBe(4)
  })

  it('reports null for a product with no usable stock figure', () => {
    expect(availableStock({ id: 3 }, new Map())).toBeNull()
  })
})

describe('toFormLines', () => {
  it('turns order items into form lines with names and credited stock', () => {
    const credited = new Map([['1', 2]])
    const [line] = toFormLines([orderItem(1, 2, 1, '12.50')], CATALOG, { credited })

    expect(line).toEqual({
      product: '1',
      quantity: 2,
      unit_multiplier: 1,
      unit_price: '12.50',
      product_name: 'Widget',
      stock_quantity: 6,
    })
  })

  it('resolves purchase items, which carry a product name rather than an id', () => {
    const [line] = toFormLines(
      [{ product: 'Gadget', quantity: 5, unit_multiplier: 1, unit_price: '2.00' }],
      CATALOG,
      { productKey: 'name' },
    )
    expect(line.product).toBe('2')
    expect(line.product_name).toBe('Gadget')
  })

  it('leaves a line unset when its product is gone from the catalog', () => {
    // Holding no product id is what makes the submit drop the line rather than silently
    // reassigning it to whichever product happened to sort first.
    const [line] = toFormLines([orderItem(99, 1)], CATALOG)
    expect(line.product).toBe('')
    expect(line.stock_quantity).toBeNull()
    expect(line.quantity).toBe(1)
  })
})

describe('partyIdByName', () => {
  const customers = [{ id: 7, name: 'Rami' }, { id: 8, name: 'Layal' }]

  it('finds the id for a named party', () => {
    expect(partyIdByName('Layal', customers)).toBe('8')
  })

  it('returns nothing for a party that is absent or unnamed', () => {
    // A renamed or deleted customer must read as "none" rather than being reassigned.
    expect(partyIdByName('Ghost', customers)).toBe('')
    expect(partyIdByName(null, customers)).toBe('')
  })
})
