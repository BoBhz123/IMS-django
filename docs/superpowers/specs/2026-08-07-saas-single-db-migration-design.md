# SaaS Migration, Expenses, Barcodes & Export Totals — Design

**Date:** 2026-08-07
**Status:** Approved
**Branch:** `feature/saas-single-db-migration`

## Summary

Five sequential phases turning `ims` from a schema-per-tenant Django app into a
single-database, subscription-gated SaaS product, plus three smaller features
(expense tracking, product barcodes, CSV export totals).

Phase 2 is the load-bearing one; Phases 3–5 are ordinary feature work that depends on
the account scoping Phase 2 introduces. Phase 1 is independent and ships first
deliberately, so there is one small, verifiable change in front of the risky one.

## Context corrections

The repo's `CLAUDE.md` was written against an earlier state and is wrong in ways that
matter. Actual state as of this design:

- Postgres via `django-tenants` (schema per tenant), not MySQL.
- A full React/Vite frontend under `frontend/`, deployed on Heroku with WhiteNoise.
- Cloudflare R2 media storage, Sentry, `django-axes`, `django-ipware`.
- Tenant onboarding endpoint at `POST /tenants/onboard/`.

`CLAUDE.md` is rewritten as part of this work.

The original brief also referenced identifiers that do not exist:

- `product.stock` → the field is `Product.stock_quantity`.
- `export_orders_to_csv` → that is the *admin action* (`inventory/admin.py`), whose
  columns are `Order ID, Customer, Date, Exchange Rate, Total Value`. The Total
  Cost / Sell / Profit columns described in the brief belong to the *API* view
  `ExportOrdersCSVView` (`inventory/views.py`). Phase 5 targets the API view; the admin
  action gets a totals row too, for consistency.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Existing tenant data is discarded | User directive. Removes the entire cross-schema data-migration risk. |
| D2 | `Account` owns data, not `User` | A tenant was a *business*, not a person. Adding a second employee later becomes a row insert instead of re-migrating every table. |
| D3 | Clean-slate migrations | Inventory tables exist only inside tenant schemas today; switching to the stock Postgres backend leaves the public schema with no inventory tables, so a DB reset is required either way. Additive migrations would backfill zero rows and leave ten migrations of fossil record. |
| D4 | Explicit `AccountScopedMixin`, not thread-local middleware | Auto-filtering managers need ambient global state, which silently does nothing in management commands, shell, and background jobs — exactly where a bulk mistake leaks data. |
| D5 | Write-serializer querysets narrowed per account | `get_queryset` scoping protects reads only. Without this, user A can POST an order referencing user B's product id. |
| D6 | Subscription liveness is *computed*, never read from the status column | Nothing flips `active` → `past_due` without a scheduled job, so the column goes stale and silently gives away free service. |
| D7 | No payment gateway this cycle | Self-contained later phase; it plugs into the fields defined here. Landing Stripe in the same change as the tenant teardown couples two independent risks. |
| D8 | Analytics + CSV exports move from `IsAdminUser` to authenticated subscriber access | See "Permissions guard" below — leaving them as-is either breaks every dashboard or hands every subscriber the platform. |

## Phase 1 — Order stock validation

**Independent of all other phases. Ships first.**

### Backend

`CreateOrderSerializer` gains `validate_items`, rejecting with HTTP 400 before any
write occurs.

Three details the brief's one-line description misses:

1. **Multiplier.** Stock is deducted as `quantity * unit_multiplier`, so validation must
   compare that same product against `stock_quantity`. Validating bare `quantity` would
   let an order pass validation and then drive stock negative.
2. **Duplicate lines.** One order may list the same product on several lines, each
   individually under stock but over in aggregate. Requested units are summed per
   product id before comparison.
3. **Concurrency.** Two orders placed simultaneously can both pass validation and both
   deduct. Inside the existing `@transaction.atomic` `create()`, products are re-read
   with `select_for_update()` and re-checked before the deduction.

Error shape:

```json
{"items": ["Insufficient stock for 'Widget': requested 12, available 5."]}
```

**Pre-existing bug fixed here.** DRF builds a separate `Product` instance per item, so
the current `product.stock_quantity -= …; product.save()` loop writes stale copies when
one product appears on two lines — the second save overwrites the first, and only the
last line's quantity is deducted. Fixed by aggregating per product and issuing one
`F()`-expression update each. The same bug exists in `CreatePurchaseSerializer`
(increments) and is fixed identically. This preserves the existing transactional
intent — purchases add stock, orders remove it, atomically — it only makes the
arithmetic correct.

