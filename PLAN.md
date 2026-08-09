# Phases 6–8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Per-period profit series behind the dashboard's profit sparklines (Phase 6); camera barcode
scanning wired into the product, order and purchase flows (Phase 7); and a defensive security audit
with the isolation, CORS and rate-limit hardening it turns up (Phase 8).

**Architecture:** Phase 6 extends the existing `AnalyticsView._build_series` so each period carries
COGS, gross profit and net profit alongside the revenue/costs/expenses it already returns, then feeds
those arrays into the two `StatTile`s that currently have no sparkline. Phase 7 adds one reusable
`BarcodeScannerModal` behind a dynamic `import()`, plus an exact-match `barcode` API filter so a scan
resolves to a product unambiguously; three call sites consume it. Phase 8 is audit-then-fix, gated on
the user installing the scanning tools.

**Tech Stack:** Django 6 / DRF, Postgres. React 19 + Vite + Tailwind v4, Vitest.
Phase 7 adds one runtime dependency: `@zxing/library`.

---

## Corrections to the brief

Three details in the request do not match the codebase. The plan uses the real ones:

| Brief says | Actually is |
|---|---|
| `/api/analytics/overview/` | `/inventory/analytics/` (`AnalyticsView` in `inventory/views.py`) |
| `Dashboard.tsx` | `frontend/src/pages/Dashboard.jsx` — the repo has no TypeScript |
| "analytics service" | There is no service layer; the logic is `AnalyticsView._build_series`, with date filtering in `inventory/reporting.py` |

## Global Constraints

- `pipenv run python manage.py test` must end in `OK` before any phase is complete. It is the
  mandatory final check. In the worktree `pipenv run` resolves to an empty venv — use
  `/home/kader/.local/share/virtualenvs/ims-S-s2H65S/bin/python manage.py test`.
- Frontend gates: `cd frontend && npm test`, `npm run lint`, `npm run build` must all pass. The build
  catches import errors the tests and linter miss.
- **No browser automation / Claude-in-Chrome for verification.** This is absolute, and it shapes
  Phase 7: the scanner is verified by mocking the decoder in Vitest, never by opening a camera.
- **Do not alter the stock side-effect.** `CreateOrderSerializer.create()` deducts
  `quantity * unit_multiplier` under `select_for_update()` inside `@transaction.atomic`.
- **All amounts are USD.** LBP is a frontend display toggle only.
- **Every backend test needs an `Account`** — use `AccountFixtureMixin.make_account_user()`.
- **Nothing in this plan touches Heroku.** No deploys, no `pg:reset`, no config vars.
- Only one new dependency is authorised: `@zxing/library` (Phase 7). No others without asking.
- Commit after every task. **Every phase ends with a task that updates `HISTORY.md` and `CLAUDE.md`** —
  these are not optional and not deferred to the end of the plan.

## File Structure

**Create:**
- `frontend/src/components/ui/BarcodeScannerModal.jsx` — camera UI, permissions, device toggle
- `frontend/src/components/ui/BarcodeScannerModal.test.jsx`
- `frontend/src/lib/barcode.js` — decoder config, device selection, result normalisation (pure, testable without a camera)
- `frontend/src/lib/barcode.test.js`
- `frontend/src/hooks/useBarcodeLookup.js` — code → product, with the not-found and multiple-match cases
- `frontend/src/hooks/useBarcodeLookup.test.js`
- `docs/superpowers/specs/2026-08-09-phase-8-security-audit-findings.md` — Phase 8 report

**Modify:**
- `inventory/views.py` — `_build_series` gains COGS/gross/net; export throttling (Phase 8)
- `inventory/filters.py` — exact `barcode` filter on `ProductFilter`
- `inventory/tests.py` — series, barcode-filter, isolation-matrix and throttle suites
- `ims/settings.py` — CORS lockdown, DRF throttle rates (Phase 8)
- `frontend/src/lib/format.js` — `fillSeriesGaps` carries the new keys
- `frontend/src/lib/format.test.js`
- `frontend/src/pages/Dashboard.jsx` — sparklines on the two profit tiles
- `frontend/src/components/forms/ProductForm.jsx` — scan button beside the barcode input
- `frontend/src/components/forms/OrderForm.jsx` — scan-to-add/increment
- `frontend/src/components/forms/PurchaseForm.jsx` — scan-to-select
- `frontend/package.json` — `@zxing/library`
- `HISTORY.md`, `CLAUDE.md` — once per phase

---

# Phase 6 — Dashboard analytics & profit sparklines

