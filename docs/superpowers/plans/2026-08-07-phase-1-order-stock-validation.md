# Phase 1: Order Stock Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject orders that would drive `Product.stock_quantity` negative with a clear HTTP 400, and stop the order form from letting a user build such an order in the first place.

**Architecture:** Server-side validation is the guard and lives in `CreateOrderSerializer` — a `validate_items` pass for the fast, readable rejection, plus a re-check under `select_for_update()` inside the existing atomic block to close the concurrent-order race. The frontend gate is a convenience layer built on a pure, unit-tested `lib/stock.js` module, so the aggregation rule (which is easy to get wrong) is tested independently of React.

**Tech Stack:** Django 6 / DRF, Postgres, `django-tenants` (removed in Phase 2), React 19 + Vite, Vitest (added by this plan).

## Global Constraints

- Stock is consumed as `quantity * unit_multiplier`, never bare `quantity`. Validation and deduction must use the same expression.
- The existing transactional contract is preserved: purchases increment stock, orders decrement it, atomically, inside `@transaction.atomic`.
- Tests use `TenantTestCase` + `TenantClient`, not `TestCase` + `APIClient` — `inventory` is a `TENANT_APPS` model and its tables do not exist in the `public` schema. (Phase 2 migrates this wholesale; do not pre-emptively change it here.)
- Django tests run with `pipenv run python manage.py test inventory`.
- Frontend never sends a request the server would reject; but the server never trusts the frontend either.
- Do not work on `main`. This plan executes on `feature/saas-single-db-migration`.

## File Structure

| File | Responsibility |
|---|---|
| `inventory/serializers.py` (modify) | `CreateOrderSerializer.validate_items` + rewritten `create()`; same aggregation fix in `CreatePurchaseSerializer.create()` |
| `inventory/tests.py` (modify) | New `OrderStockValidationTests` class appended |
| `frontend/src/lib/stock.js` (create) | Pure stock arithmetic: per-line units, per-product aggregation, per-line status |
| `frontend/src/lib/stock.test.js` (create) | Unit tests for the above |
| `frontend/package.json` (modify) | Add `vitest` devDependency and `test` script |
| `frontend/src/components/forms/OrderForm.jsx` (modify) | Carry `stock_quantity` in line state; disable controls; render badge |
| `frontend/src/components/forms/ProductPicker.jsx` (modify) | Show stock per option; disable zero-stock options |

---

### Task 1: Server-side stock validation

**Files:**
- Modify: `inventory/serializers.py` (`CreateOrderSerializer`, `CreatePurchaseSerializer`)
- Test: `inventory/tests.py` (append `OrderStockValidationTests`)