### Frontend (`OrderForm.jsx`, `ProductPicker.jsx`)

- Line item state carries `stock_quantity` and product name, not just the id.
- Per-line requested units = `quantity * unit_multiplier`; aggregated across lines for
  the same product.
- Quantity increment and submit are disabled once requested reaches available.
- Reuse the existing `StockBadge` component for the "Out of stock" / "Reached limit"
  badge beside the selector.
- Products with `stock_quantity === 0` render disabled in the picker.

Client-side gating is a convenience, not the guard. The server validation is the guard.

## Phase 2 — Single database, accounts, subscriptions

### Models (new `accounts` app)

```
Account
  name                 CharField
  subscription_status  trial | active | past_due | canceled   (default trial)
  plan_type            monthly | one_time | free_trial        (default free_trial)
  expires_at           DateTimeField(null=True, blank=True)
  created_at           DateTimeField(auto_now_add=True)

  @property has_active_subscription  →  status in (trial, active)
                                        AND (expires_at is null OR expires_at > now)

Membership
  user     OneToOneField(User, related_name='membership')
  account  ForeignKey(Account, related_name='memberships')
  is_owner BooleanField(default=False)
  created_at
```

`Membership` is a OneToOne today and becomes a plain FK when multi-user accounts arrive
— that is the whole reason it exists as a separate model rather than an `owner` field.

### Roles

- **Platform superadmin** — `is_superuser` / `is_staff`. Django Admin, all accounts,
  billing controls. Has no `Membership` and is not scoped.
- **Subscriber** — regular user with a `Membership`. Sees only their account's data.
  Never `is_staff`.

### Scoping

- `AccountScopedMixin` on every inventory viewset: `get_queryset()` filters by the
  requesting account, `perform_create()` stamps it.
- `AccountScopedManager.for_account(account)` for non-viewset call sites — analytics,
  CSV exports, admin.
- Write serializers narrow every relational field's queryset to the requesting account:
  `Order.customer`, `OrderItem.product`, `Purchase.supplier`, `PurchaseItem.product`,
  `Product.category`, `Product.supplier`, `ProductImage.product`.

### Permissions guard

`AnalyticsView`, `ExportOrdersCSVView`, `ExportPurchasesCSVView`, and
`ExportProductsCSVView` are currently `IsAdminUser`, and the frontend Dashboard calls
`/inventory/analytics/` on load. Under the new role model `is_staff` means platform
superadmin, so leaving these as-is would either break every subscriber's dashboard or
require making every subscriber a platform admin. They move to
`IsAuthenticated + HasActiveSubscription` and are account-scoped.

`HasActiveSubscription`: superusers bypass; otherwise the user needs a membership whose
account satisfies `has_active_subscription`, else HTTP 403 with a machine-readable
`{"detail": "...", "code": "subscription_expired"}` so the frontend can route to a
subscribe screen rather than showing a generic error.

The global `DEFAULT_PERMISSION_CLASSES` becomes
`[IsAuthenticated, HasActiveSubscription]`. `FullDjangoModelPermissions` is retired:
per-model Django permissions were a proxy for "may this person use the app" in a
single-tenant install; in SaaS the real gates are account scoping and subscription
status. Per-model roles return when accounts get staff members.

### Provisioning

Djoser's `user_create` serializer is overridden so registration atomically creates
`User` + `Account` + `Membership` (owner). Optional `business_name` in the payload,
defaulting to the username. New accounts start `trial` / `free_trial` /
`expires_at = now + 14 days`.

Deliberately a serializer override rather than a `post_save` signal, so
`createsuperuser` does *not* provision an account — platform admins correctly have no
membership.

### Settings and teardown

- Drop `django_tenants` from `INSTALLED_APPS`, `MIDDLEWARE`, `DATABASE_ROUTERS`; DB
  engine → `django.db.backends.postgresql`.
- Delete `SHARED_APPS` / `TENANT_APPS` / `TENANT_MODEL` / `TENANT_DOMAIN_MODEL` /
  `TENANT_BASE_DOMAIN` / `MULTITENANT_RELATIVE_MEDIA_ROOT`.
