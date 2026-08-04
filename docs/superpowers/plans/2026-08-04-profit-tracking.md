# Profit Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-item and per-order profit margins, and per-product profit, to staff via the API and internal React UI, while guaranteeing profit data never reaches the printable customer Invoice.

**Architecture:** Backend exposes profit as plain Python model properties (mirroring the existing `total_price` pattern), auto-picked up by DRF `ModelSerializer`s. Frontend reads these fields directly from API responses — no client-side reimplementation of the pricing formula. A new admin-only CSV export endpoint follows the existing `ExportOrdersCSVView`/`ExportPurchasesCSVView` pattern exactly.

**Tech Stack:** Django REST Framework (backend), React + Vite + Tailwind (frontend), `oxlint` for lint, `vite build` for build. No automated test suite exists in this repo (`inventory/tests.py` is the Django stub) — verification is manual, via `manage.py shell` on the backend and `npm run lint`/`npm run build` + visual check on the frontend.

## Global Constraints

- Do not alter core transactional logic (stock quantity adjustment on Purchase/Order create) — `inventory/serializers.py` `CreatePurchaseSerializer.create()` / `CreateOrderSerializer.create()` are off-limits.
- Do not add profit/cost fields to `SimpleProductSerializer` or to `Invoice.jsx` — these are the explicit security boundaries (customer-facing / cost-picker contexts).
- `total_profit` multiplies by `unit_multiplier`; the pre-existing `Order.total_price` property does not. This is a known, accepted inconsistency — do not "fix" `total_price` as a drive-by change.
- No new dependencies, no new test framework, no Dockerfiles/deployment config.

---

### Task 1: Backend model properties

**Files:**
- Modify: `inventory/models.py`

**Interfaces:**
- Produces: `Product.profit` (Decimal), `OrderItem.profit` (Decimal or `None` if `product` is unset), `Order.total_profit` (Decimal, sums item profits treating `None` as 0).

- [ ] **Step 1: Add `Product.profit` property**

In `inventory/models.py`, inside `class Product`, directly below the `default_sell_price` field definition (before `stock_quantity`), add:

```python
    @property
    def profit(self):
        return self.default_sell_price - self.cost_price
```

- [ ] **Step 2: Add `OrderItem.profit` property**

In `inventory/models.py`, inside `class OrderItem` (below the `unit_multiplier` field), add:

```python
     @property
     def profit(self):
         if not self.product_id:
             return None
         return (self.unit_price - self.product.cost_price) * self.quantity * self.unit_multiplier
```

Match the existing 5-space indentation used by other members of `OrderItem` in this file.

- [ ] **Step 3: Add `Order.total_profit` property**

In `inventory/models.py`, inside `class Order`, directly below the existing `total_price` property, add:

```python
    @property
    def total_profit(self):
        return sum((item.profit or 0) for item in self.items.all())
```

- [ ] **Step 4: Verify with `manage.py shell`**

Run:

```bash
pipenv run python manage.py shell -c "
from inventory.models import Product, Order

p = Product.objects.first()
assert p.profit == p.default_sell_price - p.cost_price, 'Product.profit mismatch'
print('Product.profit OK:', p.name, p.profit)

o = Order.objects.filter(items__isnull=False).first()
expected = sum(
    ((it.unit_price - it.product.cost_price) * it.quantity * it.unit_multiplier)
    for it in o.items.all() if it.product_id
)
assert o.total_profit == expected, f'Order.total_profit mismatch: {o.total_profit} != {expected}'
for it in o.items.all():
    if it.product_id:
        assert it.profit == (it.unit_price - it.product.cost_price) * it.quantity * it.unit_multiplier
print('Order.total_profit OK:', o.id, o.total_profit)
print('ALL CHECKS PASSED')
"
```

Expected output ends with `ALL CHECKS PASSED` and no `AssertionError`.

- [ ] **Step 5: Commit**

```bash
git add inventory/models.py
git commit -m "Add profit properties to Product, OrderItem, and Order models"
```

---

### Task 2: Backend serializer fields

**Files:**
- Modify: `inventory/serializers.py`