**Interfaces:**
- Consumes: `Product.stock_quantity`, existing `CreateOrderItemSerializer` validated shape `{product, quantity, unit_multiplier, unit_price}`.
- Produces: HTTP 400 body `{"items": ["Insufficient stock for 'X': requested N, available M."]}` — the frontend's error path in Task 4 relies on `items` being a list of strings.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class OrderStockValidationTests(TenantTestCase):
    """
    Orders must never drive stock negative. Three things make this less trivial than it
    looks: stock is consumed as quantity * unit_multiplier, one order may list the same
    product on several lines, and two concurrent orders can both pass a naive check.
    """

    def setUp(self):
        category = Category.objects.create(name="Widgets")
        self.product = Product.objects.create(
            name="Widget", description="", cost_price="4.00",
            default_sell_price="10.00", category=category, stock_quantity=10,
        )
        self.user = User.objects.create_superuser(username="boss", password="pw12345!")
        self.client = TenantClient(self.tenant)
        self.auth_header = f"JWT {RefreshToken.for_user(self.user).access_token}"

    def post_order(self, items):
        return self.client.post(
            "/inventory/orders/",
            {"exchange_rate": 89000, "items": items},
            content_type="application/json",
            HTTP_AUTHORIZATION=self.auth_header,
        )

    def line(self, quantity, multiplier=1, product=None):
        return {
            "product": (product or self.product).id,
            "quantity": quantity,
            "unit_multiplier": multiplier,
            "unit_price": "10.00",
        }

    def stock(self):
        self.product.refresh_from_db()
        return self.product.stock_quantity

    def test_order_exceeding_stock_is_rejected(self):
        response = self.post_order([self.line(11)])
        self.assertEqual(response.status_code, 400)
        self.assertIn("items", response.json())
        self.assertIn("Insufficient stock", str(response.json()["items"]))

    def test_rejected_order_leaves_stock_and_orders_untouched(self):
        self.post_order([self.line(11)])
        self.assertEqual(self.stock(), 10)
        self.assertEqual(Order.objects.count(), 0)

    def test_order_equal_to_available_stock_is_accepted(self):
        response = self.post_order([self.line(10)])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 0)

    def test_unit_multiplier_counts_against_stock(self):
        # 4 * 3 = 12 units against 10 in stock. Validating bare quantity (4) would pass
        # this and then deduct 12, leaving -2.
        response = self.post_order([self.line(4, multiplier=3)])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.stock(), 10)

    def test_duplicate_lines_for_one_product_are_summed(self):
        # 6 + 6 = 12 against 10. Each line alone fits; together they do not.
        response = self.post_order([self.line(6), self.line(6)])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.stock(), 10)

    def test_duplicate_lines_deduct_every_line(self):
        # Regression: DRF builds a separate Product instance per item, so the old
        # `product.stock_quantity -= n; product.save()` loop wrote stale copies — the
        # second save overwrote the first and only one line's units came off.
        response = self.post_order([self.line(3), self.line(3)])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 4)

    def test_out_of_stock_product_is_rejected(self):
        self.product.stock_quantity = 0
        self.product.save()
        response = self.post_order([self.line(1)])
        self.assertEqual(response.status_code, 400)

    def test_error_message_names_the_product_and_both_numbers(self):
        message = str(self.post_order([self.line(11)]).json()["items"])
        self.assertIn("Widget", message)
        self.assertIn("11", message)
        self.assertIn("10", message)

    def test_purchase_duplicate_lines_add_every_line(self):
        # Same stale-instance bug on the increment side.
        supplier = Supplier.objects.create(name="Supplier Co")
        response = self.client.post(
            "/inventory/purchases/",
            {
                "supplier": supplier.id,
                "exchange_rate": 89000,
                "items": [
                    {"product": self.product.id, "quantity": 3,
                     "unit_multiplier": 1, "unit_price": "4.00"},
                    {"product": self.product.id, "quantity": 3,
                     "unit_multiplier": 1, "unit_price": "4.00"},
                ],
            },
            content_type="application/json",
            HTTP_AUTHORIZATION=self.auth_header,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 16)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pipenv run python manage.py test inventory.tests.OrderStockValidationTests -v 2`

Expected: FAIL. `test_order_exceeding_stock_is_rejected` returns 201 instead of 400; `test_duplicate_lines_deduct_every_line` leaves stock at 7 instead of 4; `test_purchase_duplicate_lines_add_every_line` leaves 13 instead of 16.

- [ ] **Step 3: Add the aggregation helper and validation**

At the top of `inventory/serializers.py`, add to the imports:

```python
from collections import defaultdict

from django.db.models import F
```

Add this module-level helper just above `CreateOrderItemSerializer`:

```python
def _units_by_product_id(items_data):
    """
    Units each product gives up (or gains), keyed by product id.

    Aggregating by id — rather than walking items one at a time — is what makes duplicate
    lines for the same product behave. DRF also hands back a *separate* Product instance
    per item, so any per-item read-modify-write of stock_quantity operates on a stale copy.
    """
    totals = defaultdict(int)
    for item in items_data:
        totals[item['product'].id] += item['quantity'] * item.get('unit_multiplier', 1)
    return totals


def _insufficient_stock_errors(units_by_id, products):
    return [
        f"Insufficient stock for '{product.name}': "
        f"requested {units_by_id[product.id]}, available {product.stock_quantity}."
        for product in products
        if units_by_id[product.id] > product.stock_quantity
    ]
