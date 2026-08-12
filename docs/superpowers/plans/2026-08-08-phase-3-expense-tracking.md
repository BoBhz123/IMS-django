# Phase 3 — Expense Tracking & Financial Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account-scoped expense records, plus a financial reporting model with one honest definition of profit — gross profit from snapshotted COGS, net profit after expenses, and inventory spend kept separate as cash flow.

**Architecture:** Cost of goods sold becomes a stored fact (`OrderItem.unit_cost_price`) instead of a live read of `product.cost_price`, so historical profit stops changing when a product's cost is edited. The date-window filtering already repeated across `AnalyticsView` is extracted into `inventory/reporting.py::DateWindow` *before* expenses are added, so the same window provably reaches orders and expenses. `Expense` is then ordinary account-scoped CRUD, and `AnalyticsView` gains the metrics.

**Tech Stack:** Django 6 / DRF, `django-filter`, Postgres. Frontend: React 19 + Vite + Tailwind, Vitest.

## Global Constraints

- **Full design:** `docs/superpowers/specs/2026-08-08-expense-tracking-design.md`. Read it before Task 1.
- `pipenv run python manage.py test` must end in `OK` before the phase is complete. It is the mandatory final check.
- Frontend gates: `cd frontend && npm test`, `npm run lint`, and `npm run build` must all pass. The build catches import errors the tests and linter miss.
- **No browser automation / Claude-in-Chrome for verification.** Django test runner, Vitest, or direct API response checks only.
- **No new Python or JS dependencies.**
- **Nothing in this plan touches Heroku.** No deploys, no `pg:reset`, no config vars.
- **Do not alter the stock side-effect.** `CreateOrderSerializer.create()` deducts `quantity * unit_multiplier` under `select_for_update()` inside `@transaction.atomic`. Task 1 adds a field to the rows being created in that block and must leave the locking, the re-check, and the `F()` stock updates exactly as they are.
- **All amounts are USD.** LBP is a frontend display toggle only. This phase introduces no currency handling and no conversion.
- **Every test needs an `Account`.** Use `AccountFixtureMixin.make_account_user()` at the top of `inventory/tests.py`; a bare `Product.objects.create(...)` fails the not-null `account` constraint.
- Commit after every task.

## File Structure

**Create:**
- `inventory/reporting.py` — `DateWindow`, `PERIOD_WINDOW_DAYS`. Pure query-filtering logic, no DRF, no HTTP.
- `frontend/src/lib/expenses.js` — category labels and options. Pure, unit-testable without React.
- `frontend/src/lib/expenses.test.js`
- `frontend/src/pages/Expenses.jsx`
- `frontend/src/pages/Expenses.test.jsx`
- `frontend/src/components/forms/ExpenseForm.jsx`

**Modify:**
- `inventory/models.py` — `OrderItem.unit_cost_price`, `LINE_COGS`, `items_cogs`, `Expense`
- `inventory/serializers.py` — snapshot the cost on create; `ExpenseSerializer`
- `inventory/views.py` — `DateWindow` refactor, new analytics metrics, `ExpenseViewSet`, CSV export cost
- `inventory/filters.py` — `ExpenseFilter`
- `inventory/urls.py` — register `expenses`
- `inventory/admin.py` — `ExpenseAdmin`; snapshot cost on the order CSV admin action
- `inventory/management/commands/seed_data.py` — seed expenses
- `inventory/tests.py` — snapshot, window, expense, and analytics suites
- `frontend/src/pages/Dashboard.jsx` — new tiles, `inventory_outlays` rename, raw-number payload
- `frontend/src/App.jsx`, `frontend/src/components/layout/Dock.jsx` — route and nav entry
- `HISTORY.md`, `CLAUDE.md`

---

### Task 1: Snapshot the cost of goods sold