**Interfaces:**
- Consumes: `Product.profit`, `OrderItem.profit`, `Order.total_profit` from Task 1.
- Produces: `profit` key in `ProductSerializer` and `OrderItemSerializer` output; `total_profit` key in `OrderSerializer` output.

- [ ] **Step 1: Add `profit` to `ProductSerializer`**

In `inventory/serializers.py`, change:

```python
        fields = ['id','name','category','supplier','description','cost_price','default_sell_price','stock_quantity','images']
```

to:

```python
        fields = ['id','name','category','supplier','description','cost_price','default_sell_price','profit','stock_quantity','images']
```

Do **not** touch `SimpleProductSerializer` (lines 25-28) — it must keep excluding cost/profit data.

- [ ] **Step 2: Add `profit` to `OrderItemSerializer`**

Change:

```python
class OrderItemSerializer(serializers.ModelSerializer):
    class Meta():
        model =OrderItem
        fields = ['product','quantity','unit_multiplier','unit_price']
```

to:

```python
class OrderItemSerializer(serializers.ModelSerializer):
    class Meta():
        model =OrderItem
        fields = ['product','quantity','unit_multiplier','unit_price','profit']
```

- [ ] **Step 3: Add `total_profit` to `OrderSerializer`**

Change:

```python
        fields = ['id','customer','placed_at','exchange_rate','items','total_price']
```

(in `OrderSerializer.Meta`) to:

```python
        fields = ['id','customer','placed_at','exchange_rate','items','total_price','total_profit']
```

- [ ] **Step 4: Verify with `manage.py shell`**

Run:

```bash
pipenv run python manage.py shell -c "
from inventory.models import Product, Order
from inventory.serializers import ProductSerializer, OrderSerializer

p = Product.objects.first()
data = ProductSerializer(p).data
assert 'profit' in data, 'ProductSerializer missing profit'
assert data['profit'] == str(p.profit) or float(data['profit']) == float(p.profit)
print('ProductSerializer.profit OK:', data['profit'])

o = Order.objects.filter(items__isnull=False).first()
data = OrderSerializer(o).data
assert 'total_profit' in data, 'OrderSerializer missing total_profit'
assert data['items'][0].get('profit') is not None or o.items.first().product_id is None
print('OrderSerializer.total_profit OK:', data['total_profit'])
print('OrderItem profit sample:', data['items'][0].get('profit'))
print('ALL CHECKS PASSED')
"
```

Expected output ends with `ALL CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add inventory/serializers.py
git commit -m "Expose profit fields on Product, OrderItem, and Order serializers"
```

---

### Task 3: Products CSV export endpoint

**Files:**
- Modify: `inventory/views.py`
- Modify: `inventory/urls.py`

**Interfaces:**
- Consumes: `Product.profit` (Task 1), `Q` (already imported in `inventory/views.py` line 2).
- Produces: `GET /inventory/products/export/csv/` (admin-only), matching query params `search`, `category_id`, `supplier_id`, `default_sell_price__gt`, `default_sell_price__lt`.

- [ ] **Step 1: Add `ExportProductsCSVView`**

In `inventory/views.py`, directly above `class ExportOrdersCSVView(APIView):` (currently line 223), insert:

```python
class ExportProductsCSVView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="products_export.csv"'

        writer = csv.writer(response)
        writer.writerow([
            'Product Name',
            'Category',
            'Supplier',
            'Stock Quantity',
            'Cost Price (USD)',
            'Sell Price (USD)',
            'Profit (USD)',
        ])

        products = Product.objects.select_related('category', 'supplier').all()

        search = request.query_params.get('search')
        category_id = request.query_params.get('category_id')
        supplier_id = request.query_params.get('supplier_id')
        min_price = request.query_params.get('default_sell_price__gt')
        max_price = request.query_params.get('default_sell_price__lt')

        if search:
            products = products.filter(Q(name__icontains=search) | Q(description__icontains=search))
        if category_id:
            products = products.filter(category_id=category_id)
        if supplier_id:
            products = products.filter(supplier_id=supplier_id)
        if min_price:
            products = products.filter(default_sell_price__gt=min_price)
        if max_price:
            products = products.filter(default_sell_price__lt=max_price)

        for product in products:
            writer.writerow([
                product.name,
                product.category.name if product.category else 'Uncategorized',
                product.supplier.name if product.supplier else 'No Supplier',
                product.stock_quantity,
                f"${product.cost_price:.2f}",
                f"${product.default_sell_price:.2f}",
                f"${product.profit:.2f}",
            ])

        return response


```