```

- [ ] **Step 4: Rewrite `CreateOrderSerializer.validate_items` and `create`**

Replace the `create` method of `CreateOrderSerializer` with:

```python
    def validate_items(self, items):
        if not items:
            raise serializers.ValidationError("An order must contain at least one item.")

        units_by_id = _units_by_product_id(items)
        products = Product.objects.filter(id__in=units_by_id)
        errors = _insufficient_stock_errors(units_by_id, products)
        if errors:
            raise serializers.ValidationError(errors)
        return items

    @transaction.atomic
    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        units_by_id = _units_by_product_id(items_data)

        # validate_items ran outside this transaction, so two orders placed at the same
        # instant can both pass it and both deduct. Re-reading under a row lock and
        # re-checking makes the second one fail instead of driving stock negative.
        locked = Product.objects.select_for_update().filter(id__in=units_by_id)
        errors = _insufficient_stock_errors(units_by_id, locked)
        if errors:
            raise serializers.ValidationError({'items': errors})

        order = Order.objects.create(**validated_data)
        OrderItem.objects.bulk_create(
            [OrderItem(order=order, **item_data) for item_data in items_data]
        )

        # One UPDATE per product, computed in the database, rather than a save() per line.
        for product_id, units in units_by_id.items():
            Product.objects.filter(id=product_id).update(
                stock_quantity=F('stock_quantity') - units
            )
        return order
```

- [ ] **Step 5: Apply the same aggregation fix to `CreatePurchaseSerializer.create`**

Replace the `create` method of `CreatePurchaseSerializer` with:

```python
    @transaction.atomic
    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        units_by_id = _units_by_product_id(items_data)

        purchase = Purchase.objects.create(**validated_data)
        PurchaseItem.objects.bulk_create(
            [PurchaseItem(purchase_order=purchase, **item_data) for item_data in items_data]
        )

        # Purchases have no ceiling to validate against, but they have the same
        # stale-instance problem as orders when one product appears on two lines.
        for product_id, units in units_by_id.items():
            Product.objects.filter(id=product_id).update(
                stock_quantity=F('stock_quantity') + units
            )
        return purchase
```

- [ ] **Step 6: Run the new tests**

Run: `pipenv run python manage.py test inventory.tests.OrderStockValidationTests -v 2`
Expected: PASS, 9 tests.

- [ ] **Step 7: Run the whole suite for regressions**

Run: `pipenv run python manage.py test 2>&1 | tail -5`
Expected: `OK`, 37 tests (28 existing + 9 new).

- [ ] **Step 8: Commit**

```bash
git add inventory/serializers.py inventory/tests.py
git commit -m "feat: reject orders that exceed available stock

Validates quantity * unit_multiplier against stock_quantity, aggregated per
product so duplicate lines can't each pass on their own, with a re-check under
select_for_update() to close the concurrent-order race.

Also fixes a pre-existing miscount: DRF builds a separate Product instance per
nested item, so the read-modify-write loop wrote stale copies and only the last
line of a repeated product was applied. Both orders and purchases now aggregate
per product and update with F() expressions."
```

---

### Task 2: Pure stock logic for the frontend

**Files:**
- Create: `frontend/src/lib/stock.js`
- Create: `frontend/src/lib/stock.test.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces: `lineUnits(item)`, `requestedByProduct(items)`, `stockStateFor(items, index)`, `hasBlockingStockError(items)`. Task 3 imports `stockStateFor` and `hasBlockingStockError` by these exact names.
- `stockStateFor` returns `{ status, available, requested, remaining }` where `status` is one of `'none' | 'ok' | 'limit' | 'over' | 'out'`.

- [ ] **Step 1: Add Vitest**

Run: `cd frontend && npm install --save-dev vitest`

Then add to the `scripts` block of `frontend/package.json`:

```json
    "test": "vitest run",
```

If the install fails for lack of network, stop and report it rather than skipping the tests — the aggregation rule below is the exact thing that must not be written untested.

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/lib/stock.test.js`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npm test`
Expected: FAIL — `Failed to resolve import "./stock"`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/lib/stock.js`:

```js
/**
 * Stock arithmetic for the order form, kept separate from React so the one rule that is
 * easy to get wrong — duplicate lines for the same product share a single pool — is
 * unit-tested on its own.
 *
 * These mirror the server's rules in CreateOrderSerializer. They are a convenience gate,
 * not a guard: the server validates independently and is the authority.
 */

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Units one line consumes: quantity × multiplier, matching the server's deduction. */
export function lineUnits(item) {
  return toCount(item?.quantity) * toCount(item?.unit_multiplier)
}

