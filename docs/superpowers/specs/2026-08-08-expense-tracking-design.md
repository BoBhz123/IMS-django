# Expense Tracking & Financial Reporting — Design

**Date:** 2026-08-08
**Status:** Approved
**Branch:** `feature/saas-single-db-migration`
**Phase:** 3

## Summary

Account-scoped expense records, and a financial reporting model that tells the truth. Phase 3 adds
`Expense` CRUD, but the larger part of the work is fixing what "profit" means: the app currently
computes it two different ways in two different places, and neither survives a product's cost being
edited.

## The problem this phase actually solves

Two contradicting definitions of profit ship today:

| Where | Formula | Meaning |
|---|---|---|
| `AnalyticsView` (dashboard) | `revenue − purchases in window` | cash out vs cash in |
| `ExportOrdersCSVView`, `Order.total_profit` | `revenue − cost_price of items sold` | margin (COGS) |

They diverge badly under normal operation. Buy $5,000 of stock in January and sell it over six months
and the dashboard reports a January loss followed by five inflated months, while the CSV export
reports steady margin throughout. Both are labelled "profit".

Separately, `OrderItem.profit` reads `self.product.cost_price` live (`inventory/models.py:222`), so
raising a product's cost silently rewrites every past month's reported profit. Last year's numbers are
not reproducible.

Adding expenses on top of either definition would compound the problem, so the definitions are
resolved first.

## Financial model

Two distinct ledgers, never mixed:

**Profit & loss**

| Metric | Formula |
|---|---|
| `total_revenue` | orders in window |
| `total_cogs` | snapshotted cost of the items sold in those orders |
| `gross_profit` | `total_revenue − total_cogs` |
| `total_expenses` | expenses in window |
| `net_profit` | `gross_profit − total_expenses` |

**Cash flow**

| Metric | Formula |
|---|---|
| `inventory_outlays` | purchases in window |

Inventory spend stays visible — it is the largest cash movement the business makes — but it is kept
out of the P&L, where it would corrupt margin with restocking timing. Renamed from `total_costs`,
which sitting next to a new `total_cogs` would be a permanent invitation to read the wrong number.

**Currency.** All amounts are USD, consistent with the rest of the app. LBP is a frontend display
toggle only. This phase adds no currency handling; see the USD-only rule in the payment gateway
design for the billing side of the same principle.

## Components

### 1. COGS snapshot

`OrderItem` gains `unit_cost_price`, stamped from `product.cost_price` inside the existing
`@transaction.atomic` `create()` in `CreateOrderSerializer` — the same block that already deducts
stock, so the cost is captured at the instant of sale. `OrderItem.profit` reads the snapshot.

Migration is three steps: add nullable, backfill from the product's current `cost_price`, set
non-null. Existing rows survive.

**Backfilled history is frozen at today's costs.** That is an approximation — the true historical cost
is not recorded anywhere and cannot be recovered — and it is the last moment the number is knowable.
Every order placed after this ships is exact. This limitation is recorded in `HISTORY.md` rather than
left to be rediscovered.

Three consumers read the cost and must move together or they will disagree: `OrderItem.profit`,
`ExportOrdersCSVView` (API), and `export_orders_to_csv` (admin action). The last two are separate
implementations with near-identical names — a known trap in this codebase.

Snapshotting also decouples profit from the product row: `OrderItem.profit` currently returns `None`
when `product_id` is unset, and after this it does not need the product at all.

### 2. `DateWindow`

`AnalyticsView` applies `year` / `month` / `start_date` / `end_date` / `period` inline, repeated per
queryset — already five filters across three querysets. Expenses would be a fourth, and a window
applied to orders but not to expenses silently misstates net profit with no error anywhere.

New `inventory/reporting.py`:

```python
window = DateWindow.from_query_params(request.query_params)
orders   = window.apply(orders,   'placed_at')
expenses = window.apply(expenses, 'spent_at')
products = window.apply(products, 'order__placed_at')
```

A frozen dataclass with `from_query_params()` and `apply(queryset, field)`. Extracted as a pure
refactor with no behaviour change *before* expenses are added, so the diff that adds expenses cannot
hide a filtering regression.

### 3. `Expense`

Lives in `inventory/`, alongside the other account-scoped business records.