- [ ] **Step 2: Wire the URL**

In `inventory/urls.py`, change:

```python
urlpatterns = [
    path('analytics/', views.AnalyticsView.as_view(), name='analytics'),
    path('orders/export/csv/', views.ExportOrdersCSVView.as_view(), name='export-orders-csv'),
    path('purchases/export/csv/', views.ExportPurchasesCSVView.as_view(), name='export-purchases-csv'),
] + router.urls + products_router.urls
```

to:

```python
urlpatterns = [
    path('analytics/', views.AnalyticsView.as_view(), name='analytics'),
    path('orders/export/csv/', views.ExportOrdersCSVView.as_view(), name='export-orders-csv'),
    path('purchases/export/csv/', views.ExportPurchasesCSVView.as_view(), name='export-purchases-csv'),
    path('products/export/csv/', views.ExportProductsCSVView.as_view(), name='export-products-csv'),
] + router.urls + products_router.urls
```

- [ ] **Step 3: Verify with `manage.py shell`**

Run:

```bash
pipenv run python manage.py shell -c "
from django.test import RequestFactory
from django.contrib.auth import get_user_model
from inventory.views import ExportProductsCSVView

User = get_user_model()
admin, _ = User.objects.get_or_create(username='__plan_verify_admin', defaults={'is_staff': True, 'is_superuser': True})
admin.is_staff = True
admin.save()

rf = RequestFactory()
request = rf.get('/inventory/products/export/csv/')
request.user = admin
response = ExportProductsCSVView.as_view()(request)
body = response.content.decode()
lines = body.strip().split(chr(10))
assert lines[0].startswith('Product Name,Category,Supplier'), lines[0]
assert 'Profit (USD)' in lines[0]
assert len(lines) > 1, 'no product rows in export'
print('Header:', lines[0])
print('Sample row:', lines[1])
print('Row count:', len(lines) - 1)
print('ALL CHECKS PASSED')

admin.delete()
"
```

Expected output ends with `ALL CHECKS PASSED` (the temporary verification admin user is deleted at the end).

- [ ] **Step 4: Commit**

```bash
git add inventory/views.py inventory/urls.py
git commit -m "Add admin-only Products CSV export endpoint with profit column"
```

---

### Task 4: Frontend — Order profit display in TransactionDetail

**Files:**
- Modify: `frontend/src/components/transactions/TransactionDetail.jsx`
- Modify: `frontend/src/pages/Orders.jsx`

**Interfaces:**
- Consumes: `item.profit` (per order item, from Task 2), `order.total_profit` (from Task 2).
- Produces: new `totalProfit` prop on `TransactionDetail`; per-row and summary profit display, gated on `documentType === 'Order'`.

- [ ] **Step 1: Accept `totalProfit` prop and carry `profit` through rows**

In `frontend/src/components/transactions/TransactionDetail.jsx`, change the function signature:

```jsx
export function TransactionDetail({
  open,
  onClose,
  documentType,
  id,
  placedAt,
  exchangeRate,
  partyLabel,
  partyName,
  items,
  productKey,
}) {
```

to:

```jsx
export function TransactionDetail({
  open,
  onClose,
  documentType,
  id,
  placedAt,
  exchangeRate,
  partyLabel,
  partyName,
  items,
  productKey,
  totalProfit,
}) {
```

Then change the `rows` mapping:

```jsx
  const rows = items.map((item) => {
    const key = productKey === 'name' ? item.product : String(item.product)
    const product = productMap.get(key)
    return {
      name: product?.name ?? (productKey === 'name' ? item.product : `Product #${item.product}`),
      image: product?.images?.[0]?.image,
      quantity: item.quantity,
      unitMultiplier: item.unit_multiplier,
      unitPrice: item.unit_price,
    }
  })