- Delete the `tenants` app, its URLs, and `ims/storage.py::TenantS3Storage`
  (replaced with plain `S3Boto3Storage`).
- Media namespacing moves from schema to account: `upload_to` becomes a callable
  producing `inventory/images/<account_id>/<filename>`.
- Delete `inventory/migrations/0001`–`0010`; regenerate one `0001_initial`.

### Uniqueness

`Product.name`, `Supplier.name`, `Category.name`, `Customer.name` are globally
`unique=True` today. In a shared table that means the first account to create
"Coca Cola" blocks every other account. All four become
`UniqueConstraint(fields=['account', 'name'])`.

### Frontend

- Signup page + route; `AuthContext` gains `register`.
- `api.js` response interceptor maps `code: "subscription_expired"` to a dedicated
  subscription screen instead of a generic toast.

## Phase 3 — Expenses

```
Expense
  account      ForeignKey(Account, CASCADE)
  description  TextField
  amount       DecimalField(max_digits=10, decimal_places=2, MinValueValidator(0))
  category     CharField(max_length=100, blank=True)
  created_at   DateTimeField(default=timezone.now, db_index=True)
```

`created_at` uses `default=timezone.now` rather than `auto_now_add` so expenses can be
backdated — a receipt entered on Friday for a Tuesday purchase must land in Tuesday's
month, or the month's net profit is wrong.

`ExpenseViewSet`: account-scoped CRUD, `DefaultPagination`, date-range filtering,
ordering by `created_at` / `amount`.

**Net profit.** `AnalyticsView` gains `total_expenses` and redefines
`net_profit = order profit − expenses`, with the *same* `year` / `month` /
`start_date` / `end_date` window applied to expenses as to orders. A mismatched window
here silently misstates profit, so the filter logic is extracted into one helper used
by both sides rather than duplicated.

Frontend: Expenses page (table, create modal, delete confirm, date filters) and a Dock
nav entry.

## Phase 4 — Barcodes

- `Product.barcode = CharField(max_length=64, db_index=True, blank=True, null=True)`.
- `ProductViewSet.search_fields` gains `barcode`, so `?search=<barcode>` matches partial
  and exact via the existing `SearchFilter` — no new endpoint.
- Frontend: optional Barcode input on Product create/edit; barcode tag in the product
  list when present.

Not unique, per the brief. Uniqueness per account is a reasonable later addition but
would reject legitimate bulk entry of unlabeled items sharing a blank-ish code, so it is
left off deliberately rather than by omission.

Camera scanning is out of scope; the search API is shaped so a scanner only needs to
feed the existing `?search=` parameter.

## Phase 5 — CSV export totals row

`ExportOrdersCSVView` accumulates while writing rows and appends:

```
["TOTALS", "", "", "", "", "", "", "", <cost>, <sell>, <profit>]
```

**The existing "Total Profit" column repeats the whole order's profit on every line of
that order.** Summing that column would multiply each order's profit by its line count.
The totals row therefore sums *per-line* profit
(`(unit_price − cost_price) × quantity × unit_multiplier`), which is why this is called
out rather than left to the implementer.

The admin action `export_orders_to_csv` gets a matching totals row for its single
`Total Value` column.

## Testing

The repo has no tests today (`inventory/tests.py` is the Django stub). Each phase lands
with tests, written before the implementation:

| Phase | Coverage |
|---|---|
| 1 | Over-stock rejected 400; exact-stock accepted; duplicate lines aggregate; multiplier respected; zero-stock rejected; stock correct after duplicate-line order |
| 2 | Cross-account read returns 404/empty; cross-account FK injection rejected 400; expired subscription 403; trial passes; superuser bypasses; signup provisions account+membership; `createsuperuser` provisions neither |
| 3 | Expense CRUD scoped; net profit subtracts expenses; date window applies to both sides |
| 4 | Search matches exact and partial barcode; blank barcode not matched by empty search |
| 5 | Totals row values equal the sum of data rows; profit is not multiplied by line count |

## Risks

- **Phase 2 is irreversible.** Local and Heroku databases are reset; the two live tenant
  subdomains lose their data. Accepted per D1.
- **Deployment is not in scope.** No Heroku config changes are made as part of this
  work; the reset and the env-var changes it implies are a separate, explicitly
  authorized step.
- **Phase ordering is a dependency chain.** Phases 3–5 all touch models that Phase 2
  restructures. Running them out of order means writing migrations twice.