```python
class Expense(models.Model):
    account     = ForeignKey(Account, CASCADE, related_name='expenses')
    description = CharField(max_length=255)
    amount      = DecimalField(max_digits=10, decimal_places=2, MinValueValidator(0))
    category    = CharField(max_length=32, choices=CATEGORY_CHOICES, default=OTHER)
    spent_at    = DateTimeField(default=timezone.now, db_index=True)
    created_at  = DateTimeField(auto_now_add=True)
```

Two deviations from the Phase 3 sketch in the original SaaS migration design, both deliberate:

**`spent_at` rather than `created_at` for the business date.** The sketch named the backdatable field
`created_at`, which then does not mean "created" — a trap for anyone reading the model later.
`Purchase` and `Order` already use `placed_at` for exactly this concept. `default=timezone.now` (never
`auto_now_add`) is what makes backdating possible: a receipt entered Friday for a Tuesday spend must
land in Tuesday's month, or that month's net profit is wrong. A separate `created_at` with
`auto_now_add` keeps a genuine audit trail of when the row was entered, which a money record warrants.

**`category` is a fixed choice list, not free text.** `Rent`, `Utilities`, `Salaries`, `Marketing`,
`Software`, `Transport`, `Maintenance`, `Taxes & Fees`, `Other`. Free text fragments `Rent`, `rent`
and `Rent ` into separate rows in any per-category breakdown, which is the main reason to record a
category at all. Stored as a stable key, rendered from `choices`; adding a category later is a
`choices` edit, not a migration. An unanticipated category lands in `Other` until the list is edited —
an accepted cost.

`ExpenseViewSet` is ordinary account-scoped CRUD: `AccountScopedMixin`, `DefaultPagination`, an
`ExpenseFilter` for category and date/amount ranges, `search_fields` on description, `ordering_fields`
on `spent_at` / `amount` / `category`, default `-spent_at`.

`Expense` has no relational field other than `account`, so it is the one write serializer in the app
that legitimately needs no `account_scoped_fields`. Worth a comment, or the next reader assumes the
second half of scoping was forgotten.

### 4. Analytics payload

`AnalyticsView` returns the six metrics above. The chart `series` gains a per-period `total_expenses`
alongside revenue and costs.

**Money returns as raw numbers, not `"$1,234.00"` strings.** The view currently pre-formats summary
figures, and the dashboard immediately `parseMoney()`s them back to numbers so the LBP toggle can
reformat them (`Dashboard.jsx:222-228`) — format, parse, reformat. New tiles need the same toggle, so
the round trip is removed rather than extended. `series` already returns raw numbers, so this also
makes the payload internally consistent.

### 5. Frontend

- `pages/Expenses.jsx` — table, create/edit modal, delete confirmation, date and category filters, and
  a Dock nav entry.
- Dashboard — tiles for gross profit, expenses and net profit; the existing costs tile relabelled to
  inventory outlays.
- `lib/expenses.js` for category labels and any pure formatting, unit-tested without React, matching
  the `lib/stock.js` and `lib/billing.js` pattern.

## Testing

Django test runner and Vitest only. No browser automation.

The load-bearing cases:

- editing a product's `cost_price` after a sale leaves that order's historical profit unchanged
- `DateWindow` applies an identical window to orders and expenses, for every parameter it supports
- net profit arithmetic across a window containing both orders and expenses
- account isolation on every expense endpoint, read and write
- backdated expenses land in the month they were spent, not the month they were entered
- both CSV exporters report the snapshot cost

## Out of scope

Recurring or scheduled expenses. Receipt image attachments. An expense CSV export (Phase 5 covers
export totals for orders and purchases). Multi-currency expense entry — amounts are USD like every
other price in the app. Expense approval workflows or multi-user attribution, which need the second
account user that Phase 2 deferred.

## Risks

**The backfill is an approximation.** Every pre-existing `OrderItem` is stamped with today's cost, so
historical gross profit shifts once at migration time and is stable thereafter. For a business whose
costs have moved significantly, older months will not match what was previously reported. The
alternative — leaving profit permanently recomputed from live costs — means no month is ever
reproducible, which is worse.

**`net_profit` changes meaning.** It currently means `revenue − purchases`; it will mean
`gross_profit − expenses`. This is the intended correction, but the number on the dashboard will move,
and the accompanying `inventory_outlays` tile is what preserves the old view of cash spent on stock.
