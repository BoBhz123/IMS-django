# Profit Tracking (Design Spec)

Date: 2026-08-04

## Goal

Expose per-item and per-order profit margins, and per-product profit, to staff
(via the API and the internal React UI), while guaranteeing profit data never
reaches the printable customer Invoice.

## Backend (Django)

### Model properties (`inventory/models.py`)

Follow the existing `total_price` property pattern (plain Python properties,
not DB annotations — list views that need DB-level sorting are out of scope
here since profit sorting wasn't requested):

```python
class Product(models.Model):
    ...
    @property
    def profit(self):
        return self.default_sell_price - self.cost_price

class OrderItem(models.Model):
    ...
    @property
    def profit(self):
        if not self.product_id:
            return None
        return (self.unit_price - self.product.cost_price) * self.quantity * self.unit_multiplier

class Order(models.Model):
    ...
    @property
    def total_profit(self):
        return sum((item.profit or 0) for item in self.items.all())
```

**Known inconsistency (accepted):** `Order.total_price` (pre-existing) sums
`quantity * unit_price`, ignoring `unit_multiplier` — a pre-existing quirk
noted in `CLAUDE.md`, out of scope to fix here. `total_profit` **does**
multiply by `unit_multiplier` (matching real revenue and the CSV export
logic), per explicit user decision. This means `total_profit` is not
derivable as a simple percentage of `total_price` — that's expected and
acceptable.

### Serializers (`inventory/serializers.py`)

Since the above are plain model properties, DRF's `ModelSerializer`
auto-detects them as read-only fields the same way `total_price` already
works — no `SerializerMethodField` needed, just add the names to `Meta.fields`:

- `ProductSerializer.fields` += `'profit'`
- `OrderItemSerializer.fields` += `'profit'`
- `OrderSerializer.fields` += `'total_profit'`

`SimpleProductSerializer` is **not** changed — it deliberately excludes cost
data (used in order-item product pickers) and profit must not leak there.

### Products CSV export

New `ExportProductsCSVView` in `inventory/views.py`, mirroring
`ExportOrdersCSVView`/`ExportPurchasesCSVView` exactly: `APIView`,
`permission_classes = [IsAdminUser]`, `csv.writer`, one row per `Product`.

Columns: `Product Name, Category, Supplier, Stock Quantity, Cost Price (USD),
Sell Price (USD), Profit (USD)`.

Wired in `inventory/urls.py` as `path('products/export/csv/',
views.ExportProductsCSVView.as_view(), name='export-products-csv')`, next to
the other two export routes.

## Frontend (React)

### `TransactionDetail.jsx`

Add a per-item profit line and a "Total Profit" summary row, both rendered
**only when `documentType === 'Order'`** (the component is shared with
Purchases, where profit has no meaning). Values are read directly from the
API response (`item.profit`, `order.total_profit`) — not recomputed
client-side, so the pricing formula stays in one place (the backend).

### `Invoice.jsx`

Security boundary. Verified current implementation renders no cost/profit
data. No fields will be added. Re-verify after backend changes land in case
profit fields leak in through a spread of the order/item objects passed to
the component.

### `Products.jsx`

Add `<ExportButton url="/inventory/products/export/csv/" params={exportParams}
filename="products.csv" />`, matching the existing usage pattern in
`Purchases.jsx`/`Orders.jsx`. `exportParams` mirrors the page's current
filter state (search, category, supplier, price range).

## Testing

No automated test suite exists for this app (`inventory/tests.py` is the
Django stub — see `CLAUDE.md`). Verification is manual:

- Hit `/inventory/orders/{id}/` and `/inventory/products/{id}/` and confirm
  `profit`/`total_profit` appear with correct values.
- Open an Order drill-down in the UI and confirm per-item profit + total
  profit render.
- Open a Purchase drill-down and confirm no profit UI appears.
- Print/preview an Invoice and confirm no profit/cost data appears anywhere.
- Download the Products CSV and confirm the Profit column is correct.
- `npm run lint` and `npm run build` must be clean.

## Out of scope

- Fixing the pre-existing `Order.total_price` / `unit_multiplier` bug.
- DB-level annotation/sorting on profit fields.
- Any change to `SimpleProductSerializer`.
- Any change to stock-adjustment transactional logic.