/** Map of product id → units requested across every line, so duplicates aggregate. */
export function requestedByProduct(items) {
  const totals = new Map()
  for (const item of items) {
    if (!item?.product) continue
    const key = String(item.product)
    totals.set(key, (totals.get(key) || 0) + lineUnits(item))
  }
  return totals
}

/**
 * Stock state for one line, judged against everything else in the order.
 * status: 'none' (nothing picked) | 'out' (product has zero stock) |
 *         'over' (past the cap) | 'limit' (exactly at it) | 'ok'
 */
export function stockStateFor(items, index) {
  const item = items[index]
  if (!item?.product) {
    return { status: 'none', available: null, requested: 0, remaining: null }
  }

  const available = Number(item.stock_quantity)
  if (!Number.isFinite(available)) {
    return { status: 'none', available: null, requested: 0, remaining: null }
  }

  const requested = requestedByProduct(items).get(String(item.product)) || 0
  const remaining = available - requested

  let status = 'ok'
  if (available <= 0) status = 'out'
  else if (remaining < 0) status = 'over'
  else if (remaining === 0) status = 'limit'

  return { status, available, requested, remaining }
}

/** True when the order cannot legally be submitted as it stands. */
export function hasBlockingStockError(items) {
  return items.some((_, index) => ['over', 'out'].includes(stockStateFor(items, index).status))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, 16 tests across 4 suites.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/stock.js frontend/src/lib/stock.test.js frontend/package.json frontend/package-lock.json
git commit -m "feat: pure stock-limit arithmetic for the order form, with tests

Adds Vitest and lib/stock.js. Kept out of the component so the rule that
duplicate lines of one product share a single stock pool is tested directly."
```

---

### Task 3: Wire the order form to the stock rules

**Files:**
- Modify: `frontend/src/components/forms/OrderForm.jsx`
- Modify: `frontend/src/components/forms/ProductPicker.jsx`

**Interfaces:**
- Consumes: `stockStateFor`, `hasBlockingStockError` from `@/lib/stock`; existing `StockBadge` from `@/components/ui/StockBadge`.

- [ ] **Step 1: Carry stock into line-item state**

In `frontend/src/components/forms/OrderForm.jsx`, replace `emptyItem` and `handleProductChange`:

```js
function emptyItem() {
  return { product: '', quantity: 1, unit_multiplier: 1, unit_price: 0, stock_quantity: null, product_name: '' }
}
```

```js
  function handleProductChange(index, productId, product) {
    updateItem(index, {
      product: productId,
      unit_price: product ? product.default_sell_price : 0,
      stock_quantity: product ? product.stock_quantity : null,
      product_name: product ? product.name : '',
    })
  }
```

- [ ] **Step 2: Import the helpers**

Add to the imports at the top of `OrderForm.jsx`:

```js
import { hasBlockingStockError, stockStateFor } from '@/lib/stock'
import { StockBadge } from '@/components/ui/StockBadge'
```

- [ ] **Step 3: Render the badge and cap the quantity input**

In the `items.map(...)` block, replace the picker row and the `Qty` field. The picker row becomes:

```jsx
              <div className="mb-2 flex items-center gap-2">
                <ProductPicker
                  value={item.product}
                  onChange={(productId, product) => handleProductChange(index, productId, product)}
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeItem(index)}
                    aria-label="Remove item"
                    className="shrink-0 text-text-tertiary hover:text-accent-red"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>

              {(() => {
                const stock = stockStateFor(items, index)
                if (stock.status === 'none') return null
                return (
                  <div className="mb-2 flex items-center gap-2">
                    {stock.status === 'out' && <StockBadge quantity={0} />}
                    {stock.status === 'limit' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-orange/15 px-2 py-0.5 text-[12px] font-medium text-accent-orange">
                        Reached limit — {stock.available} available
                      </span>
                    )}
                    {stock.status === 'over' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-red/15 px-2 py-0.5 text-[12px] font-medium text-accent-red">
                        Over stock by {-stock.remaining} — only {stock.available} available
                      </span>
                    )}
                    {stock.status === 'ok' && <StockBadge quantity={stock.remaining} />}
                  </div>
                )
              })()}
