/**
 * Turning a saved order/purchase back into editable form state.
 *
 * Kept out of React because two things here are easy to get wrong and worth testing on their
 * own:
 *
 * 1. **The two APIs identify a product differently.** OrderItem.product is an id;
 *    PurchaseItem.product is a *name* (PurchaseItemSerializer declares it as a
 *    StringRelatedField). A form that assumes either one silently produces empty product
 *    pickers on the other.
 * 2. **A saved order's units are already out of stock.** Editing it must judge quantities
 *    against stock *plus* what this order is giving back, exactly as the server does — see
 *    `_insufficient_stock_errors(credited_units=…)` in inventory/serializers.py. Without the
 *    credit, re-opening an order that took the last 10 units shows every line as "over
 *    stock" and refuses to submit an unchanged edit.
 */

function unitsOf(item) {
  return Number(item.quantity) || 0
}

/**
 * Catalog indexed by whatever the transaction's items use to name a product.
 * `productKey` is 'id' for orders, 'name' for purchases.
 */
function indexCatalog(catalog, productKey) {
  return new Map(
    catalog.map((product) => [productKey === 'name' ? product.name : String(product.id), product]),
  )
}

/**
 * Units this saved transaction already moved, per product id — the stock an edit hands back
 * before it takes anything new.
 *
 * Keyed by product id even for purchases, because that is what the form's lines hold once
 * hydrated. Items whose product is missing from the catalog are skipped: a deleted product
 * cannot be credited, and guessing would inflate the cap.
 */
export function creditedUnitsByProductId(items, catalog, productKey = 'id') {
  const byKey = indexCatalog(catalog, productKey)
  const credited = new Map()
  for (const item of items) {
    const product = byKey.get(String(item.product))
    if (!product) continue
    const id = String(product.id)
    credited.set(id, (credited.get(id) || 0) + unitsOf(item))
  }
  return credited
}

/** Stock a form line may draw on: what is on the shelf, plus what this edit returns. */
export function availableStock(product, credited) {
  const onHand = Number(product?.stock_quantity)
  if (!Number.isFinite(onHand)) return null
  return onHand + (credited?.get(String(product.id)) || 0)
}

/**
 * Saved API items → form line state.
 *
 * A line whose product no longer exists in the catalog keeps its numbers and shows what it
 * can of the original label, but holds no product id — the picker reads as unset, so saving
 * drops the line rather than guessing at a replacement.
 */
export function toFormLines(items, catalog, { productKey = 'id', credited = null } = {}) {
  const byKey = indexCatalog(catalog, productKey)
  return items.map((item) => {
    const product = byKey.get(String(item.product))
    return {
      product: product ? String(product.id) : '',
      quantity: Number(item.quantity) || 1,
      unit_price: item.unit_price,
      product_name:
        product?.name ??
        (productKey === 'name' ? String(item.product) : `Product #${item.product}`),
      stock_quantity: product ? availableStock(product, credited) : null,
    }
  })
}

/**
 * The id of the party (customer/supplier) named on a saved transaction.
 *
 * Both serializers render the party as a bare name, and the form needs an id to POST back.
 * Names are unique per account (UniqueConstraint on account+name), so the match is exact and
 * unambiguous — but a renamed or deleted party resolves to nothing, and the form must then
 * show "none" rather than silently reassigning the transaction to whoever sorts first.
 */
export function partyIdByName(name, parties) {
  if (!name) return ''
  const match = parties.find((party) => party.name === name)
  return match ? String(match.id) : ''
}