```

to:

```jsx
  const rows = items.map((item) => {
    const key = productKey === 'name' ? item.product : String(item.product)
    const product = productMap.get(key)
    return {
      name: product?.name ?? (productKey === 'name' ? item.product : `Product #${item.product}`),
      image: product?.images?.[0]?.image,
      quantity: item.quantity,
      unitMultiplier: item.unit_multiplier,
      unitPrice: item.unit_price,
      profit: item.profit,
    }
  })
```

- [ ] **Step 2: Render per-item profit (Orders only)**

Change the item row block:

```jsx
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-primary">{row.name}</p>
                <p className="text-[12px] text-text-secondary tabular-nums">
                  {row.quantity}
                  {row.unitMultiplier > 1 ? ` × ${row.unitMultiplier}` : ''} @{' '}
                  {formatAmount(row.unitPrice, exchangeRate)}
                </p>
              </div>
```

to:

```jsx
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text-primary">{row.name}</p>
                <p className="text-[12px] text-text-secondary tabular-nums">
                  {row.quantity}
                  {row.unitMultiplier > 1 ? ` × ${row.unitMultiplier}` : ''} @{' '}
                  {formatAmount(row.unitPrice, exchangeRate)}
                </p>
                {documentType === 'Order' && (
                  <p className="text-[11px] text-accent-green tabular-nums">
                    Profit: {formatAmount(row.profit ?? 0, exchangeRate)}
                  </p>
                )}
              </div>
```

- [ ] **Step 3: Render Total Profit summary row (Orders only)**

Change:

```jsx
        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Total</span>
          <span className="font-semibold text-text-primary tabular-nums">{formatAmount(total, exchangeRate)}</span>
        </div>
      </div>
    </SlideOver>
  )
}
```

to:

```jsx
        <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
          <span className="text-text-secondary">Total</span>
          <span className="font-semibold text-text-primary tabular-nums">{formatAmount(total, exchangeRate)}</span>
        </div>

        {documentType === 'Order' && (
          <div className="flex items-center justify-between rounded-xl bg-canvas-2 px-3 py-2 text-[13px]">
            <span className="text-text-secondary">Total Profit</span>
            <span className="font-semibold text-accent-green tabular-nums">
              {formatAmount(totalProfit ?? 0, exchangeRate)}
            </span>
          </div>
        )}
      </div>
    </SlideOver>
  )
}
```

- [ ] **Step 4: Pass `totalProfit` from Orders.jsx**

In `frontend/src/pages/Orders.jsx`, change:

```jsx
        <TransactionDetail
          open={Boolean(detailOrder)}
          onClose={() => setDetailOrder(null)}
          documentType="Order"
          id={detailOrder.id}
          placedAt={detailOrder.placed_at}
          exchangeRate={detailOrder.exchange_rate}
          partyLabel="Customer"
          partyName={detailOrder.customer}
          items={detailOrder.items}
          productKey="id"
        />
```

to:

```jsx
        <TransactionDetail
          open={Boolean(detailOrder)}
          onClose={() => setDetailOrder(null)}
          documentType="Order"
          id={detailOrder.id}
          placedAt={detailOrder.placed_at}
          exchangeRate={detailOrder.exchange_rate}
          partyLabel="Customer"
          partyName={detailOrder.customer}
          items={detailOrder.items}
          productKey="id"
          totalProfit={detailOrder.total_profit}
        />
```

Do **not** modify `frontend/src/pages/Purchases.jsx` — it doesn't pass `totalProfit`, and its `documentType="Purchase"` already gates the new UI off.

- [ ] **Step 5: Manual verification**

With the backend (`pipenv run python manage.py runserver`) and frontend (`cd frontend && npm run dev`) running, log in, open the Orders page, and click into an order with items. Confirm:
- Each line item shows a green "Profit: $X.XX" line below the quantity/price line.
- A "Total Profit" row appears below "Total" at the bottom.
- Opening a Purchase drill-down shows neither.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/transactions/TransactionDetail.jsx frontend/src/pages/Orders.jsx
git commit -m "Show per-item and total profit in the Order drill-down view"
```