**Current state.** `AnalyticsView._build_series` returns rows of
`{period, total_revenue, total_costs, total_expenses}`. The summary payload already has
`total_cogs`/`gross_profit`/`net_profit`, but the *series* does not — which is exactly why the Gross
profit and Net profit tiles ship with no sparkline today (Phase 3, Task 7: "there is no honest
per-period profit to draw").

**Note on `total_costs`.** The series key for purchases stays `total_costs` — it is the chart's
existing cost line and the frontend reads it. Only the summary tile is named `inventory_outlays`.
Do not rename it here.

---

### Task 6.1: Per-period COGS, gross profit and net profit

**Files:**
- Modify: `inventory/views.py` (`AnalyticsView._build_series`), `inventory/tests.py`

**Interfaces:**
- Consumes: `LINE_TOTAL`, `LINE_COGS` (`inventory/models.py`), `DateWindow` (`inventory/reporting.py`).
- Produces: each `series` row gains `total_cogs`, `gross_profit`, `net_profit`. Existing keys
  `period`, `total_revenue`, `total_costs`, `total_expenses` are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class AnalyticsSeriesProfitTests(AccountFixtureMixin, TestCase):
    """
    Per-period profit. The summary payload has carried gross/net profit since Phase 3, but the
    series did not — which is why the profit tiles shipped without sparklines rather than
    drawing revenue-minus-purchases and calling it profit.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('ser')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=1000, account=self.account,
        )

    def series(self, **params):
        response = self.client.get(
            '/inventory/analytics/', {'group_by': 'month', **params},
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        return response.data['series']

    def sell(self, quantity=10, when=None):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.product, quantity=quantity, unit_multiplier=1,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
        )
        if when:
            Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def spend(self, amount='25.00', when=None):
        return Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal(amount),
            category=ExpenseCategory.RENT, spent_at=when or timezone.now(),
        )

    def test_a_period_carries_cogs_gross_and_net(self):
        self.sell(quantity=10)      # revenue 100.00, cogs 40.00
        self.spend('25.00')
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(row['total_cogs'])), Decimal('40.00'))
        self.assertEqual(Decimal(str(row['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(row['total_expenses'])), Decimal('25.00'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('35.00'))

    def test_the_existing_keys_are_unchanged(self):
        # total_costs is the purchases line the chart already draws. Renaming it here would
        # blank the cost series in the carousel with no error anywhere.
        self.sell()
        row = self.series()[-1]
        for key in ('period', 'total_revenue', 'total_costs', 'total_expenses'):
            self.assertIn(key, row)

    def test_inventory_purchases_stay_out_of_per_period_profit(self):
        self.sell(quantity=10)
        purchase = Purchase.objects.create(
            account=self.account,
            supplier=Supplier.objects.create(name='S', account=self.account),
            exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.product, quantity=50,
            unit_price=Decimal('4.00'),
        )
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_costs'])), Decimal('200.00'))
        self.assertEqual(Decimal(str(row['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('60.00'))

    def test_a_period_with_expenses_but_no_sales_reports_a_loss(self):
        # Net profit must be allowed to go negative; clamping it at zero would hide the month
        # a shop paid rent and sold nothing, which is the month worth seeing.
        self.spend('80.00')
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('0'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('-80.00'))

    def test_every_period_row_has_every_key(self):
        # A row missing a key renders as undefined in the sparkline and produces NaN SVG
        # coordinates — an invisible chart rather than an error.
        self.sell(quantity=5, when=timezone.now() - timedelta(days=200))
        self.spend('10.00')
        expected = {
            'period', 'total_revenue', 'total_costs', 'total_cogs',
            'gross_profit', 'total_expenses', 'net_profit',
        }
        rows = self.series()
        self.assertGreaterEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(set(row), expected)

    def test_revenue_and_cogs_do_not_fan_out_across_the_items_join(self):
        # Both expressions traverse `items`. Summed in separate annotate() calls on one
        # queryset they would multiply each other's row counts.
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        for _ in range(3):
            OrderItem.objects.create(
                order=order, product=self.product, quantity=1, unit_multiplier=1,
                unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
            )
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('30.00'))
        self.assertEqual(Decimal(str(row['total_cogs'])), Decimal('12.00'))

    def test_each_dashboard_period_filter_returns_a_well_formed_series(self):
        # The three options in the dashboard's SegmentedControl. 'all_time' is deliberately
        # absent from PERIOD_WINDOW_DAYS and means "no filter".
        self.sell(quantity=10, when=timezone.now() - timedelta(days=400))
        self.sell(quantity=10, when=timezone.now() - timedelta(days=100))
        self.sell(quantity=10)
        self.spend('25.00')

        for period, group_by in (('all_time', 'year'), ('last_month', 'day'),
                                 ('last_year', 'month')):
            rows = self.series(period=period, group_by=group_by)
            self.assertTrue(rows, f'{period}/{group_by} returned no rows')
            for row in rows:
                self.assertIsInstance(row['period'], str)
                self.assertNotIsInstance(row['gross_profit'], str)

    def test_an_account_with_no_data_gets_an_empty_series_not_an_error(self):
        self.assertEqual(self.series(), [])
```

- [ ] **Step 2: Run and verify failure**

Run: `/home/kader/.local/share/virtualenvs/ims-S-s2H65S/bin/python manage.py test inventory.tests.AnalyticsSeriesProfitTests`
Expected: FAIL — `KeyError: 'total_cogs'`.

- [ ] **Step 3: Rewrite `_build_series`**

In `inventory/views.py`, replace `_build_series` entirely:

```python
    def _build_series(self, orders, purchases, expenses, trunc):
        def totals_by_period(queryset, field, **expressions):
            """
            One grouped query per queryset. Multiple Sums in a single annotate() is
            deliberate: revenue and COGS both traverse the `items` join, and splitting them
            into two annotate() calls on the same queryset makes each multiply the other's
            row count.
            """
            rows = (
                queryset
                .annotate(period=trunc(field, output_field=DateField()))
                .values('period')
                .annotate(**{name: Sum(expr) for name, expr in expressions.items()})
            )
            return {
                row['period']: {name: row[name] or 0 for name in expressions}
                for row in rows if row['period']
            }

        order_rows = totals_by_period(
            orders, 'placed_at', total_revenue=LINE_TOTAL, total_cogs=LINE_COGS,
        )
        purchase_rows = totals_by_period(purchases, 'placed_at', total_costs=LINE_TOTAL)
        expense_rows = totals_by_period(expenses, 'spent_at', total_expenses='amount')

        periods = sorted(set(order_rows) | set(purchase_rows) | set(expense_rows))

        series = []
        for period in periods:
            revenue = order_rows.get(period, {}).get('total_revenue', 0)
            cogs = order_rows.get(period, {}).get('total_cogs', 0)
            spent = expense_rows.get(period, {}).get('total_expenses', 0)
            gross_profit = revenue - cogs
            series.append({
                "period": period.isoformat(),
                "total_revenue": revenue,
                # The purchases line. Keeps its Phase 3 name: the chart already reads it, and
                # unlike the summary tile it sits nowhere near a COGS figure.
                "total_costs": purchase_rows.get(period, {}).get('total_costs', 0),
                "total_cogs": cogs,
                "gross_profit": gross_profit,
                "total_expenses": spent,
                # Allowed to be negative. A month with rent and no sales is a loss, and that
                # is the month most worth seeing on a chart.
                "net_profit": gross_profit - spent,
            })
        return series
```

- [ ] **Step 4: Run and verify it passes**

Run: `… manage.py test inventory.tests.AnalyticsSeriesProfitTests`
Expected: OK, 8 tests.

Run: `… manage.py test`
Expected: ends with `OK`. Every pre-existing analytics test must still pass — the change is
additive, so any failure means an existing key moved.

- [ ] **Step 5: Commit**

```bash
git add inventory
git commit -m "feat: per-period COGS, gross profit and net profit in the analytics series"
```

---

### Task 6.2: Carry the new keys through the frontend gap-fill

**Files:**
- Modify: `frontend/src/lib/format.js`, `frontend/src/lib/format.test.js`

**Interfaces:**
- Consumes: the series rows from Task 6.1.
- Produces: `fillSeriesGaps` output rows carrying `total_cogs`, `gross_profit`, `net_profit`,
  zero-filled for periods the API returned no row for.

`fillSeriesGaps` builds each filled row by naming keys explicitly. Any key it does not name is
dropped — including from periods that *did* have data. That is why this is its own task: without it
Task 6.3's sparklines are flat zero lines that look plausible and are wrong.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/format.test.js`:

```js
describe('fillSeriesGaps profit keys', () => {
  const window = { start: '2026-03-01', end: '2026-03-03', stepDays: 1 }
  const row = {
    period: '2026-03-02',
    total_revenue: 100, total_costs: 20, total_cogs: 40,
    gross_profit: 60, total_expenses: 25, net_profit: 35,
  }

  it('carries cogs, gross profit and net profit through', () => {
    const filled = fillSeriesGaps([row], window)
    expect(filled[1].total_cogs).toBe(40)
    expect(filled[1].gross_profit).toBe(60)
    expect(filled[1].net_profit).toBe(35)
  })

  it('zero-fills them for periods with no data', () => {
    const filled = fillSeriesGaps([row], window)
    expect(filled[0].gross_profit).toBe(0)
    expect(filled[0].net_profit).toBe(0)
    expect(filled[0].total_cogs).toBe(0)
  })

  it('preserves a negative net profit rather than zeroing it', () => {
    const loss = { ...row, net_profit: -80 }
    expect(fillSeriesGaps([loss], window)[1].net_profit).toBe(-80)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd frontend && npm test -- format`
Expected: FAIL — `expected undefined to be 40`.

- [ ] **Step 3: Add the keys**

In `frontend/src/lib/format.js`, in `fillSeriesGaps`, extend the pushed object:

```js
    filled.push({
      period: key,
      total_revenue: row?.total_revenue ?? 0,
      total_costs: row?.total_costs ?? 0,
      total_expenses: row?.total_expenses ?? 0,
      total_cogs: row?.total_cogs ?? 0,
      gross_profit: row?.gross_profit ?? 0,
      // ?? rather than ||: a real -80 must survive, and 0 is a legitimate value here.
      net_profit: row?.net_profit ?? 0,
    })
```

- [ ] **Step 4: Run and verify it passes**

Run: `cd frontend && npm test -- format`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib
git commit -m "feat: carry per-period profit through the series gap-fill"
```

---

### Task 6.3: Sparklines on the Gross profit and Net profit tiles

**Files:**
- Modify: `frontend/src/pages/Dashboard.jsx`

**Interfaces:**
- Consumes: `fillSeriesGaps` output (Task 6.2).
- Produces: no exports; `toChartSeries` rows gain `grossProfit` and `netProfit`.

`StatTile` already guards with `sparkline && sparkline.length > 1`, so an empty or single-point array
renders no chart and cannot throw. The real hazard is an array containing `undefined` — `Math.max`
returns `NaN`, every SVG coordinate becomes `NaN`, and the tile renders an invisible polyline with no
error. Task 6.2's zero-fill is what prevents that; this task must not reintroduce it by mapping a key
that does not exist.

- [ ] **Step 1: Extend `toChartSeries`**

In `frontend/src/pages/Dashboard.jsx`:

```js
function toChartSeries(series, granularity) {
  return series.map((row) => ({
    label: formatPeriodLabel(row.period, granularity),
    revenue: row.total_revenue,
    // Purchases. The series deliberately keeps the total_costs key while the summary tile
    // renamed to inventory_outlays — here it sits nowhere near a COGS figure.
    cost: row.total_costs,
    expenses: row.total_expenses ?? 0,
    grossProfit: row.gross_profit ?? 0,
    netProfit: row.net_profit ?? 0,
  }))
}
```

- [ ] **Step 2: Wire the two tiles**

Replace the `Gross profit` and `Net profit` `StatTile`s — and delete the comment block above them
explaining why they have no sparkline, which is no longer true:

```jsx
        <StatTile
          index={1}
          label="Gross profit"
          value={formatAmount(money('value', 'gross_profit'))}
          delta={delta('gross_profit', true)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.grossProfit)}
        />
        <StatTile
          index={2}
          label="Expenses"
          value={formatAmount(money('value', 'total_expenses'))}
          delta={delta('total_expenses', false)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.expenses)}
        />
        <StatTile
          index={3}
          label="Net profit"
          value={formatAmount(money('value', 'net_profit'))}
          delta={delta('net_profit', true)}
          deltaLabel={deltaLabel}
          sparkline={sparkline.map((t) => t.netProfit)}
        />
```

- [ ] **Step 3: Run the frontend gates**

Run: `cd frontend && npm test`
Expected: all pass.

Run: `cd frontend && npm run lint && npm run build`
Expected: 0 errors; `built in …`. The 4 fast-refresh warnings are pre-existing.

- [ ] **Step 4: Verify against real data without a browser**

Run this and confirm every sparkline array is the same length as the week window, all-numeric,
and free of `null`/`undefined`:

```bash
cat > /tmp/check_series.py <<'PY'
import json
from django.test import Client
from django.contrib.auth.models import User
from rest_framework_simplejwt.tokens import RefreshToken

u = User.objects.get(username='demo@example.com')
h = f'JWT {RefreshToken.for_user(u).access_token}'
c = Client()
KEYS = ['total_revenue', 'total_costs', 'total_cogs', 'gross_profit',
        'total_expenses', 'net_profit']
for period in ('all_time', 'last_month', 'last_year'):
    for group_by in ('day', 'week', 'month', 'year'):
        rows = c.get('/inventory/analytics/',
                     {'period': period, 'group_by': group_by},
                     HTTP_AUTHORIZATION=h).json()['series']
        ok = all(k in r and r[k] is not None and not isinstance(r[k], str)
                 for r in rows for k in KEYS)
        consistent = all(
            abs(float(r['gross_profit']) - (float(r['total_revenue']) - float(r['total_cogs']))) < 0.01
            and abs(float(r['net_profit']) - (float(r['gross_profit']) - float(r['total_expenses']))) < 0.01
            for r in rows
        )
        print(f'{period:10} {group_by:6} rows={len(rows):4} keys_ok={ok} arithmetic_ok={consistent}')
PY
/home/kader/.local/share/virtualenvs/ims-S-s2H65S/bin/python manage.py shell < /tmp/check_series.py
```

Expected: `keys_ok=True arithmetic_ok=True` on all 12 combinations.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Dashboard.jsx
git commit -m "feat: sparklines on the gross and net profit tiles"
```

---

### Task 6.4: Phase 6 documentation

**Files:**
- Modify: `HISTORY.md`, `CLAUDE.md`

- [ ] **Step 1: Add the `HISTORY.md` entry**

Insert above the most recent entry, covering the *why*:

- the series carried no per-period COGS, which is why Phase 3 shipped the profit tiles without
  sparklines rather than drawing revenue-minus-purchases and calling it profit
- revenue and COGS are summed in one `annotate()` because separate calls over the same `items`
  join fan out and multiply each other's row counts
- `net_profit` is allowed to be negative — a month with rent and no sales is a loss, and clamping
  it would hide the month worth seeing
- `fillSeriesGaps` names its keys explicitly, so a new series key not added there is silently
  dropped and renders as a plausible flat-zero sparkline

- [ ] **Step 2: Update `CLAUDE.md`**

Mark Phase 6 done in the status line and phase list. Add to the Working Log:

- **`fillSeriesGaps` (`frontend/src/lib/format.js`) drops any key it does not name.** Adding a field
  to the analytics `series` requires adding it there too, or the chart silently reads `undefined`.
- **Series money keys and summary money keys differ on purpose:** `series` rows use `total_costs`
  for purchases; the summary uses `inventory_outlays`. Both are correct in place.

- [ ] **Step 3: Run the mandatory final check**

Run: `… manage.py test` → `OK`
Run: `cd frontend && npm test && npm run lint && npm run build` → all pass

- [ ] **Step 4: Commit**

```bash
git add HISTORY.md CLAUDE.md
git commit -m "docs: record Phase 6 dashboard profit series"
```

---

# Phase 7 — Camera barcode scanning

**Library choice: `@zxing/library`.** Pure JS/WASM-free, actively maintained, supports every format
required (EAN-13, EAN-8, UPC-A, Code 128) through `DecodeHintType.POSSIBLE_FORMATS`, and exposes
`BrowserMultiFormatReader.decodeFromVideoDevice` which handles the `getUserMedia` plumbing.
`html5-qrcode` bundles its own UI, which would fight the existing glass/Tailwind design system.

**Four things the obvious implementation gets wrong.** These shape the tasks:

1. **`getUserMedia` requires a secure context.** It is unavailable on plain HTTP except on
   `localhost`. Accessing the Vite dev server from a phone over the LAN (`http://192.168.x.x:5173`)
   silently yields no camera. The modal must say so rather than showing an empty black box.
2. **The bundle is already 925 kB and past Vite's 500 kB warning.** `@zxing/library` adds roughly
   200 kB. It must be behind `await import()` inside the modal so it is fetched only when a user
   actually opens the scanner, not on every page load.
3. **Barcodes are not unique** — Phase 4 decided that deliberately, and
   `ProductBarcodeTests.test_two_products_may_share_a_barcode` pins it. A scan can therefore match
   several products, and "take the first result" would silently add the wrong item to an order.
4. **`?search=` is `icontains` across name, description *and* barcode.** Scanning `4006` would match
   a product whose description mentions it. Lookup needs an exact-match filter, which is Task 7.1.

**Testing approach.** No camera and no browser automation. `lib/barcode.js` holds the pure logic and
is unit-tested directly; the modal and the three call sites are tested with `@zxing/library` mocked
via `vi.mock`, driving decode callbacks by hand. This is the only way to test a scanner under the
project's verification rules, and it covers everything except the camera itself.

---

### Task 7.1: Exact barcode lookup endpoint

**Files:**
- Modify: `inventory/filters.py`, `inventory/tests.py`

**Interfaces:**
- Consumes: `Product.barcode` (Phase 4).
- Produces: `GET /inventory/products/?barcode=<code>` — exact match, account-scoped.

- [ ] **Step 1: Write the failing tests**

Append to `inventory/tests.py`:

```python
class BarcodeLookupFilterTests(AccountFixtureMixin, TestCase):
    """
    A scan needs an exact match. ?search= is icontains across name, description and barcode,
    so scanning '4006' would also return a product whose description happens to contain it —
    and the scanner adds items to orders without a human confirming each one.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('blk')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.url = '/inventory/products/'

    def make_product(self, name, barcode=None, account=None, description=''):
        return Product.objects.create(
            name=name, description=description, cost_price='1.00',
            default_sell_price='2.00', category=self.category,
            account=account or self.account, barcode=barcode, stock_quantity=10,
        )

    def test_an_exact_barcode_returns_only_that_product(self):
        self.make_product('Widget', barcode='5901234123457')
        self.make_product('Gadget', barcode='4006381333931')

        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Widget')

    def test_a_partial_code_matches_nothing(self):
        self.make_product('Widget', barcode='5901234123457')
        response = self.client.get(
            self.url, {'barcode': '59012'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 0)

    def test_a_code_appearing_in_a_description_is_not_matched(self):
        self.make_product('Widget', barcode='5901234123457')
        self.make_product('Decoy', description='replaces part 5901234123457')
        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Widget')

    def test_a_shared_barcode_returns_every_match(self):
        # Barcodes are deliberately non-unique (Phase 4). The caller disambiguates; the API
        # must not silently pick one.
        self.make_product('Loose apples', barcode='2000000000001')
        self.make_product('Loose pears', barcode='2000000000001')
        response = self.client.get(
            self.url, {'barcode': '2000000000001'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 2)

    def test_the_lookup_is_account_scoped(self):
        other_account, _, _, _ = self.make_account_user('blk2')
        other_category = Category.objects.create(name='Theirs', account=other_account)
        Product.objects.create(
            name='Theirs', description='', cost_price='1.00', default_sell_price='2.00',
            category=other_category, account=other_account, barcode='5901234123457',
        )
        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 0)
```

- [ ] **Step 2: Run and verify failure**

Run: `… manage.py test inventory.tests.BarcodeLookupFilterTests`
Expected: FAIL — the unknown `barcode` param is ignored, so counts are 2 and 1 instead of 1 and 0.

- [ ] **Step 3: Add the filter**

In `inventory/filters.py`, `ProductFilter`:

```python
class ProductFilter(FilterSet):
    # Exact, unlike the icontains ?search=. A scanner submits a complete code and a partial
    # match would resolve to the wrong product with no way for the user to tell.
    barcode = filters.CharFilter(field_name='barcode', lookup_expr='exact')

    class Meta:
        model = Product
        fields = {
            'category_id': ['exact'],
            'supplier_id':['exact'],
            'default_sell_price': ['lt','gt'],
        }
```

- [ ] **Step 4: Run and verify it passes**

Run: `… manage.py test inventory.tests.BarcodeLookupFilterTests` → OK, 5 tests
Run: `… manage.py test` → `OK`

- [ ] **Step 5: Commit**

```bash
git add inventory
git commit -m "feat: exact barcode filter for scanner lookups"
```

---

### Task 7.2: The pure scanning logic

**Files:**
- Create: `frontend/src/lib/barcode.js`, `frontend/src/lib/barcode.test.js`
- Modify: `frontend/package.json`

**Interfaces:**
- Produces:
  - `SUPPORTED_FORMAT_NAMES: string[]` — `['EAN_13','EAN_8','UPC_A','CODE_128']`
  - `isSecureContextForCamera(win): boolean`
  - `pickCamera(devices, facing): MediaDeviceInfo | null` — `facing` is `'back' | 'front'`
  - `normalizeScan(text): string | null` — trims, strips spaces, rejects empty
  - `describeCameraError(error): string` — maps a `getUserMedia` DOMException to user-facing copy

- [ ] **Step 1: Install the library**

```bash
cd frontend && npm install @zxing/library
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/lib/barcode.test.js`:

```js
import { describe, expect, it } from 'vitest'
import {
  SUPPORTED_FORMAT_NAMES,
  describeCameraError,
  isSecureContextForCamera,
  normalizeScan,
  pickCamera,
} from '@/lib/barcode'

describe('SUPPORTED_FORMAT_NAMES', () => {
  it('covers the retail formats the brief requires', () => {
    expect(SUPPORTED_FORMAT_NAMES).toEqual(['EAN_13', 'EAN_8', 'UPC_A', 'CODE_128'])
  })
})

describe('isSecureContextForCamera', () => {
  it('accepts a secure context', () => {
    expect(isSecureContextForCamera({ isSecureContext: true, location: { hostname: 'x' } })).toBe(true)
  })

  it('accepts plain-http localhost, which browsers treat as secure', () => {
    expect(isSecureContextForCamera({ isSecureContext: false, location: { hostname: 'localhost' } })).toBe(true)
  })

  it('rejects a LAN address over http — the phone-testing trap', () => {
    expect(isSecureContextForCamera({ isSecureContext: false, location: { hostname: '192.168.1.20' } })).toBe(false)
  })
})

describe('pickCamera', () => {
  const front = { deviceId: 'a', label: 'FaceTime HD Camera (front)' }
  const back = { deviceId: 'b', label: 'Back Camera' }

  it('prefers a rear camera for scanning', () => {
    expect(pickCamera([front, back], 'back')).toBe(back)
  })

  it('finds the front camera when asked', () => {
    expect(pickCamera([front, back], 'front')).toBe(front)
  })

  it('falls back to the only camera rather than returning nothing', () => {
    expect(pickCamera([front], 'back')).toBe(front)
  })

  it('returns null when there are no cameras at all', () => {
    expect(pickCamera([], 'back')).toBeNull()
  })
})

describe('normalizeScan', () => {
  it('strips whitespace a scanner appends', () => {
    expect(normalizeScan('  5901234123457 ')).toBe('5901234123457')
  })

  it('rejects an empty read', () => {
    expect(normalizeScan('   ')).toBeNull()
    expect(normalizeScan(null)).toBeNull()
  })
})

describe('describeCameraError', () => {
  it('explains a denied permission in terms the user can act on', () => {
    expect(describeCameraError({ name: 'NotAllowedError' })).toMatch(/permission/i)
  })

  it('explains a missing camera', () => {
    expect(describeCameraError({ name: 'NotFoundError' })).toMatch(/no camera/i)
  })

  it('has a fallback for anything else', () => {
    expect(describeCameraError({ name: 'Whatever' })).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run and verify failure**

Run: `cd frontend && npm test -- barcode`
Expected: FAIL — cannot resolve `@/lib/barcode`.

- [ ] **Step 4: Write the module**

Create `frontend/src/lib/barcode.js`:

```js
// Kept free of React and of @zxing/library itself, so every branch here is testable without a
// camera — which matters because this project forbids browser automation for verification.

export const SUPPORTED_FORMAT_NAMES = ['EAN_13', 'EAN_8', 'UPC_A', 'CODE_128']

/**
 * getUserMedia is unavailable outside a secure context. Browsers make one exception:
 * localhost over plain http. Opening the Vite dev server from a phone on the LAN
 * (http://192.168.x.x:5173) is therefore silently camera-less, which reads as a broken
 * feature rather than a platform rule — hence the explicit check and message.
 */
export function isSecureContextForCamera(win = window) {
  if (win.isSecureContext) return true
  return ['localhost', '127.0.0.1', '::1'].includes(win.location?.hostname)
}

const BACK_HINTS = ['back', 'rear', 'environment']
const FRONT_HINTS = ['front', 'user', 'face']

export function pickCamera(devices, facing = 'back') {
  if (!devices?.length) return null
  const hints = facing === 'front' ? FRONT_HINTS : BACK_HINTS
  const match = devices.find((device) =>
    hints.some((hint) => (device.label ?? '').toLowerCase().includes(hint)),
  )
  // Labels are empty until permission is granted, and a laptop has one camera with no hint
  // in its name. Falling back to the first device beats refusing to scan.
  return match ?? devices[0]
}

export function normalizeScan(text) {
  const trimmed = (text ?? '').trim()
  return trimmed === '' ? null : trimmed
}

export function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in your browser settings and try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.'
    case 'NotReadableError':
      return 'The camera is already in use by another app.'
    default:
      return "The camera couldn't be started. You can type the barcode instead."
  }
}
```

- [ ] **Step 5: Run and verify it passes**

Run: `cd frontend && npm test -- barcode`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/barcode.js frontend/src/lib/barcode.test.js
git commit -m "feat: pure barcode scanning helpers and @zxing/library"
```

---

### Task 7.3: `BarcodeScannerModal`

**Files:**
- Create: `frontend/src/components/ui/BarcodeScannerModal.jsx`,
  `frontend/src/components/ui/BarcodeScannerModal.test.jsx`

**Interfaces:**
- Consumes: `lib/barcode.js` (Task 7.2), `components/ui/Modal.jsx`.
- Produces: `<BarcodeScannerModal open onClose onScan title />` — `onScan(code: string)` fires once
  per accepted read with a normalised code.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/ui/BarcodeScannerModal.test.jsx`:

```jsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BarcodeScannerModal } from '@/components/ui/BarcodeScannerModal'

const decodeFromVideoDevice = vi.fn()
const reset = vi.fn()

// The library is loaded with await import() inside the component; mocking the module id
// intercepts that. No camera is ever touched, which is what makes this testable at all.
vi.mock('@zxing/library', () => ({
  BrowserMultiFormatReader: class {
    decodeFromVideoDevice(...args) { return decodeFromVideoDevice(...args) }
    reset(...args) { return reset(...args) }
  },
  DecodeHintType: { POSSIBLE_FORMATS: 'POSSIBLE_FORMATS' },
  BarcodeFormat: { EAN_13: 1, EAN_8: 2, UPC_A: 3, CODE_128: 4 },
}))

describe('BarcodeScannerModal', () => {
  beforeEach(() => {
    decodeFromVideoDevice.mockReset()
    reset.mockReset()
    navigator.mediaDevices = {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      enumerateDevices: vi.fn().mockResolvedValue([
        { kind: 'videoinput', deviceId: 'a', label: 'Front Camera' },
        { kind: 'videoinput', deviceId: 'b', label: 'Back Camera' },
      ]),
    }
  })

  it('reports a decoded code exactly once', async () => {
    const onScan = vi.fn()
    decodeFromVideoDevice.mockImplementation((id, el, cb) => {
      cb({ getText: () => '5901234123457' }, null)
    })

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={onScan} />)
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('5901234123457'))
    expect(onScan).toHaveBeenCalledTimes(1)
  })

  it('ignores the not-found errors zxing emits on every idle frame', async () => {
    const onScan = vi.fn()
    decodeFromVideoDevice.mockImplementation((id, el, cb) => {
      cb(null, { name: 'NotFoundException' })
    })

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={onScan} />)
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled())
    expect(onScan).not.toHaveBeenCalled()
    expect(screen.queryByText(/couldn't be started/i)).not.toBeInTheDocument()
  })

  it('explains a denied camera permission', async () => {
    navigator.mediaDevices.getUserMedia = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }))

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    expect(await screen.findByText(/permission was denied/i)).toBeInTheDocument()
  })

  it('offers a camera switch when more than one is present', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    expect(await screen.findByRole('button', { name: /switch camera/i })).toBeInTheDocument()
  })

  it('restarts the reader on the other camera when switched', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    const button = await screen.findByRole('button', { name: /switch camera/i })

    const firstDevice = decodeFromVideoDevice.mock.calls[0][0]
    await userEvent.click(button)
    await waitFor(() => {
      const lastDevice = decodeFromVideoDevice.mock.calls.at(-1)[0]
      expect(lastDevice).not.toBe(firstDevice)
    })
  })

  it('stops the camera when closed', async () => {
    decodeFromVideoDevice.mockImplementation(() => {})
    const { rerender } = render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    await waitFor(() => expect(decodeFromVideoDevice).toHaveBeenCalled())
    rerender(<BarcodeScannerModal open={false} onClose={vi.fn()} onScan={vi.fn()} />)
    await waitFor(() => expect(reset).toHaveBeenCalled())
  })

  it('says so when the page is not a secure context', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    const { hostname } = window.location
    delete window.location
    window.location = { ...window.location, hostname: '192.168.1.20' }

    render(<BarcodeScannerModal open onClose={vi.fn()} onScan={vi.fn()} />)
    expect(await screen.findByText(/https/i)).toBeInTheDocument()

    window.location = { hostname }
    if (original) Object.defineProperty(window, 'isSecureContext', original)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd frontend && npm test -- BarcodeScannerModal`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Build the component**

Create `frontend/src/components/ui/BarcodeScannerModal.jsx`. Key requirements, all covered by the
tests above:

- `await import('@zxing/library')` **inside** an effect, never a top-level import — this is what keeps
  ~200 kB out of the initial bundle.
- Check `isSecureContextForCamera()` before touching `navigator.mediaDevices` and render the
  HTTPS explanation instead of a black box.
- Call `getUserMedia` once to trigger the permission prompt, then `enumerateDevices()` — device
  labels are empty strings until permission is granted, which is what `pickCamera`'s fallback exists
  for.
- Configure hints: `new Map([[DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMAT_NAMES.map((n) => BarcodeFormat[n])]])`.
- In the decode callback, **ignore `NotFoundException`** — zxing emits it continuously for every
  frame without a barcode. Treating it as an error puts the modal into a permanent failure state.
- Guard `onScan` with a ref so a code decoded across several frames fires once.
- On close or unmount, call `reader.reset()` and stop every track, or the camera light stays on.
- Render a `<video>` with `playsInline` and `muted` (iOS Safari refuses to play inline otherwise),
  a "Switch camera" button when `videoDevices.length > 1`, and a visible hint that the field can be
  typed instead.

- [ ] **Step 4: Run and verify it passes**

Run: `cd frontend && npm test -- BarcodeScannerModal`
Expected: 7 tests pass.

- [ ] **Step 5: Confirm the library stayed out of the main bundle**

Run: `cd frontend && npm run build`
Expected: a separate chunk for the zxing code, and the main `index-*.js` no more than ~15 kB larger
than before. If zxing landed in the main chunk, the `import()` was hoisted — check it is not also
imported at the top of any file.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/BarcodeScannerModal.jsx frontend/src/components/ui/BarcodeScannerModal.test.jsx
git commit -m "feat: reusable barcode scanner modal"
```

---

### Task 7.4: Barcode lookup hook

**Files:**
- Create: `frontend/src/hooks/useBarcodeLookup.js`, `frontend/src/hooks/useBarcodeLookup.test.js`

**Interfaces:**
- Consumes: `GET /inventory/products/?barcode=` (Task 7.1).
- Produces: `lookupByBarcode(code) => Promise<{ status, products }>` where `status` is
  `'found' | 'ambiguous' | 'not_found' | 'error'`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/hooks/useBarcodeLookup.test.js`:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupByBarcode } from '@/hooks/useBarcodeLookup'

const get = vi.fn()
vi.mock('@/lib/api', () => ({ api: { get: (...args) => get(...args) } }))

describe('lookupByBarcode', () => {
  beforeEach(() => get.mockReset())

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
    get.mockRejectedValue(new Error('offline'))
    expect((await lookupByBarcode('5901234123457')).status).toBe('error')
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd frontend && npm test -- useBarcodeLookup`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook module**

```js
import { api } from '@/lib/api'

/**
 * Resolve a scanned code to a product.
 *
 * Uses ?barcode= (exact) rather than ?search= (icontains over name, description and
 * barcode): a scanner submits a complete code, and a fuzzy match would silently add the
 * wrong product to an order. Several matches are reported as ambiguous rather than resolved
 * by guessing — barcodes are deliberately non-unique in this app.
 */
export async function lookupByBarcode(code) {
  try {
    const { data } = await api.get('/inventory/products/', { params: { barcode: code } })
    const products = data.results ?? []
    if (products.length === 0) return { status: 'not_found', products }
    if (products.length > 1) return { status: 'ambiguous', products }
    return { status: 'found', products }
  } catch {
    return { status: 'error', products: [] }
  }
}
```

- [ ] **Step 4: Run and verify it passes**

Run: `cd frontend && npm test -- useBarcodeLookup`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useBarcodeLookup.js frontend/src/hooks/useBarcodeLookup.test.js
git commit -m "feat: exact barcode product lookup"
```

---

### Task 7.5: Scan button on the product form

**Files:**
- Modify: `frontend/src/components/forms/ProductForm.jsx`
- Create: `frontend/src/components/forms/ProductForm.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('fills the barcode field from a scan', async () => {
  render(<ProductForm open onClose={vi.fn()} onSaved={vi.fn()} categories={[]} suppliers={[]} />)
  await userEvent.click(screen.getByRole('button', { name: /scan barcode/i }))
  // The mocked scanner modal exposes a button that fires onScan with a fixed code.
  await userEvent.click(await screen.findByRole('button', { name: /simulate scan/i }))
  expect(screen.getByLabelText(/barcode/i)).toHaveValue('5901234123457')
})

it('still accepts a typed barcode', async () => {
  render(<ProductForm open onClose={vi.fn()} onSaved={vi.fn()} categories={[]} suppliers={[]} />)
  await userEvent.type(screen.getByLabelText(/barcode/i), '4006381333931')
  expect(screen.getByLabelText(/barcode/i)).toHaveValue('4006381333931')
})
```

with `BarcodeScannerModal` mocked:

```jsx
vi.mock('@/components/ui/BarcodeScannerModal', () => ({
  BarcodeScannerModal: ({ open, onScan }) =>
    open ? <button onClick={() => onScan('5901234123457')}>Simulate scan</button> : null,
}))
```

- [ ] **Step 2: Run and verify failure** — `cd frontend && npm test -- ProductForm`

- [ ] **Step 3: Add the button.** A `ScanLine`-icon button beside the barcode `TextInput`, opening
  `BarcodeScannerModal`; `onScan` sets `form.barcode` and closes the modal. The input keeps its
  `placeholder="Optional — scan or type the code"` and stays fully editable.

- [ ] **Step 4: Run and verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat: scan a barcode into the product form"`

---

### Task 7.6: Scan-to-add in the order flow

**Files:**
- Modify: `frontend/src/components/forms/OrderForm.jsx`
- Create: `frontend/src/components/forms/OrderForm.scan.test.jsx`

**The load-bearing constraint:** Phase 1's stock cap. `maxQuantityFor(items, index)` already computes
how many units a line may claim given what the other lines have claimed. Scan-to-increment must go
through it, or a repeated scan walks stock negative and the server rejects the whole order at submit
time with no indication which line was at fault.

- [ ] **Step 1: Write the failing tests**

```jsx
it('adds a scanned product as a new line', async () => { /* lookup mocked -> found */ })

it('increments the existing line when the same product is scanned twice', async () => {
  // Second scan must not create a duplicate line.
})

it('does not increment past the stock cap', async () => {
  // Product with stock_quantity 2, scanned three times -> quantity stays 2 and a message shows.
})

it('shows a message when the code matches nothing, and adds no line', async () => {})

it('asks which product when a barcode matches several', async () => {})

it('leaves manual product search working', async () => {
  // ProductPicker still opens and selects by name.
})
```

- [ ] **Step 2: Run and verify failure**

- [ ] **Step 3: Implement.** A "Scan barcode" button beside "Add item". On `found`: if a line already
  holds that product id, increment its quantity capped by `maxQuantityFor`; otherwise fill the first
  empty line, or append one. On `ambiguous`: render the matches and let the user choose. On
  `not_found` / `error`: a toast, no mutation.

- [ ] **Step 4: Run and verify it passes.**

- [ ] **Step 5: Commit** — `git commit -m "feat: scan to add or increment an order line"`

---

### Task 7.7: Scan-to-select in the purchase flow

**Files:**
- Modify: `frontend/src/components/forms/PurchaseForm.jsx`
- Create: `frontend/src/components/forms/PurchaseForm.scan.test.jsx`

Purchases have **no stock ceiling** — they add stock — so this is the simpler of the two: scan
selects the product on a line and fills `unit_price` from `cost_price`, matching what
`handleProductChange` already does. Everything else mirrors Task 7.6, including the ambiguous and
not-found paths and manual search remaining available.

- [ ] **Step 1: Write the failing tests** (select on scan; increment on repeat scan; no stock cap
  applies; manual search still works; not-found shows a message)
- [ ] **Step 2: Run and verify failure**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run and verify it passes**
- [ ] **Step 5: Commit** — `git commit -m "feat: scan to select a product on a purchase line"`

---

### Task 7.8: Phase 7 documentation

**Files:** Modify `HISTORY.md`, `CLAUDE.md`

- [ ] **Step 1: `HISTORY.md`** — cover: why `?barcode=` exact exists rather than reusing `?search=`;
  why a scan can be ambiguous (non-unique barcodes are a Phase 4 decision) and why the UI asks rather
  than guesses; why zxing is dynamically imported; the `NotFoundException`-per-frame trap; why
  `getUserMedia` needs HTTPS and what that means for phone testing; and that the scanner is verified
  with a mocked decoder because browser automation is forbidden.

- [ ] **Step 2: `CLAUDE.md`** — mark Phase 7 done; add Working Log entries:
  - **`@zxing/library` must stay behind `await import()`** — a top-level import puts ~200 kB into
    every page load of an already-oversized bundle.
  - **zxing calls the decode callback with `NotFoundException` on every frame without a barcode.**
    Treating that as an error breaks the scanner permanently.
  - **Scanned lookups use `?barcode=` (exact), never `?search=`** (icontains over name/description).
  - **Camera scanning cannot be verified in this project** — no browser automation. Tests mock
    `@zxing/library` and drive the callback by hand.

- [ ] **Step 3: Full gates** — `… manage.py test` → `OK`; `npm test && npm run lint && npm run build`

- [ ] **Step 4: Commit** — `git commit -m "docs: record Phase 7 camera barcode scanning"`

---

# Phase 8 — Defensive security audit & hardening

### ⛔ Task 8.0: STOP — do not start Phase 8 without confirmation

**This is a hard gate the user set.** Do not run any Phase 8 task until the user has installed the
tooling and confirmed it is ready.

- [ ] **Step 1: Ask the user to install the tools and wait for confirmation**

Post this and stop:

> Phase 8 needs security tooling that isn't installed here. Please install and confirm:
>
> - `pip-audit` — dependency CVEs (`pipenv install --dev pip-audit`)
> - `bandit` — Python SAST (`pipenv install --dev bandit`)
> - `semgrep` — cross-language SAST (`pipenv install --dev semgrep`, or the MCP server)
> - `npm audit` — already available, no install needed
>
> Tell me when they're ready and I'll start Phase 8. Also confirm whether adding these as dev
> dependencies to the `Pipfile` is acceptable — note that `pipenv install` relocks, which has
> silently bumped Django and DRF in this repo before (see the Working Log), so I'd install them
> into the virtualenv with `pip` and leave the lockfile alone unless you say otherwise.

- [ ] **Step 2: Do not proceed until the user confirms.**

---

### Task 8.1: Dependency and SAST scan

- [ ] Run `pip-audit`, `bandit -r inventory accounts ims`, `npm audit`, and
      `semgrep --config=auto` over backend and frontend.
- [ ] Record every finding in `docs/superpowers/specs/2026-08-09-phase-8-security-audit-findings.md`
      with severity, file:line, and a proposed action — **report first, fix second.** Do not change
      code in this task; a scan report that has been edited as it was written is not a baseline.
- [ ] Note the two known items up front so they are not re-litigated: `react-router-dom` has 2 open
      high-severity advisories where `npm audit fix --force` downgrades to 7.11.0 (breaking, left
      alone deliberately), and `CORS_ALLOW_ALL_ORIGINS = True` is a known dev-only setting that
      Task 8.3 fixes.
- [ ] Commit the report only: `git commit -m "docs: Phase 8 security scan baseline"`

---

### Task 8.2: Multi-tenant isolation and authorization matrix

**Files:** Modify `inventory/tests.py`, `accounts/tests.py`

The repo has isolation tests, but they were written per-feature as each phase landed. This task
replaces ad-hoc coverage with an exhaustive matrix, so a *future* endpoint added without scoping
fails a test rather than shipping.

- [ ] **Step 1: Write the matrix test**

For every account-scoped collection — `products`, `categories`, `suppliers`, `customers`,
`purchases`, `orders`, `expenses`, plus nested `products/{id}/images/` — assert, for account B
against a row owned by account A:

| Method | Expected |
|---|---|
| `GET /inventory/<res>/` | row absent from results |
| `GET /inventory/<res>/<A-id>/` | 404 (never 403 — a 403 confirms the row exists) |
| `PATCH /inventory/<res>/<A-id>/` | 404, row unchanged in the DB |
| `DELETE /inventory/<res>/<A-id>/` | 404, row still present in the DB |
| `POST` referencing an A-owned FK by id | 400, or the FK is silently rescoped — never accepted |

Drive it from a list of resource names so adding a resource without adding it to the list is itself
a visible omission.

- [ ] **Step 2: Write the subscription-gate test.** For each `subscription_status` in
      `pending_verification`, `pending_payment`, `past_due`, `cancelled`, and `active` with an
      `expires_at` in the past: assert every protected endpoint returns 403, and that the documented
      escape hatches (`/billing/subscription/`, resend code, verify code, create checkout, redeem
      key) remain reachable with `IsAuthenticated` only.

- [ ] **Step 3: Run.** Any failure is a real finding — record it in the Task 8.1 report and fix it
      in the same commit as its regression test.

- [ ] **Step 4: Commit** — `git commit -m "test: exhaustive tenant isolation and subscription matrix"`

---

### Task 8.3: CORS lockdown and rate limiting

**Files:** Modify `ims/settings.py`, `inventory/views.py`, `inventory/tests.py`

- [ ] **Step 1: Write the failing tests**
  - with `DEBUG=False`, `CORS_ALLOW_ALL_ORIGINS` is `False` and `CORS_ALLOWED_ORIGINS` is non-empty
  - with `DEBUG=True`, local dev still works unchanged
  - an unlisted `Origin` gets no `Access-Control-Allow-Origin` header when `DEBUG=False`
  - the CSV export endpoints throttle after N requests per hour for one user
  - throttling is per-user, not global — account B is unaffected by account A exhausting its budget

- [ ] **Step 2: Implement**

```python
# CORS_ALLOW_ALL_ORIGINS was a dev convenience and is a real exposure with cookies or any
# future same-site auth. Off outside DEBUG; the explicit allowlist below is the production
# contract, and CORS_ALLOWED_ORIGINS is read from the environment so a new domain does not
# need a deploy of new code.
CORS_ALLOW_ALL_ORIGINS = DEBUG
CORS_ALLOWED_ORIGINS = [
    origin for origin in os.environ.get('CORS_ALLOWED_ORIGINS', '').split(',') if origin
] or [
    'http://localhost:5173',
    'http://tenant1.localhost:5173',
]
```

  Add DRF throttling scoped to the exports — they are the most expensive unauthenticated-cost
  endpoints in the app, walking every line item an account has ever recorded:

```python
REST_FRAMEWORK = {
    # … existing keys …
    'DEFAULT_THROTTLE_CLASSES': ['rest_framework.throttling.ScopedRateThrottle'],
    'DEFAULT_THROTTLE_RATES': {'exports': '30/hour'},
}
```

  and `throttle_scope = 'exports'` on `ExportOrdersCSVView`, `ExportPurchasesCSVView`,
  `ExportProductsCSVView`.

- [ ] **Step 3: Confirm existing auth rate limits and record the result.** `django-axes` guards
      login (`AXES_FAILURE_LIMIT`); the OTP endpoints already throttle resend at 1/min and 5/hr and
      cap wrong attempts at 5. Verify each with a test rather than assuming, and note in the report
      that `django-axes` covers login only.

- [ ] **Step 4: Run the full suite** — `… manage.py test` → `OK`

- [ ] **Step 5: Commit** — `git commit -m "fix: lock down CORS outside DEBUG and throttle CSV exports"`

---

### Task 8.4: Phase 8 documentation

**Files:** Modify `HISTORY.md`, `CLAUDE.md`, and finalise the findings report

- [ ] **Step 1: `HISTORY.md`** — what was scanned, what was found, what was fixed, and what was
      accepted with reasons. Explicitly record anything deliberately *not* fixed (e.g. the
      `react-router-dom` advisories) so it is not rediscovered as a surprise.
- [ ] **Step 2: `CLAUDE.md`** — mark Phase 8 done; update the stale
      "`CORS_ALLOW_ALL_ORIGINS = True` is still on — dev-only, flag it rather than fixing it as a
      drive-by change" note in the Settings section, which Task 8.3 makes obsolete; add Working Log
      entries for the throttle scope and the isolation matrix.
- [ ] **Step 3: Full gates**, then commit:
      `git commit -m "docs: record Phase 8 security audit and hardening"`

---

## Self-Review

**Spec coverage.** Phase 6: per-period COGS/gross/net → Task 6.1; clean formatting across All time /
Last month / Last year → Task 6.1 Step 1 `test_each_dashboard_period_filter_returns_a_well_formed_series`
and Task 6.3 Step 4; sparklines on both profit cards → Task 6.3; empty datasets → `StatTile`'s existing
`length > 1` guard plus Task 6.2's zero-fill, tested in both. Phase 7: library → Task 7.2; modal with
permissions, camera toggle and the four formats → Task 7.3; three integration points → Tasks 7.5–7.7;
dual input → an explicit test in each of 7.5, 7.6, 7.7. Phase 8: stop-and-ask → Task 8.0; scans →
8.1; isolation and subscription → 8.2; CORS and rate limits → 8.3. Docs → 6.4, 7.8, 8.4.

**Known thinner spots, stated rather than hidden.** Tasks 7.6 and 7.7 give test *names* and
behaviours but not full test bodies, because both depend on the exact JSX of forms that Task 7.5's
mocking pattern will settle first; the implementer should write them following 7.5's established
mock. Task 7.3 Step 3 describes the component in requirements rather than complete code — it is the
one piece whose shape depends on how `Modal.jsx` composes, and every requirement listed there is
pinned by a test in Step 1.

**Type consistency.** `lookupByBarcode` returns `{status, products}` with statuses
`found | ambiguous | not_found | error` in Task 7.4 and is consumed under those exact names in 7.6
and 7.7. `BarcodeScannerModal` takes `{open, onClose, onScan, title}` in 7.3 and is mocked with that
same shape in 7.5. Series keys `total_cogs` / `gross_profit` / `net_profit` are identical across
6.1 (API), 6.2 (gap-fill) and 6.3 (chart mapping), and `total_costs` is deliberately preserved in all
three.

**Out of scope, deliberately.** Making the sparkline window follow the period selector — today all
tile sparklines use the fixed last-7-days daily series, and changing that means restructuring
Dashboard's two data-loading effects. Offline scan queueing. Barcode *generation* or label printing.
Per-account unique barcodes (a live Phase 4 decision pinned by a test).