```

And the `Qty` field gains a max, derived from what the *other* lines already claim:

```jsx
                <NumberField
                  label="Qty"
                  value={item.quantity}
                  max={maxQuantityFor(items, index)}
                  onChange={(v) => updateItem(index, { quantity: v })}
                />
```

- [ ] **Step 4: Add the per-line quantity ceiling**

Add above the `OrderForm` component in the same file:

```js
/**
 * Largest quantity this line may take: the product's stock less whatever the other lines
 * already claim, divided back out by this line's multiplier — because the input edits
 * quantity, while stock is consumed in quantity × multiplier units.
 */
function maxQuantityFor(items, index) {
  const item = items[index]
  if (!item?.product) return undefined
  const available = Number(item.stock_quantity)
  if (!Number.isFinite(available)) return undefined

  const claimedElsewhere = items.reduce((sum, other, i) => {
    if (i === index || String(other.product) !== String(item.product)) return sum
    return sum + (Number(other.quantity) || 0) * (Number(other.unit_multiplier) || 0)
  }, 0)

  const multiplier = Number(item.unit_multiplier) || 1
  return Math.max(0, Math.floor((available - claimedElsewhere) / multiplier))
}
```

- [ ] **Step 5: Let `NumberField` accept and enforce a max**

Replace `NumberField` at the bottom of `OrderForm.jsx`:

```jsx
function NumberField({ label, value, onChange, max }) {
  const atLimit = max !== undefined && Number(value) >= max
  return (
    <div>
      <span className="mb-1 block text-[11px] text-text-tertiary">{label}</span>
      <input
        type="number"
        min="1"
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={max !== undefined && Number(value) > max}
        className={`w-full rounded-lg border bg-canvas px-2 py-1.5 text-[13px] text-text-primary tabular-nums focus:outline-none ${
          atLimit ? 'border-accent-orange' : 'border-hairline'
        }`}
      />
    </div>
  )
}
```

- [ ] **Step 6: Block submission and the Add-item button**

Replace the submit button's `disabled` and add a guard above it:

```jsx
        {hasBlockingStockError(items) && (
          <p className="text-[13px] text-accent-red">
            Reduce quantities to available stock before creating this order.
          </p>
        )}

        <button
          type="submit"
          disabled={saving || hasBlockingStockError(items)}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
```

- [ ] **Step 7: Surface list-shaped `items` errors from the server**

The server now returns `items` as a list of strings. Replace the existing `errors.items` block, which only rendered strings:

```jsx
        {errors.items && (
          <div className="text-[13px] text-accent-red">
            {(Array.isArray(errors.items) ? errors.items : [errors.items]).map((message) => (
              <p key={String(message)}>{String(message)}</p>
            ))}
          </div>
        )}
```

- [ ] **Step 8: Show stock in the product picker**

In `frontend/src/components/forms/ProductPicker.jsx`, replace the option button inside `products.map(...)`:

```jsx
                <button
                  key={product.id}
                  type="button"
                  disabled={product.stock_quantity <= 0}
                  onClick={() => handleSelect(product)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] enabled:hover:bg-canvas-2 disabled:cursor-not-allowed disabled:opacity-45 ${
                    String(product.id) === String(value) ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary'
                  }`}
                >
                  <ProductThumbnail image={product.images?.[0]?.image} name={product.name} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                  <span
                    className={`shrink-0 text-[11px] tabular-nums ${
                      product.stock_quantity <= 0 ? 'text-accent-red' : 'text-text-tertiary'
                    }`}
                  >
                    {product.stock_quantity <= 0 ? 'Out of stock' : `${product.stock_quantity} left`}
                  </span>
                </button>
```

- [ ] **Step 9: Verify the build and lint pass**

Run: `cd frontend && npm run lint && npm run build`
Expected: no lint errors; build writes `frontend/dist/`.

- [ ] **Step 10: Verify by hand in the running app**