---

### Task 5: Frontend — Invoice security verification

**Files:**
- Read-only check: `frontend/src/components/invoice/Invoice.jsx`

**Interfaces:**
- None produced — this task is a verification gate, not a code change.

- [ ] **Step 1: Grep for any profit/cost leakage**

```bash
grep -n -i "profit\|cost_price\|cost price" frontend/src/components/invoice/Invoice.jsx
```

Expected: no output (no matches). If this ever produces a match after Task 4, that's a leak — remove the offending reference before proceeding.

- [ ] **Step 2: Manual print-preview check**

With the app running, open an Order, trigger the printable Invoice view, and visually confirm no cost/profit figures appear anywhere (line items, totals, or footer).

- [ ] **Step 3: Record verification (no commit needed — no files changed)**

If Step 1 and Step 2 both pass, this task is complete with no diff to commit.

---

### Task 6: Frontend — Products CSV export button

**Files:**
- Modify: `frontend/src/pages/Products.jsx`

**Interfaces:**
- Consumes: `GET /inventory/products/export/csv/` (Task 3), `ExportButton` component (`frontend/src/components/ui/ExportButton.jsx`, props `url`/`params`/`filename` — already used identically in `Purchases.jsx`/`Orders.jsx`).

- [ ] **Step 1: Import `ExportButton`**

In `frontend/src/pages/Products.jsx`, change:

```jsx
import { GlassCard } from '@/components/ui/GlassCard'
import { StockBadge } from '@/components/ui/StockBadge'
import { ProductForm } from '@/components/forms/ProductForm'
```

to:

```jsx
import { GlassCard } from '@/components/ui/GlassCard'
import { StockBadge } from '@/components/ui/StockBadge'
import { ProductForm } from '@/components/forms/ProductForm'
import { ExportButton } from '@/components/ui/ExportButton'
```

- [ ] **Step 2: Build `exportParams` from current filter state**

Directly above the `return (` in the `Products()` component (after the `openEdit` function, before `return`), add:

```jsx
  const exportParams = {}
  if (search) exportParams.search = search
  if (category !== 'all') exportParams.category_id = category
  if (supplier !== 'all') exportParams.supplier_id = supplier
  if (minPrice) exportParams.default_sell_price__gt = minPrice
  if (maxPrice) exportParams.default_sell_price__lt = maxPrice
```

- [ ] **Step 3: Render the button next to "Add product"**

Change:

```jsx
        <button
          type="button"
          onClick={openAdd}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={14} />
          Add product
        </button>
      </div>
```

to:

```jsx
        <ExportButton url="/inventory/products/export/csv/" params={exportParams} filename="products.csv" />
        <button
          type="button"
          onClick={openAdd}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={14} />
          Add product
        </button>
      </div>
```

- [ ] **Step 4: Manual verification**

With both servers running, open the Products page as an admin/staff user, apply a filter (e.g. type into search), click "Export CSV", and confirm a `products.csv` file downloads containing only the filtered rows, with a `Profit (USD)` column populated correctly.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Products.jsx
git commit -m "Add Products CSV export button with profit column"
```

---

### Task 7: Final verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Lint**

```bash
cd frontend && npm run lint
```

Expected: no errors reported.

- [ ] **Step 2: Build**

```bash
cd frontend && npm run build
```

Expected: build completes with no errors.

- [ ] **Step 3: Full manual walkthrough**

Repeat the spec's testing checklist end-to-end in one pass:
- `GET /inventory/orders/{id}/` and `/inventory/products/{id}/` include `total_profit`/`profit` with correct values.
- Order drill-down shows per-item profit + Total Profit; Purchase drill-down shows neither.
- Invoice print view shows no cost/profit data.
- Products CSV download includes a correct Profit column.

- [ ] **Step 4: Commit (if any fixes were needed during verification)**

Only commit if Steps 1-3 required code changes; otherwise this task ends with no diff.