**Files:**
- Modify: `inventory/models.py`, `inventory/serializers.py`, `inventory/views.py`, `inventory/admin.py`, `inventory/management/commands/seed_data.py`, `inventory/tests.py`
- Create: `inventory/migrations/00XX_orderitem_unit_cost_price.py` (generated, then edited)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `OrderItem.unit_cost_price` — `DecimalField(max_digits=9, decimal_places=2)`, non-null.
  - `LINE_COGS` — `F('items__quantity') * F('items__unit_multiplier') * F('items__unit_cost_price')`, for `.annotate(...)`/`.aggregate(Sum(LINE_COGS))` on an `Order` queryset.
  - `items_cogs(items)` — Python-side equivalent for prefetched items.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class CostSnapshotTests(AccountFixtureMixin, TestCase):
    """
    Profit must be reproducible. Before this, OrderItem.profit read product.cost_price
    live, so raising a product's cost silently restated every past month.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('snap')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=100, account=self.account,
        )

    def place_order(self, quantity=2, unit_price='10.00', unit_multiplier=1):
        response = self.client.post(
            '/inventory/orders/',
            {
                'items': [{
                    'product': self.product.id,
                    'quantity': quantity,
                    'unit_price': unit_price,
                    'unit_multiplier': unit_multiplier,
                }],
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        return Order.objects.get(pk=response.data['id'])

    def test_the_cost_at_sale_time_is_recorded_on_the_line(self):
        order = self.place_order()
        self.assertEqual(order.items.first().unit_cost_price, Decimal('4.00'))

    def test_changing_the_product_cost_does_not_move_historical_profit(self):
        order = self.place_order(quantity=2)
        before = order.total_profit

        self.product.cost_price = Decimal('9.00')
        self.product.save()

        order.refresh_from_db()
        self.assertEqual(order.total_profit, before)
        self.assertEqual(before, Decimal('12.00'))  # (10 - 4) * 2 * 1

    def test_a_later_order_records_the_new_cost(self):
        self.place_order()
        self.product.cost_price = Decimal('9.00')
        self.product.save()
        later = self.place_order()
        self.assertEqual(later.items.first().unit_cost_price, Decimal('9.00'))

    def test_profit_accounts_for_the_unit_multiplier(self):
        order = self.place_order(quantity=3, unit_price='10.00', unit_multiplier=6)
        self.assertEqual(order.total_profit, Decimal('108.00'))  # (10 - 4) * 3 * 6

    def test_rows_created_outside_the_serializer_still_get_a_cost(self):
        # The admin inline and seed_data build OrderItems directly. save() fills the
        # snapshot so those paths cannot silently record a zero cost.
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        item = OrderItem.objects.create(
            order=order, product=self.product, quantity=1, unit_price=Decimal('10.00'),
        )
        self.assertEqual(item.unit_cost_price, Decimal('4.00'))

    def test_an_explicit_cost_is_not_overwritten_by_save(self):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        item = OrderItem.objects.create(
            order=order, product=self.product, quantity=1,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('1.50'),
        )
        self.assertEqual(item.unit_cost_price, Decimal('1.50'))

    def test_the_aggregate_matches_the_python_property(self):
        # LINE_COGS and items_cogs are duplicated expressions; a test pins them together
        # because the analytics view uses one and the serializers use the other.
        order = self.place_order(quantity=3, unit_multiplier=6)
        aggregated = (
            Order.objects.filter(pk=order.pk).aggregate(total=Sum(LINE_COGS))['total']
        )
        self.assertEqual(aggregated, items_cogs(order.items.all()))
        self.assertEqual(aggregated, Decimal('72.00'))  # 4 * 3 * 6

    def test_the_csv_export_reports_the_snapshot_cost(self):
        self.place_order()
        self.product.cost_price = Decimal('9.00')
        self.product.save()

        response = self.client.get(
            '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn('4.00', body)
        self.assertNotIn('9.00', body)
```

Add to the imports at the top of `inventory/tests.py` (keep the existing ones):

```python
from decimal import Decimal

from django.db.models import Sum

from .models import LINE_COGS, items_cogs
```

- [ ] **Step 2: Run and verify failure**

Run: `pipenv run python manage.py test inventory.tests.CostSnapshotTests`
Expected: FAIL — `ImportError: cannot import name 'LINE_COGS'`.

- [ ] **Step 3: Add the field and the expressions**

In `inventory/models.py`, directly below the existing `items_total` function, add:

```python
# The cost half of LINE_TOTAL. Reads the snapshot on the line, never product.cost_price —
# joining out to the product would make every historical figure move the next time somebody
# corrects a cost.
LINE_COGS = (
    models.F('items__quantity')
    * models.F('items__unit_multiplier')
    * models.F('items__unit_cost_price')
)


def items_cogs(items):
    """Python-side equivalent of Sum(LINE_COGS), for already-loaded (prefetched) items."""
    return sum(
        item.quantity * item.unit_multiplier * item.unit_cost_price for item in items
    )
```

In `inventory/models.py`, replace the `OrderItem` body's `profit` property and add the field:

```python
class OrderItem(models.Model):
     order = models.ForeignKey(Order ,on_delete=models.CASCADE,related_name='items')
     product = models.ForeignKey( Product,
                                 on_delete=models.
                                 PROTECT, related_name='orderitems',blank=True)
     quantity = models.PositiveSmallIntegerField(default=1)
     unit_price = models.DecimalField(max_digits=9, decimal_places=2, validators=[MinValueValidator(0)])
     unit_multiplier = models.PositiveSmallIntegerField(default=1)
     # What this item cost us at the moment it was sold. Snapshotted, not derived: the
     # product's cost_price is a current figure that gets corrected, and profit computed
     # from it restates history every time it moves.
     unit_cost_price = models.DecimalField(
         max_digits=9, decimal_places=2, validators=[MinValueValidator(0)],
     )

     def save(self, *args, **kwargs):
         # Covers the admin inline and seed_data, which build rows directly. It does NOT
         # cover CreateOrderSerializer — bulk_create bypasses save() — which is why that
         # serializer stamps the cost itself.
         if self.unit_cost_price is None and self.product_id:
             self.unit_cost_price = self.product.cost_price
         super().save(*args, **kwargs)

     @property
     def profit(self):
         return (self.unit_price - self.unit_cost_price) * self.quantity * self.unit_multiplier
```

- [ ] **Step 4: Generate the migration**

Run: `pipenv run python manage.py makemigrations inventory --name orderitem_unit_cost_price`

When prompted for a default for the non-null field, quit (`2`) — the migration is edited by hand in
the next step so existing rows can be backfilled from their product.

If `makemigrations` will not produce a file without a default, temporarily add `null=True` to the
field, generate, then restore `null=False` in the model and hand-edit the migration as below.

- [ ] **Step 5: Make the migration add, backfill, then tighten**

Replace the generated migration's `operations` with:

```python
    operations = [
        # Three steps in one file. Adding the column non-null in a single shot would fail on
        # any existing row, and adding it with a default of 0 would record a 100% margin for
        # every order ever placed.
        migrations.AddField(
            model_name='orderitem',
            name='unit_cost_price',
            field=models.DecimalField(
                max_digits=9, decimal_places=2, null=True,
                validators=[django.core.validators.MinValueValidator(0)],
            ),
        ),
        migrations.RunPython(backfill_unit_cost_price, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='orderitem',
            name='unit_cost_price',
            field=models.DecimalField(
                max_digits=9, decimal_places=2,
                validators=[django.core.validators.MinValueValidator(0)],
            ),
        ),
    ]
```

and add above the `Migration` class, in the same file:

```python
def backfill_unit_cost_price(apps, schema_editor):
    """
    Stamp existing lines with their product's cost as it stands today.

    This is an approximation and the best one available — the true cost at the time of each
    historical sale was never recorded and cannot be recovered. Every order placed after
    this migration is exact. A Subquery rather than F('product__cost_price') because
    update() refuses to follow a join.
    """
    OrderItem = apps.get_model('inventory', 'OrderItem')
    Product = apps.get_model('inventory', 'Product')
    OrderItem.objects.filter(unit_cost_price__isnull=True).update(
        unit_cost_price=Subquery(
            Product.objects.filter(pk=OuterRef('product_id')).values('cost_price')[:1]
        ),
    )
```

with these imports at the top of the migration file:

```python
import django.core.validators
from django.db import migrations, models
from django.db.models import OuterRef, Subquery
```

- [ ] **Step 6: Stamp the cost when an order is created**

In `inventory/serializers.py`, inside `CreateOrderSerializer.create()`, replace the
`OrderItem.objects.bulk_create(...)` call with:

```python
        # bulk_create bypasses OrderItem.save(), so the snapshot is taken here. Read off the
        # rows already locked above rather than re-querying: that is the cost as it stood at
        # the instant this sale was committed.
        cost_by_product_id = {product.id: product.cost_price for product in locked}

        order = Order.objects.create(**validated_data)
        OrderItem.objects.bulk_create([
            OrderItem(
                order=order,
                unit_cost_price=cost_by_product_id[item_data['product'].id],
                **item_data,
            )
            for item_data in items_data
        ])
```

and delete the `order = Order.objects.create(**validated_data)` line that previously sat above
`bulk_create` — it moves into the block above so `locked` is consumed before the order row exists.

Note `locked` is a queryset; evaluate it once by building the dict from it, which the existing
`_insufficient_stock_errors(units_by_id, locked)` call already forces.

- [ ] **Step 7: Point the CSV exports at the snapshot**

In `inventory/views.py`, in `ExportOrdersCSVView`, replace the `Cost Price (USD)` cell source so it
reads `item.unit_cost_price` rather than `item.product.cost_price`, and replace the profit aggregate
with one built from the snapshot:

```python
        profit_by_order = {
            row['order_id']: row['profit'] or 0
            for row in (
                Order.objects
                .filter(items__in=items)
                .values('id')
                .annotate(profit=Sum(
                    (F('items__unit_price') - F('items__unit_cost_price'))
                    * F('items__quantity')
                    * F('items__unit_multiplier')
                ))
                .values_list('id', 'profit')
                .values('order_id', 'profit')
            )
        }
```

If the existing aggregate already reads `product__cost_price`, the change is limited to swapping that
reference for `items__unit_cost_price` and dropping the join — keep whatever grouping shape is
already there, since it was written to kill an N+1 and that fix must survive.

In `inventory/admin.py`, `export_orders_to_csv` reports only a Total Value column and has no cost or
profit column, so it needs no change here. Confirm that by reading it before moving on — the two
exporters have near-identical names and a formula fix usually needs both.

- [ ] **Step 8: Keep the seed command working**

In `inventory/management/commands/seed_data.py`, the `OrderItem.objects.create(...)` call goes
through `save()` and is already covered. Add nothing; run the seed in Step 10 to confirm.

- [ ] **Step 9: Run and verify it passes**

Run: `pipenv run python manage.py migrate`
Expected: applies cleanly.

Run: `pipenv run python manage.py test inventory.tests.CostSnapshotTests`
Expected: OK, 8 tests.

Run: `pipenv run python manage.py test`
Expected: ends with `OK`. Existing order and export tests must still pass — if one fails on a missing
`unit_cost_price`, that call site needs the field, not the test loosened.

- [ ] **Step 10: Confirm the seed still runs**

Run: `pipenv run python manage.py seed_data --account "Demo Business" --owner demo@example.com`
Expected: completes and reports created rows.

- [ ] **Step 11: Commit**

```bash
git add inventory
git commit -m "feat: snapshot unit cost at sale so profit stops moving"
```

---

### Task 2: One date window, applied everywhere

**Files:**
- Create: `inventory/reporting.py`
- Modify: `inventory/views.py`, `inventory/tests.py`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `PERIOD_WINDOW_DAYS: dict[str, int]`
  - `DateWindow` — frozen dataclass with `from_query_params(params) -> DateWindow` and
    `apply(queryset, field) -> QuerySet`.

This task is a **pure refactor**. `AnalyticsView` must return byte-identical responses afterwards.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class DateWindowTests(AccountFixtureMixin, TestCase):
    """
    One window object, applied to every queryset a report touches. Orders filtered by a
    window that expenses escaped would misstate net profit with no error anywhere — which
    is the whole reason this is a shared object and not four copies of five if-statements.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('win')
        self.category = Category.objects.create(name='Widgets', account=self.account)

    def make_order(self, when):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def test_no_parameters_filters_nothing(self):
        self.make_order(timezone.now() - timedelta(days=900))
        window = DateWindow.from_query_params({})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_year_and_month(self):
        self.make_order(datetime(2026, 3, 4, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 5, 4, 12, 0, tzinfo=dt_timezone.utc))

        window = DateWindow.from_query_params({'year': '2026', 'month': '3'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_start_and_end_dates_are_inclusive(self):
        self.make_order(datetime(2026, 3, 1, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 3, 31, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 4, 1, 12, 0, tzinfo=dt_timezone.utc))

        window = DateWindow.from_query_params(
            {'start_date': '2026-03-01', 'end_date': '2026-03-31'}
        )
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 2)

    def test_period_last_month(self):
        self.make_order(timezone.now() - timedelta(days=5))
        self.make_order(timezone.now() - timedelta(days=200))

        window = DateWindow.from_query_params({'period': 'last_month'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_an_unrecognised_period_filters_nothing(self):
        # 'all_time' is deliberately absent from PERIOD_WINDOW_DAYS and means "no filter".
        self.make_order(timezone.now() - timedelta(days=900))
        window = DateWindow.from_query_params({'period': 'all_time'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_blank_parameters_are_ignored(self):
        # The SPA sends ?year=&month= when its selects are cleared. Treating '' as a value
        # would filter on the empty string and raise.
        self.make_order(timezone.now())
        window = DateWindow.from_query_params({'year': '', 'month': '', 'period': ''})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_the_same_window_applies_across_a_relation(self):
        order = self.make_order(datetime(2026, 3, 4, 12, 0, tzinfo=dt_timezone.utc))
        product = Product.objects.create(
            name='W', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=5, account=self.account,
        )
        OrderItem.objects.create(
            order=order, product=product, quantity=1, unit_price=Decimal('2.00'),
        )

        window = DateWindow.from_query_params({'year': '2026', 'month': '3'})
        self.assertEqual(
            window.apply(OrderItem.objects.all(), 'order__placed_at').count(), 1,
        )
        window = DateWindow.from_query_params({'year': '2026', 'month': '4'})
        self.assertEqual(
            window.apply(OrderItem.objects.all(), 'order__placed_at').count(), 0,
        )
```

Add to the imports at the top of `inventory/tests.py`:

```python
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone

from django.utils import timezone

from .reporting import DateWindow
```

- [ ] **Step 2: Run and verify failure**

Run: `pipenv run python manage.py test inventory.tests.DateWindowTests`
Expected: FAIL — `ModuleNotFoundError: No module named 'inventory.reporting'`.

- [ ] **Step 3: Write the module**

Create `inventory/reporting.py`:

```python
"""
Date windowing for the reporting endpoints.

Deliberately free of DRF and HTTP: the window is the piece that has to be identical across
every queryset a report touches, so it is testable directly rather than only through a view.
A window applied to orders but not to expenses misstates net profit and raises nothing.
"""

from dataclasses import dataclass
from datetime import timedelta

from django.utils import timezone

# 'all_time' is intentionally absent: it means "no date filtering", the default behaviour.
PERIOD_WINDOW_DAYS = {
    'last_month': 30,
    'last_year': 365,
}


@dataclass(frozen=True)
class DateWindow:
    """
    The date filter a report was asked for, applicable to any queryset.

    `apply` takes the field name because the same window has to reach `Order.placed_at`,
    `Expense.spent_at`, and `OrderItem.order__placed_at`.
    """

    year: str | None = None
    month: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    period: str | None = None

    @classmethod
    def from_query_params(cls, params):
        # `or None` rather than a bare .get(): the SPA sends ?year= with an empty value when
        # its selects are cleared, and filtering on '' raises rather than matching everything.
        return cls(
            year=params.get('year') or None,
            month=params.get('month') or None,
            start_date=params.get('start_date') or None,
            end_date=params.get('end_date') or None,
            period=params.get('period') or None,
        )

    def apply(self, queryset, field):
        if self.period in PERIOD_WINDOW_DAYS:
            cutoff = timezone.now() - timedelta(days=PERIOD_WINDOW_DAYS[self.period])
            queryset = queryset.filter(**{f'{field}__gte': cutoff})
        if self.year:
            queryset = queryset.filter(**{f'{field}__year': self.year})
        if self.month:
            queryset = queryset.filter(**{f'{field}__month': self.month})
        if self.start_date:
            queryset = queryset.filter(**{f'{field}__date__gte': self.start_date})
        if self.end_date:
            queryset = queryset.filter(**{f'{field}__date__lte': self.end_date})
        return queryset
```

- [ ] **Step 4: Refactor AnalyticsView onto it**

In `inventory/views.py`, delete the module-level `PERIOD_WINDOW_DAYS` dict (it moved to
`reporting.py`) and import the new names:

```python
from .reporting import PERIOD_WINDOW_DAYS, DateWindow
```

Then in `AnalyticsView.get`, replace everything from `year = request.query_params.get('year')` down to
the end of the `if end_date:` block with:

```python
        group_by = request.query_params.get('group_by')

        window = DateWindow.from_query_params(request.query_params)
        orders = window.apply(orders, 'placed_at')
        purchases = window.apply(purchases, 'placed_at')
        products = window.apply(products, 'order__placed_at')
```

Leave the aggregates, the response dict, and `_build_series` untouched — this step changes how the
filtering is expressed and nothing about what it returns.

- [ ] **Step 5: Run and verify nothing changed**

Run: `pipenv run python manage.py test inventory.tests.DateWindowTests`
Expected: OK, 7 tests.

Run: `pipenv run python manage.py test`
Expected: ends with `OK`. Every pre-existing analytics test must still pass untouched — that is the
proof this refactor was behaviour-preserving. If one needs editing, the refactor changed behaviour and
is wrong.

- [ ] **Step 6: Commit**

```bash
git add inventory
git commit -m "refactor: one DateWindow for every reporting queryset"
```

---

### Task 3: The Expense model

**Files:**
- Modify: `inventory/models.py`, `inventory/admin.py`, `inventory/tests.py`
- Create: `inventory/migrations/00XX_expense.py` (generated)

**Interfaces:**
- Consumes: `accounts.models.Account`.
- Produces: `Expense` with `ExpenseCategory` choices; fields `account`, `description`, `amount`,
  `category`, `spent_at`, `created_at`.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class ExpenseModelTests(AccountFixtureMixin, TestCase):
    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('exp')

    def test_spent_at_defaults_to_now_but_is_writable(self):
        # default=timezone.now, never auto_now_add. A receipt entered Friday for a Tuesday
        # spend has to land in Tuesday's month or that month's net profit is wrong.
        backdated = timezone.now() - timedelta(days=45)
        expense = Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal('500.00'),
            category=ExpenseCategory.RENT, spent_at=backdated,
        )
        self.assertEqual(expense.spent_at, backdated)

    def test_created_at_records_when_it_was_entered_not_when_it_was_spent(self):
        backdated = timezone.now() - timedelta(days=45)
        expense = Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal('500.00'),
            spent_at=backdated,
        )
        self.assertGreater(expense.created_at, backdated)

    def test_category_defaults_to_other(self):
        expense = Expense.objects.create(
            account=self.account, description='Something', amount=Decimal('1.00'),
        )
        self.assertEqual(expense.category, ExpenseCategory.OTHER)

    def test_a_negative_amount_is_rejected(self):
        expense = Expense(
            account=self.account, description='Refund', amount=Decimal('-5.00'),
        )
        with self.assertRaises(ValidationError):
            expense.full_clean()

    def test_an_unknown_category_is_rejected(self):
        expense = Expense(
            account=self.account, description='X', amount=Decimal('1.00'),
            category='helicopters',
        )
        with self.assertRaises(ValidationError):
            expense.full_clean()

    def test_newest_first_by_spend_date(self):
        older = Expense.objects.create(
            account=self.account, description='Older', amount=Decimal('1.00'),
            spent_at=timezone.now() - timedelta(days=10),
        )
        newer = Expense.objects.create(
            account=self.account, description='Newer', amount=Decimal('1.00'),
            spent_at=timezone.now(),
        )
        self.assertEqual(list(Expense.objects.all()), [newer, older])
```

Add to the imports at the top of `inventory/tests.py`:

```python
from django.core.exceptions import ValidationError

from .models import Expense, ExpenseCategory
```

- [ ] **Step 2: Run and verify failure**

Run: `pipenv run python manage.py test inventory.tests.ExpenseModelTests`
Expected: FAIL — `ImportError: cannot import name 'Expense'`.

- [ ] **Step 3: Write the model**

Append to `inventory/models.py`:

```python
class ExpenseCategory(models.TextChoices):
    """
    A fixed list rather than free text. Free text fragments 'Rent', 'rent' and 'Rent ' into
    separate rows in any per-category breakdown, which is the main reason to record a
    category at all. Adding one later is an edit here, not a migration.
    """

    RENT = 'rent', 'Rent'
    UTILITIES = 'utilities', 'Utilities'
    SALARIES = 'salaries', 'Salaries'
    MARKETING = 'marketing', 'Marketing'
    SOFTWARE = 'software', 'Software'
    TRANSPORT = 'transport', 'Transport'
    MAINTENANCE = 'maintenance', 'Maintenance'
    TAXES_FEES = 'taxes_fees', 'Taxes & Fees'
    OTHER = 'other', 'Other'


class Expense(models.Model):
    """
    Operational overhead — rent, salaries, software. Deliberately not inventory: stock
    spend is a cash movement recorded by Purchase, and folding it in here would corrupt the
    margin that gross profit is supposed to measure.

    Amounts are USD, like every other price in this app. LBP is a display toggle.
    """

    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='expenses')
    description = models.CharField(max_length=255)
    amount = models.DecimalField(
        max_digits=10, decimal_places=2, validators=[MinValueValidator(0)],
    )
    category = models.CharField(
        max_length=32, choices=ExpenseCategory.choices, default=ExpenseCategory.OTHER,
        db_index=True,
    )
    # When the money was spent, which is not when the row was made. default=timezone.now and
    # never auto_now_add: auto_now_add ignores assignment, so a receipt entered on Friday for
    # a Tuesday spend would land in the wrong month and misstate that month's net profit.
    spent_at = models.DateTimeField(default=timezone.now, db_index=True)
    # When it was entered. An audit trail worth keeping on a money record.
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-spent_at']
        indexes = [
            models.Index(fields=['account', '-spent_at'], name='expense_account_date_idx'),
        ]

    def __str__(self):
        return f'{self.description} (${self.amount})'
```

Confirm `from django.utils import timezone` and `MinValueValidator` are already imported at the top of
`inventory/models.py`; add whichever is missing.

- [ ] **Step 4: Register it in the admin**

Append to `inventory/admin.py`:

```python
@admin.register(models.Expense)
class ExpenseAdmin(admin.ModelAdmin):
    list_display = ['description', 'category', 'amount', 'spent_at', 'account']
    list_filter = ['category', 'account']
    search_fields = ['description']
    date_hierarchy = 'spent_at'
```

- [ ] **Step 5: Migrate**

Run: `pipenv run python manage.py makemigrations inventory --name expense`
Expected: one `CreateModel` for `Expense`.

Run: `pipenv run python manage.py migrate`
Expected: applies cleanly.

- [ ] **Step 6: Run and verify it passes**

Run: `pipenv run python manage.py test inventory.tests.ExpenseModelTests`
Expected: OK, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add inventory
git commit -m "feat: Expense model with a backdatable spend date"
```

---

### Task 4: Expense CRUD

**Files:**
- Modify: `inventory/serializers.py`, `inventory/filters.py`, `inventory/views.py`, `inventory/urls.py`, `inventory/management/commands/seed_data.py`, `inventory/tests.py`

**Interfaces:**
- Consumes: `Expense`, `ExpenseCategory` (Task 3).
- Produces: `/inventory/expenses/` — paginated, account-scoped CRUD. Serializer fields:
  `id`, `description`, `amount`, `category`, `category_display`, `spent_at`, `created_at`.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class ExpenseAPITests(AccountFixtureMixin, TestCase):
    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('e1')
        self.other_account, _, self.other_client, self.other_header = self.make_account_user('e2')
        self.url = '/inventory/expenses/'

    def make_expense(self, account=None, **overrides):
        fields = {
            'account': account or self.account,
            'description': 'Office rent',
            'amount': Decimal('500.00'),
            'category': ExpenseCategory.RENT,
        }
        fields.update(overrides)
        return Expense.objects.create(**fields)

    def test_create_stamps_the_callers_account(self):
        response = self.client.post(
            self.url,
            {'description': 'Rent', 'amount': '500.00', 'category': 'rent'},
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Expense.objects.get().account, self.account)

    def test_the_client_cannot_choose_another_account(self):
        self.client.post(
            self.url,
            {
                'description': 'Rent', 'amount': '500.00', 'category': 'rent',
                'account': self.other_account.id,
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(Expense.objects.get().account, self.account)

    def test_list_shows_only_the_callers_expenses(self):
        self.make_expense()
        self.make_expense(account=self.other_account, description='Theirs')

        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['description'], 'Office rent')

    def test_another_account_cannot_read_one_by_id(self):
        expense = self.make_expense()
        response = self.other_client.get(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.other_header,
        )
        self.assertEqual(response.status_code, 404)

    def test_another_account_cannot_delete_one(self):
        expense = self.make_expense()
        response = self.other_client.delete(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.other_header,
        )
        self.assertEqual(response.status_code, 404)
        self.assertTrue(Expense.objects.filter(pk=expense.pk).exists())

    def test_update_and_delete_work_for_the_owner(self):
        expense = self.make_expense()
        patched = self.client.patch(
            f'{self.url}{expense.id}/', {'amount': '600.00'},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(patched.status_code, 200)
        expense.refresh_from_db()
        self.assertEqual(expense.amount, Decimal('600.00'))

        deleted = self.client.delete(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(deleted.status_code, 204)

    def test_a_backdated_spend_date_is_accepted(self):
        backdated = (timezone.now() - timedelta(days=45)).isoformat()
        response = self.client.post(
            self.url,
            {
                'description': 'Late receipt', 'amount': '80.00',
                'category': 'transport', 'spent_at': backdated,
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertLess(Expense.objects.get().spent_at, timezone.now() - timedelta(days=40))

    def test_the_response_carries_a_human_readable_category(self):
        self.make_expense(category=ExpenseCategory.TAXES_FEES)
        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.data['results'][0]['category_display'], 'Taxes & Fees')

    def test_filtering_by_category(self):
        self.make_expense(category=ExpenseCategory.RENT)
        self.make_expense(category=ExpenseCategory.SOFTWARE, description='Hosting')

        response = self.client.get(
            self.url, {'category': 'software'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)

    def test_filtering_by_spend_date_range(self):
        self.make_expense(spent_at=timezone.now() - timedelta(days=40))
        self.make_expense(spent_at=timezone.now() - timedelta(days=2), description='Recent')

        cutoff = (timezone.now() - timedelta(days=10)).date().isoformat()
        response = self.client.get(
            self.url, {'spent_after': cutoff}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['description'], 'Recent')

    def test_search_matches_the_description(self):
        self.make_expense(description='Generator diesel')
        self.make_expense(description='Office rent')

        response = self.client.get(
            self.url, {'search': 'diesel'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)

    def test_ordering_by_amount(self):
        self.make_expense(amount=Decimal('10.00'))
        self.make_expense(amount=Decimal('900.00'), description='Big')

        response = self.client.get(
            self.url, {'ordering': '-amount'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['results'][0]['description'], 'Big')

    def test_anonymous_callers_are_rejected(self):
        self.assertEqual(APIClient().get(self.url).status_code, 401)
```

- [ ] **Step 2: Run and verify failure**

Run: `pipenv run python manage.py test inventory.tests.ExpenseAPITests`
Expected: FAIL — 404 on every request, because `/inventory/expenses/` is not routed.

- [ ] **Step 3: Write the serializer**

Append to `inventory/serializers.py`:

```python
class ExpenseSerializer(serializers.ModelSerializer):
    """
    No AccountScopedSerializerMixin here, and that is not an omission: Expense has no
    relational field other than `account`, so there is nothing to narrow. The account is
    stamped by AccountScopedMixin on the viewset and is not writable.
    """

    category_display = serializers.CharField(source='get_category_display', read_only=True)

    class Meta:
        model = Expense
        fields = [
            'id', 'description', 'amount', 'category', 'category_display',
            'spent_at', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']
```

- [ ] **Step 4: Write the filter**

Append to `inventory/filters.py`:

```python
class ExpenseFilter(FilterSet):
    # Explicit range filters rather than a `fields` dict: 'spent_after' reads better in a
    # query string than 'spent_at__gte', and the frontend builds these by hand.
    spent_after = filters.DateFilter(field_name='spent_at', lookup_expr='date__gte')
    spent_before = filters.DateFilter(field_name='spent_at', lookup_expr='date__lte')
    min_amount = filters.NumberFilter(field_name='amount', lookup_expr='gte')
    max_amount = filters.NumberFilter(field_name='amount', lookup_expr='lte')

    class Meta:
        model = Expense
        fields = ['category']
```

and add `Expense` to the model import at the top of `inventory/filters.py`:

```python
from .models import Product,Category,Purchase,Order,Expense
```

- [ ] **Step 5: Write the viewset**

Append to `inventory/views.py`:

```python
class ExpenseViewSet(AccountScopedMixin, ModelViewSet):
    queryset = Expense.objects.all()
    serializer_class = ExpenseSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = ExpenseFilter
    search_fields = ['description']
    ordering_fields = ['spent_at', 'amount', 'category']
    ordering = ['-spent_at']
    pagination_class = DefaultPagination
```

and extend the model/filter imports at the top of `inventory/views.py`:

```python
from .filters import ProductFilter,PurchaseFilter,OrderFilter,ExpenseFilter
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order,Expense,LINE_TOTAL,LINE_COGS
```

- [ ] **Step 6: Route it**

In `inventory/urls.py`, beside the other router registrations:

```python
router.register('expenses', views.ExpenseViewSet, basename='expenses')
```

- [ ] **Step 7: Seed some expenses**

In `inventory/management/commands/seed_data.py`, add an `--expenses` argument defaulting to `30`, and
a `_seed_expenses(self, account, count)` method called from `_seed_all`:

```python
    def _seed_expenses(self, account, count):
        from inventory.models import Expense, ExpenseCategory

        categories = [choice[0] for choice in ExpenseCategory.choices]
        descriptions = {
            'rent': 'Shop rent', 'utilities': 'Electricity and water',
            'salaries': 'Staff wages', 'marketing': 'Instagram ads',
            'software': 'Accounting software', 'transport': 'Delivery fuel',
            'maintenance': 'Fridge repair', 'taxes_fees': 'Municipality fee',
            'other': 'Miscellaneous',
        }
        created = 0
        for _ in range(count):
            category = random.choice(categories)
            Expense.objects.create(
                account=account,
                description=descriptions[category],
                amount=Decimal(str(round(random.uniform(20, 900), 2))),
                category=category,
                spent_at=self._random_datetime_within(330),
            )
            created += 1
        self.stdout.write(f"Expenses created: {created}")
```

Add the argument:

```python
        parser.add_argument(
            "--expenses", type=int, default=30, help="Number of expenses to create."
        )
```

and call it from `_seed_all` alongside the other seeders:

```python
        self._seed_expenses(account, options["expenses"])
```

- [ ] **Step 8: Run and verify it passes**

Run: `pipenv run python manage.py test inventory.tests.ExpenseAPITests`
Expected: OK, 13 tests.

Run: `pipenv run python manage.py seed_data --account "Demo Business" --owner demo@example.com`
Expected: reports `Expenses created: 30` among the rest.

- [ ] **Step 9: Commit**

```bash
git add inventory
git commit -m "feat: account-scoped expense CRUD"
```

---

### Task 5: The financial metrics

**Files:**
- Modify: `inventory/views.py`, `inventory/tests.py`

**Interfaces:**
- Consumes: `LINE_COGS` (Task 1), `DateWindow` (Task 2), `Expense` (Task 3).
- Produces: `GET /inventory/analytics/` returning `total_revenue`, `total_cogs`, `gross_profit`,
  `total_expenses`, `net_profit`, `inventory_outlays`, `top_products`, `products_count`, and
  optionally `series` — all money as raw numbers.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class AnalyticsFinancialsTests(AccountFixtureMixin, TestCase):
    """
    Two ledgers that must not be mixed: gross/net profit is margin, inventory_outlays is
    cash. Folding stock spend into profit makes margin swing with restocking timing.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('fin')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=100, account=self.account,
        )

    def analytics(self, **params):
        response = self.client.get(
            '/inventory/analytics/', params, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        return response.data

    def sell(self, quantity=10, unit_price='10.00', when=None):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.product, quantity=quantity,
            unit_price=Decimal(unit_price), unit_cost_price=Decimal('4.00'),
        )
        if when:
            Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def spend(self, amount='100.00', when=None):
        return Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal(amount),
            category=ExpenseCategory.RENT, spent_at=when or timezone.now(),
        )

    def test_gross_profit_is_revenue_minus_cogs(self):
        self.sell(quantity=10)
        data = self.analytics()
        self.assertEqual(Decimal(str(data['total_revenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(data['total_cogs'])), Decimal('40.00'))
        self.assertEqual(Decimal(str(data['gross_profit'])), Decimal('60.00'))

    def test_net_profit_is_gross_profit_minus_expenses(self):
        self.sell(quantity=10)
        self.spend('25.00')
        data = self.analytics()
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('25.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('35.00'))

    def test_inventory_purchases_do_not_touch_profit(self):
        self.sell(quantity=10)
        purchase = Purchase.objects.create(
            account=self.account, supplier=Supplier.objects.create(
                name='S', account=self.account,
            ), exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase=purchase, product=self.product, quantity=50,
            unit_price=Decimal('4.00'),
        )
        data = self.analytics()
        self.assertEqual(Decimal(str(data['inventory_outlays'])), Decimal('200.00'))
        self.assertEqual(Decimal(str(data['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('60.00'))

    def test_everything_is_zero_with_no_data(self):
        data = self.analytics()
        for key in ('total_revenue', 'total_cogs', 'gross_profit', 'total_expenses',
                    'net_profit', 'inventory_outlays'):
            self.assertEqual(Decimal(str(data[key])), Decimal('0'))

    def test_the_same_window_reaches_orders_and_expenses(self):
        # The failure this guards against: a window that filters orders but not expenses,
        # which silently reports last month's sales against a year of overhead.
        old = timezone.now() - timedelta(days=200)
        self.sell(quantity=10, when=old)
        self.spend('25.00', when=old)
        self.sell(quantity=5)
        self.spend('10.00')

        data = self.analytics(period='last_month')
        self.assertEqual(Decimal(str(data['total_revenue'])), Decimal('50.00'))
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('20.00'))

    def test_a_backdated_expense_lands_in_the_month_it_was_spent(self):
        march = datetime(2026, 3, 15, 12, 0, tzinfo=dt_timezone.utc)
        self.spend('75.00', when=march)
        self.spend('10.00')

        data = self.analytics(year='2026', month='3')
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('75.00'))

    def test_expenses_are_account_scoped(self):
        other_account, _, _, _ = self.make_account_user('fin2')
        Expense.objects.create(
            account=other_account, description='Theirs', amount=Decimal('999.00'),
        )
        self.assertEqual(Decimal(str(self.analytics()['total_expenses'])), Decimal('0'))

    def test_money_comes_back_as_numbers_not_formatted_strings(self):
        # The dashboard re-formats these for the LBP toggle. A "$1,234.00" string forces it
        # to parse the value back out first.
        self.sell(quantity=1)
        data = self.analytics()
        self.assertNotIsInstance(data['total_revenue'], str)

    def test_the_series_carries_expenses_per_period(self):
        self.sell(quantity=10)
        self.spend('25.00')
        data = self.analytics(group_by='month')
        self.assertTrue(data['series'])
        self.assertIn('total_expenses', data['series'][0])
```

Add to the imports at the top of `inventory/tests.py` if absent:

```python
from .models import Purchase, PurchaseItem, Supplier
```

- [ ] **Step 2: Run and verify failure**

Run: `pipenv run python manage.py test inventory.tests.AnalyticsFinancialsTests`
Expected: FAIL — `KeyError: 'total_cogs'`.

- [ ] **Step 3: Rewrite the analytics body**

In `inventory/views.py`, in `AnalyticsView.get`, add the expense queryset beside the others:

```python
        expenses = Expense.objects.filter(account=account) if account else Expense.objects.none()
```

apply the window to it alongside the rest:

```python
        expenses = window.apply(expenses, 'spent_at')
```

and replace the aggregates and the response dict with:

```python
        # One aggregate call over `orders`: both expressions traverse the same `items` join,
        # so there is no fan-out between them.
        order_totals = orders.aggregate(
            total_revenue=Sum(LINE_TOTAL),
            total_cogs=Sum(LINE_COGS),
        )
        outlays = purchases.aggregate(total=Sum(LINE_TOTAL))['total'] or 0
        expense_total = expenses.aggregate(total=Sum('amount'))['total'] or 0

        revenue = order_totals['total_revenue'] or 0
        cogs = order_totals['total_cogs'] or 0
        gross_profit = revenue - cogs

        best_seller_query = products.values('product__name').annotate(
            total_sold=Sum(F('quantity') * F('unit_multiplier'))
        ).order_by('-total_sold')[:5]

        data = {
            # Profit and loss.
            "total_revenue": revenue,
            "total_cogs": cogs,
            "gross_profit": gross_profit,
            "total_expenses": expense_total,
            "net_profit": gross_profit - expense_total,
            # Cash flow, deliberately outside the P&L above. Stock bought this month is not
            # a cost of what was sold this month; mixing them makes margin swing with
            # restocking timing. Named inventory_outlays rather than total_costs so it
            # cannot be misread as total_cogs.
            "inventory_outlays": outlays,
            "top_products": best_seller_query,
            # Catalog size, deliberately NOT date-filtered — it's "how many products exist",
            # not "how many were sold in this window".
            "products_count": Product.objects.for_account(account).count(),
        }

        if group_by in GROUP_BY_TRUNC:
            data["series"] = self._build_series(
                orders, purchases, expenses, GROUP_BY_TRUNC[group_by],
            )

        return Response(data)
```

Money is returned raw. The previous `f"${value:,.2f}"` formatting is deliberately gone — the SPA
parsed those strings back into numbers to re-render them in LBP, and the new tiles need the same.

- [ ] **Step 4: Add expenses to the series**

In `inventory/views.py`, replace `_build_series` with:

```python
    def _build_series(self, orders, purchases, expenses, trunc):
        def totals_by_period(queryset, field, expression):
            rows = (
                queryset
                .annotate(period=trunc(field, output_field=DateField()))
                .values('period')
                .annotate(total=Sum(expression))
            )
            return {row['period']: row['total'] or 0 for row in rows if row['period']}

        revenue_by_period = totals_by_period(orders, 'placed_at', LINE_TOTAL)
        cost_by_period = totals_by_period(purchases, 'placed_at', LINE_TOTAL)
        expense_by_period = totals_by_period(expenses, 'spent_at', 'amount')

        periods = sorted(
            set(revenue_by_period) | set(cost_by_period) | set(expense_by_period)
        )

        return [
            {
                "period": period.isoformat(),
                "total_revenue": revenue_by_period.get(period, 0),
                "total_costs": cost_by_period.get(period, 0),
                "total_expenses": expense_by_period.get(period, 0),
            }
            for period in periods
        ]
```

The series keeps `total_costs` for the purchases line: it is the chart's existing cost series, the
frontend already reads that key, and unlike the summary tile it sits nowhere near a COGS figure.

- [ ] **Step 5: Run and verify it passes**

Run: `pipenv run python manage.py test inventory.tests.AnalyticsFinancialsTests`
Expected: OK, 9 tests.

Run: `pipenv run python manage.py test`
Expected: ends with `OK`. Pre-existing analytics tests asserting `"$..."` strings or `total_costs`
in the summary must be updated to the new contract — that is the intended change, not a regression.

- [ ] **Step 6: Commit**

```bash
git add inventory
git commit -m "feat: gross profit, expenses and net profit in analytics"
```

---

### Task 6: The Expenses page

**Files:**
- Create: `frontend/src/lib/expenses.js`, `frontend/src/lib/expenses.test.js`,
  `frontend/src/components/forms/ExpenseForm.jsx`, `frontend/src/pages/Expenses.jsx`,
  `frontend/src/pages/Expenses.test.jsx`
- Modify: `frontend/src/App.jsx`, `frontend/src/components/layout/Dock.jsx`

**Interfaces:**
- Consumes: `/inventory/expenses/` (Task 4).
- Produces: `EXPENSE_CATEGORIES`, `categoryLabel(key)`, `todayForInput()`,
  `toSpentAtISO(dateString)`; the `Expenses` page and `ExpenseForm`.

- [ ] **Step 1: Write the failing logic tests**

Create `frontend/src/lib/expenses.test.js`:

```js
import { describe, expect, it } from 'vitest'
import {
  EXPENSE_CATEGORIES,
  categoryLabel,
  toSpentAtISO,
  todayForInput,
} from '@/lib/expenses'

describe('EXPENSE_CATEGORIES', () => {
  it('matches the keys the API accepts', () => {
    expect(EXPENSE_CATEGORIES.map((c) => c.value)).toEqual([
      'rent', 'utilities', 'salaries', 'marketing', 'software',
      'transport', 'maintenance', 'taxes_fees', 'other',
    ])
  })
})

describe('categoryLabel', () => {
  it('renders a known key', () => {
    expect(categoryLabel('taxes_fees')).toBe('Taxes & Fees')
  })

  it('falls back to the raw key rather than showing nothing', () => {
    expect(categoryLabel('helicopters')).toBe('helicopters')
  })

  it('survives null', () => {
    expect(categoryLabel(null)).toBe('—')
  })
})

describe('todayForInput', () => {
  it('is a yyyy-mm-dd string a date input accepts', () => {
    expect(todayForInput()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('toSpentAtISO', () => {
  it('turns a date input value into an ISO timestamp', () => {
    expect(toSpentAtISO('2026-03-15')).toMatch(/^2026-03-15T/)
  })

  it('returns null for empty input so the server default applies', () => {
    expect(toSpentAtISO('')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd frontend && npm test -- expenses`
Expected: FAIL — cannot resolve `@/lib/expenses`.

- [ ] **Step 3: Write the module**

Create `frontend/src/lib/expenses.js`:

```js
// Mirrors inventory.models.ExpenseCategory. The values are the stable keys the API stores;
// the labels are display only.
export const EXPENSE_CATEGORIES = [
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'salaries', label: 'Salaries' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'software', label: 'Software' },
  { value: 'transport', label: 'Transport' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'taxes_fees', label: 'Taxes & Fees' },
  { value: 'other', label: 'Other' },
]

const LABELS = new Map(EXPENSE_CATEGORIES.map(({ value, label }) => [value, label]))

/** Falls back to the raw key: a category added server-side should read oddly, not vanish. */
export function categoryLabel(key) {
  if (!key) return '—'
  return LABELS.get(key) ?? key
}

/** yyyy-mm-dd in local time, for a date input's default value. */
export function todayForInput() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * A date input gives a bare yyyy-mm-dd; spent_at is a timestamp. Null when empty so the
 * server's default=timezone.now applies rather than sending an invalid value.
 */
export function toSpentAtISO(dateString) {
  if (!dateString) return null
  return new Date(`${dateString}T12:00:00`).toISOString()
}
```

Midday rather than midnight, so a timezone offset cannot roll a backdated expense into the
neighbouring day and, at a month boundary, the neighbouring month.

- [ ] **Step 4: Run and verify it passes**

Run: `cd frontend && npm test -- expenses`
Expected: all pass.

- [ ] **Step 5: Write the form**

Create `frontend/src/components/forms/ExpenseForm.jsx`:

```jsx
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { SlideOver } from '@/components/ui/SlideOver'
import { EXPENSE_CATEGORIES, toSpentAtISO, todayForInput } from '@/lib/expenses'

function initialForm(expense) {
  if (!expense) {
    return { description: '', amount: '', category: 'other', spent_on: todayForInput() }
  }
  return {
    description: expense.description,
    amount: String(expense.amount),
    category: expense.category,
    spent_on: expense.spent_at ? expense.spent_at.slice(0, 10) : todayForInput(),
  }
}

export function ExpenseForm({ open, onClose, onSaved, expense }) {
  const isEdit = Boolean(expense)
  const [form, setForm] = useState(() => initialForm(expense))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setErrors({})

    const payload = {
      description: form.description,
      amount: form.amount,
      category: form.category,
      spent_at: toSpentAtISO(form.spent_on),
    }

    try {
      if (isEdit) {
        await api.patch(`/inventory/expenses/${expense.id}/`, payload)
      } else {
        await api.post('/inventory/expenses/', payload)
      }
      onSaved()
      onClose()
    } catch (error) {
      if (error.response?.status === 400) {
        setErrors(error.response.data)
      } else {
        setErrors({ detail: ['Something went wrong. Please try again.'] })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SlideOver open={open} onClose={onClose} title={isEdit ? 'Edit expense' : 'Add expense'}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Description" error={errors.description}>
          <input
            type="text"
            value={form.description}
            onChange={(event) => update('description', event.target.value)}
            required
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Amount (USD)" error={errors.amount}>
          <input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => update('amount', event.target.value)}
            required
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Category" error={errors.category}>
          <select
            value={form.category}
            onChange={(event) => update('category', event.target.value)}
            className={INPUT_CLASS}
          >
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Date spent" error={errors.spent_at}>
          <input
            type="date"
            value={form.spent_on}
            onChange={(event) => update('spent_on', event.target.value)}
            className={INPUT_CLASS}
          />
        </Field>

        {errors.detail && <p className="text-[13px] text-accent-red">{errors.detail[0]}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {isEdit ? 'Save changes' : 'Add expense'}
        </button>
      </form>
    </SlideOver>
  )
}

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2 text-[13px] text-text-primary focus:border-accent-blue/60 focus:ring-2 focus:ring-accent-blue/20 focus:outline-none'

function Field({ label, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
      {error && <span className="text-[12px] text-accent-red">{error[0]}</span>}
    </label>
  )
}
```

- [ ] **Step 6: Write the page's failing test**

Create `frontend/src/pages/Expenses.test.jsx`:

```jsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Expenses } from '@/pages/Expenses'

const get = vi.fn()
const del = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args) => get(...args),
    delete: (...args) => del(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))
vi.mock('@/context/CurrencyContext', () => ({
  useCurrency: () => ({ formatAmount: (value) => `$${Number(value).toFixed(2)}` }),
}))

const PAGE = {
  count: 2,
  results: [
    {
      id: 1, description: 'Shop rent', amount: '500.00',
      category: 'rent', category_display: 'Rent', spent_at: '2026-03-01T12:00:00Z',
    },
    {
      id: 2, description: 'Instagram ads', amount: '75.50',
      category: 'marketing', category_display: 'Marketing', spent_at: '2026-03-04T12:00:00Z',
    },
  ],
}

describe('Expenses', () => {
  beforeEach(() => {
    get.mockReset()
    del.mockReset()
    get.mockResolvedValue({ data: PAGE })
  })

  it('lists expenses with their category and amount', async () => {
    render(<Expenses />)
    expect(await screen.findByText('Shop rent')).toBeInTheDocument()
    expect(screen.getByText('Instagram ads')).toBeInTheDocument()
    expect(screen.getAllByText('Rent').length).toBeGreaterThan(0)
    expect(screen.getByText('$500.00')).toBeInTheDocument()
  })

  it('shows the running total for the current filter', async () => {
    render(<Expenses />)
    expect(await screen.findByText(/575\.50/)).toBeInTheDocument()
  })

  it('filters by category', async () => {
    render(<Expenses />)
    await screen.findByText('Shop rent')
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'marketing')

    await waitFor(() => {
      const lastCall = get.mock.calls[get.mock.calls.length - 1]
      expect(lastCall[1].params.category).toBe('marketing')
    })
  })

  it('asks before deleting', async () => {
    render(<Expenses />)
    await screen.findByText('Shop rent')
    await userEvent.click(screen.getAllByRole('button', { name: /delete/i })[0])
    expect(await screen.findByText(/permanently removed/i)).toBeInTheDocument()
    expect(del).not.toHaveBeenCalled()
  })

  it('shows an empty state when there is nothing to show', async () => {
    get.mockResolvedValue({ data: { count: 0, results: [] } })
    render(<Expenses />)
    expect(await screen.findByText(/no expenses/i)).toBeInTheDocument()
  })

  it('reports a failed load instead of rendering an empty table', async () => {
    get.mockRejectedValue(new Error('boom'))
    render(<Expenses />)
    expect(await screen.findByText(/couldn't load expenses/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Build the page**

Create `frontend/src/pages/Expenses.jsx`:

```jsx
import { useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useCurrency } from '@/context/CurrencyContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ExpenseForm } from '@/components/forms/ExpenseForm'
import { EXPENSE_CATEGORIES, categoryLabel } from '@/lib/expenses'

const PAGE_SIZE = 10

export function Expenses() {
  const { formatAmount } = useCurrency()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [spentAfter, setSpentAfter] = useState('')
  const [spentBefore, setSpentBefore] = useState('')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)

  const [result, setResult] = useState({ count: 0, results: [] })
  const [status, setStatus] = useState('loading')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 350)
    return () => clearTimeout(timeout)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setStatus('loading')

    const params = { page, ordering: '-spent_at' }
    if (search) params.search = search
    if (category !== 'all') params.category = category
    if (spentAfter) params.spent_after = spentAfter
    if (spentBefore) params.spent_before = spentBefore

    api
      .get('/inventory/expenses/', { params })
      .then(({ data }) => {
        if (!cancelled) {
          setResult(data)
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [search, category, spentAfter, spentBefore, page, refreshKey])

  // The page's own total, not the account's. Labelled as such so it is never mistaken for
  // the dashboard's windowed total_expenses.
  const pageTotal = useMemo(
    () => result.results.reduce((sum, expense) => sum + Number(expense.amount), 0),
    [result],
  )

  const pageCount = Math.max(1, Math.ceil(result.count / PAGE_SIZE))
  const from = result.count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const to = Math.min(page * PAGE_SIZE, result.count)

  function updateFilter(setter) {
    return (value) => {
      setter(value)
      setPage(1)
    }
  }

  function openAdd() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(expense) {
    setEditing(expense)
    setFormOpen(true)
  }

  async function handleDelete() {
    await api.delete(`/inventory/expenses/${deleting.id}/`)
    setRefreshKey((k) => k + 1)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[180px] flex-1 items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2">
          <Search size={15} className="shrink-0 text-text-tertiary" />
          <input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search expenses…"
            className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
        </div>

        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <span className="sr-only sm:not-sr-only">Category</span>
          <select
            aria-label="Category"
            value={category}
            onChange={(event) => updateFilter(setCategory)(event.target.value)}
            className={FILTER_CLASS}
          >
            <option value="all">All categories</option>
            {EXPENSE_CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <input
          type="date"
          aria-label="Spent after"
          value={spentAfter}
          onChange={(event) => updateFilter(setSpentAfter)(event.target.value)}
          className={FILTER_CLASS}
        />
        <input
          type="date"
          aria-label="Spent before"
          value={spentBefore}
          onChange={(event) => updateFilter(setSpentBefore)(event.target.value)}
          className={FILTER_CLASS}
        />

        <button
          type="button"
          onClick={openAdd}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-blue px-3 py-2 text-[13px] font-semibold text-white hover:opacity-90"
        >
          <Plus size={14} />
          Add expense
        </button>
      </div>

      {status === 'error' && (
        <p className="py-16 text-center text-[13px] text-text-secondary">
          Couldn&apos;t load expenses. Check that the API is running.
        </p>
      )}

      {status !== 'error' && (
        <>
          <ExpenseTable
            expenses={result.results}
            loading={status === 'loading'}
            formatAmount={formatAmount}
            onEdit={openEdit}
            onDelete={setDeleting}
          />

          {status === 'ready' && result.count === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Receipt className="text-text-tertiary" size={28} />
              <p className="text-[13px] text-text-secondary">
                No expenses match these filters.
              </p>
            </div>
          )}

          {result.count > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px] text-text-secondary">
              <span className="tabular-nums">
                Showing {from}–{to} of {result.count} · this page totals{' '}
                <span className="font-medium text-text-primary">{formatAmount(pageTotal)}</span>
              </span>
              <div className="flex items-center gap-1.5">
                <PageButton disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={16} />
                </PageButton>
                <PageButton disabled={page === pageCount} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight size={16} />
                </PageButton>
              </div>
            </div>
          )}
        </>
      )}

      <ExpenseForm
        key={editing?.id ?? 'new'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={() => setRefreshKey((k) => k + 1)}
        expense={editing}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={handleDelete}
        title="Delete expense?"
        description={`"${deleting?.description}" will be permanently removed and will no longer count against net profit.`}
      />
    </div>
  )
}

const FILTER_CLASS =
  'rounded-xl border border-hairline bg-canvas-2 px-2.5 py-2 text-[13px] text-text-primary focus:outline-none'

function ExpenseTable({ expenses, loading, formatAmount, onEdit, onDelete }) {
  return (
    <GlassCard className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline text-[12px] text-text-tertiary">
              <th className="px-5 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Date spent</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-hairline/60 last:border-0">
                    <td className="px-5 py-2.5" colSpan={5}>
                      <div className="h-8 animate-pulse rounded-lg bg-canvas-2" />
                    </td>
                  </tr>
                ))
              : expenses.map((expense) => (
                  <tr
                    key={expense.id}
                    className="border-b border-hairline/60 last:border-0 hover:bg-canvas-2/60"
                  >
                    <td className="px-5 py-2.5 font-medium text-text-primary">
                      {expense.description}
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">
                      {expense.category_display ?? categoryLabel(expense.category)}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-text-secondary">
                      {expense.spent_at?.slice(0, 10) ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums text-text-primary">
                      {formatAmount(Number(expense.amount))}
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onEdit(expense)}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-blue hover:bg-accent-blue/10"
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete ${expense.description}`}
                          onClick={() => onDelete(expense)}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] font-medium text-accent-red hover:bg-accent-red/10"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  )
}

function PageButton({ disabled, onClick, children }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-text-secondary hover:bg-canvas-2 hover:text-text-primary disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 8: Route it and add the nav entry**

In `frontend/src/App.jsx`, add the import and the route inside the `AppShell` block beside the other
protected pages:

```jsx
import { Expenses } from '@/pages/Expenses'
```
```jsx
            <Route path="/expenses" element={<Expenses />} />
```

In `frontend/src/components/layout/Dock.jsx`, add an entry to the nav item list following the exact
shape of the existing entries (read the file first — the list is a local array of
`{ to, label, icon }`-style objects), using `Receipt` from `lucide-react`, `to: '/expenses'`, and the
label `Expenses`.

- [ ] **Step 9: Run every frontend gate**

Run: `cd frontend && npm test`
Expected: all suites pass, including the 55 from earlier phases.

Run: `cd frontend && npm run lint`
Expected: no errors (4 pre-existing fast-refresh warnings are known).

Run: `cd frontend && npm run build`
Expected: `built in …` with no import errors.

- [ ] **Step 10: Commit**

```bash
git add frontend
git commit -m "feat: expenses page with category and date filters"
```

---

### Task 7: Dashboard financials and documentation

**Files:**
- Modify: `frontend/src/pages/Dashboard.jsx`, `HISTORY.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the analytics payload from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Move the dashboard onto the new payload**

Read `frontend/src/pages/Dashboard.jsx` first — the analytics response is consumed in several places
and the changes must all land together.

Required changes:
- `parseMoney(stats.value.total_costs)` → `stats.value.inventory_outlays`, and the same for the
  `current` / `previous` comparison pair. The key was renamed; a missed call site yields `NaN`, not
  an error.
- `parseMoney(...)` wrappers on analytics money can go — the payload is numbers now. Keep
  `parseMoney` itself if other call sites use it; it is harmless on a number if retained.
- Add tiles for **Gross profit** (`gross_profit`), **Expenses** (`total_expenses`) and **Net profit**
  (`net_profit`), and relabel the existing costs tile to **Inventory outlays**.
- Every money tile renders through `formatAmount` from `useCurrency()`, so the LBP toggle applies.
- The chart series rows already carry `total_expenses`; add it as a third line or leave the chart
  unchanged if that crowds it — the tiles are the deliverable here.

- [ ] **Step 2: Run the frontend gates**

Run: `cd frontend && npm test`
Expected: all pass. Any Dashboard test asserting a `"$..."` string from analytics is now wrong and
should be updated to the number contract.

Run: `cd frontend && npm run lint && npm run build`
Expected: both clean.

- [ ] **Step 3: Add the HISTORY.md entry**

Insert above the Phase 2.5b-1 entry, following the existing format. Cover what shipped and the *why*
a diff will not explain:

- the app had two disagreeing definitions of profit, and which one won
- `unit_cost_price` is snapshotted because profit computed from a live `cost_price` restates history
  every time a cost is corrected
- the backfill stamps existing lines with *today's* cost — an approximation, the last knowable value,
  exact for everything sold afterwards
- `bulk_create` bypasses `save()`, which is why the serializer stamps the cost itself and `save()`
  covers the admin inline and seed paths
- `DateWindow` was extracted as a pure refactor *before* expenses were added, so the diff that added
  them could not hide a filtering regression
- `spent_at` rather than `created_at`, and why `auto_now_add` would have made backdating impossible
- `inventory_outlays` is deliberately outside the P&L, and why it was renamed from `total_costs`
- analytics money is raw numbers now because the SPA was parsing formatted strings back into numbers
  for the LBP toggle

- [ ] **Step 4: Update CLAUDE.md**

Mark Phase 3 done, and add to the Working Log:

- `OrderItem.unit_cost_price` is the only correct source of COGS; `product.cost_price` is a *current*
  figure and reading it for a historical calculation restates the past
- `bulk_create` bypasses `OrderItem.save()`, so any new bulk creation path must stamp
  `unit_cost_price` itself
- `AnalyticsView` returns money as raw numbers, not `"$..."` strings, and the summary key for
  purchases is `inventory_outlays` — `series` rows still use `total_costs`
- every reporting queryset must be filtered through `inventory/reporting.py::DateWindow`; a window
  applied to one side of a profit calculation and not the other misstates it silently

- [ ] **Step 5: Run the mandatory final check**

Run: `pipenv run python manage.py test`
Expected: ends with `OK`.

Run: `cd frontend && npm test && npm run lint && npm run build`
Expected: all three succeed.

Run: `pipenv run python manage.py seed_data --account "Demo Business" --owner demo@example.com`
Expected: completes, including expenses.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: record Phase 3 completion"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: COGS snapshot with its three-step
migration and three consumers → Task 1; `DateWindow` as a pure refactor → Task 2; the `Expense` model
with `spent_at` and fixed categories → Task 3; account-scoped CRUD with filters → Task 4; the six
metrics, the `inventory_outlays` rename and raw-number money → Task 5; the Expenses page, form and
Dock entry → Task 6; dashboard tiles and documentation → Task 7. The design's stated risks (the
backfill approximation, `net_profit` changing meaning) are both recorded in Task 7's `HISTORY.md`
step.

**Out of scope and not planned, per the design:** recurring expenses, receipt attachments, an expense
CSV export, multi-currency entry, expense approval workflows.

**Type consistency.** `LINE_COGS` and `items_cogs` are named identically in Task 1's model, its test,
and Task 5's aggregate, and Task 1 pins them to each other with a test. `DateWindow.from_query_params`
/ `.apply(queryset, field)` have the same signature in Task 2's module, its tests, and Task 5's usage.
`ExpenseCategory` values in `inventory/models.py` and `EXPENSE_CATEGORIES` in
`frontend/src/lib/expenses.js` list the same nine keys in the same order, and Task 6's first test
asserts it. The serializer emits `category_display`, which is the key Task 6's table reads.
`inventory_outlays` is the summary key in Task 5's view, its tests, and Task 7's dashboard edit —
while `series` rows deliberately keep `total_costs`, stated in both places so the difference is not
mistaken for a bug.