Run the API and the dev server, then in the order form confirm: an out-of-stock product cannot be picked; typing a quantity above stock shows the red over-stock badge and disables Create order; two lines of the same product share one pool; setting quantity exactly to stock shows the orange "Reached limit" badge and still submits.

```bash
pipenv run python manage.py runserver &
cd frontend && npm run dev
```

- [ ] **Step 11: Commit**

```bash
git add frontend/src/components/forms/OrderForm.jsx frontend/src/components/forms/ProductPicker.jsx
git commit -m "feat: stop the order form building orders that exceed stock

Caps quantity per line against the product's remaining stock (shared across
duplicate lines), disables out-of-stock products in the picker, badges the
at-limit and over-limit states, and blocks submit. The server validation added
alongside this remains the actual guard."
```

---

### Task 4: Record the phase

**Files:**
- Modify: `HISTORY.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the full backend suite one more time**

Run: `pipenv run python manage.py test 2>&1 | tail -5`
Expected: `OK`, 37 tests.

- [ ] **Step 2: Add the HISTORY entry**

Insert directly below the `# HISTORY` preamble, above the 2026-08-07 planning entry:

```markdown
## 2026-08-07 — Phase 1: order stock validation

Orders exceeding available stock are rejected with HTTP 400 instead of silently driving
`stock_quantity` negative. Validation compares `quantity * unit_multiplier` (the same
expression the deduction uses), aggregated per product so duplicate lines cannot each
pass on their own, and re-checks under `select_for_update()` inside the atomic block to
close the concurrent-order race.

Fixed alongside it: DRF builds a separate `Product` instance per nested item, so the old
per-item `stock_quantity -= n; save()` loop wrote stale copies — ordering one product on
two lines only ever applied the last line. Both orders and purchases now aggregate per
product and update with `F()` expressions. This had been silently miscounting stock.

Frontend: `lib/stock.js` (unit-tested with the newly added Vitest) holds the arithmetic;
the order form caps each line, disables out-of-stock products in the picker, badges the
at-limit and over-limit states, and blocks submission.
```

- [ ] **Step 3: Update the plan status in CLAUDE.md**

Change `**Status:** Phase 1 in progress.` to `**Status:** Phase 1 complete. Phase 2 next.`

Add to the Working Log:

```markdown
- **The frontend had no test runner** until Phase 1 added Vitest (`cd frontend && npm test`).
  Pure logic belongs in `frontend/src/lib/*.js` where it can be tested without React.
- **`inventory/tests.py` is not a stub** — it holds a real suite (28 tests before Phase 1)
  using `TenantTestCase`/`TenantClient`, because `inventory` tables live only in tenant
  schemas. Phase 2 must migrate every one of these to plain `TestCase`/`APIClient`.
```

- [ ] **Step 4: Commit**

```bash
git add HISTORY.md CLAUDE.md
git commit -m "docs: record Phase 1 completion"
```

---

## Self-Review

**Spec coverage.** Phase 1 of the design has three requirements: backend rejection with HTTP 400 (Task 1), disabled add/increment controls at the cap (Task 3 steps 3–6), and a visible limit/out-of-stock badge (Task 3 step 3). The design's three named subtleties — multiplier, duplicate lines, concurrency — each have a dedicated test in Task 1 step 1. The stale-instance bug the design calls out is covered by `test_duplicate_lines_deduct_every_line` and `test_purchase_duplicate_lines_add_every_line`.

**Placeholders.** None. Every code step carries complete code.

**Type consistency.** `stockStateFor` returns `{status, available, requested, remaining}` in Task 2 and is destructured on exactly those keys in Task 3. `hasBlockingStockError(items)` takes the item array in both. `_units_by_product_id` and `_insufficient_stock_errors` are defined in Task 1 step 3 before their use in steps 4 and 5. The 400 body shape `{"items": [...]}` produced in Task 1 is what Task 3 step 7 renders.

**Known follow-on.** Order *updates* (`PUT`/`PATCH` on `OrderViewSet`) do not adjust stock today and this plan does not change that — validating updates without also making them adjust stock would be incoherent. Recorded here as a deliberate omission, not an oversight.
