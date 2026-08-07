# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Django REST Framework API for an inventory/order management system (IMS), tracking products,
suppliers, customers, purchases (stock in) and orders (stock out). Prices are stored in USD but each
`Purchase`/`Order` also stores an `exchange_rate` (defaults to 89000, i.e. LBP) for record-keeping —
this is a Lebanon-focused business tool doing informal dual-currency bookkeeping, not live FX conversion.

## Commands

```bash
pipenv install          # install deps (see "Pipfile is out of date" gotcha below)
pipenv shell             # activate the virtualenv

python manage.py runserver
python manage.py makemigrations inventory
python manage.py migrate
python manage.py createsuperuser
python manage.py test                    # whole suite
python manage.py test inventory.tests    # single app (currently empty — see below)
```

There is no lint/format config (no ruff/flake8/black config files) and no CI in this repo.

## Testing policy

**`pipenv run python manage.py test` is the mandatory final check at the end of every phase.**
A phase is not complete until it passes. Expected output ends with:

```
Ran <N> tests in <T>s

OK
```

Frontend: `cd frontend && npm test` (Vitest). Also `npm run lint` and `npm run build` before calling
frontend work done — the build catches import errors that neither the tests nor the linter see.

**Do not use browser automation / Claude-in-Chrome for verification.** Verify through the Django test
runner, Vitest unit and component tests, or direct API response checks — never by driving a browser.

**No real tests exist yet** — `inventory/tests.py` and `playground/tests.py` are both just the
Django-generated stub (`# Create your tests here.`). Don't assume test coverage for existing behavior.

**Settings are env-var driven** in `ims/settings.py`: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`,
`ALLOWED_HOSTS`, `DATABASE_URL`, `SENTRY_DSN`, and the `AWS_*` block (Cloudflare R2) all fall back to
local-dev defaults when unset. The local DB is Postgres (`inventory` on localhost:5432, user
`postgres`). `CORS_ALLOW_ALL_ORIGINS = True` is still on — dev-only, flag it rather than fixing it as a
drive-by change.

**This app is deployed** (Heroku, with WhiteNoise serving the built React app and R2 for media).
Deployment steps are not in scope for routine work — never run migrations, resets, or config changes
against production without explicit authorization.

## Architecture

Django apps under a single `ims` project, plus a React frontend:

- **`ims/`** — project config: `settings.py`, root `urls.py`, `storage.py`, wsgi/asgi.
- **`inventory/`** — the actual product: models, DRF serializers/views/filters, admin. This is where
  almost all work happens.
- **`accounts/`** — `Account` + `Membership`: who owns data, and subscription state. Added in the
  Phase 2 migration below.
- **`playground/`** — scratch/dev-only app (`say_hello` view rendering `hello.html`), not part of the
  real API surface. Don't extend it as if it were production code.
- **`frontend/`** — React + Vite + Tailwind SPA. Built to `frontend/dist/` and served by WhiteNoise
  via `ims/views.py::spa_index`, which is the catch-all route in `ims/urls.py`.

**`tenants/` (removed in Phase 2).** This app used to hold `django-tenants` schema-per-tenant routing.
If you see references to `TENANT_*` settings, `django_tenants`, `MULTITENANT_RELATIVE_MEDIA_ROOT`, or
`TenantS3Storage`, they are leftovers — the app is single-database and account-scoped now.

### Request flow

`inventory/urls.py` wires a DRF `DefaultRouter` (products, categories, purchases, orders, suppliers,
customers) plus a `NestedDefaultRouter` for `products/{id}/images/` (via `drf-nested-routers`), plus
three plain `APIView`s: `analytics/`, `orders/export/csv/`, `purchases/export/csv/`.

Auth is JWT (`djoser` + `rest_framework_simplejwt`), mounted at `/auth/`. The default permission
classes are `IsAuthenticated + HasActiveSubscription` (see `accounts/permissions.py`). Data access is
gated by two independent things, and both must hold:

1. **Account scoping** — `AccountScopedMixin` filters every viewset queryset to the requesting user's
   account, and write serializers narrow their relational fields to that same account. Scoping
   `get_queryset` alone protects reads only; without the serializer half, a user can POST a record
   referencing another account's row by id.
2. **Subscription** — `Account.has_active_subscription` is *computed* from status **and** `expires_at`.
   Never trust `subscription_status` alone: nothing flips `active` → `past_due` without a scheduled
   job, so the column goes stale and silently grants free service.

Platform superadmins (`is_superuser`) have no `Membership`, bypass both gates, and are the only users
who should ever have `is_staff`.

### Read/write serializer split

`Purchase`/`Order` each have two serializers (`PurchaseSerializer` vs `CreatePurchaseSerializer`,
`OrderSerializer` vs `CreateOrderSerializer`), selected in the viewset's `get_serializer_class()` based
on HTTP method. The `Create*` variants accept nested `items` and, inside `@transaction.atomic`
`create()`, both create the child `PurchaseItem`/`OrderItem` rows (via `bulk_create`) **and** mutate
`Product.stock_quantity`: purchases increment it, orders decrement it (`quantity * unit_multiplier`).
Any change to purchase/order creation needs to preserve this stock side-effect and its atomicity.

`total_price` on `Purchase`/`Order` is a Python `@property` (sums `items.all()` in memory) used by
serializers, but list views (`PurchaseViewSet`/`OrderViewSet`) instead `.annotate(annotated_total=...)`
via `Sum(F(...))` at the DB level so that `ordering_fields` can sort on it. Keep both in sync if the
pricing formula (`quantity * unit_price`, sometimes also `* unit_multiplier`) changes — it's
duplicated across models, serializers, admin CSV exports, and `AnalyticsView`/CSV export views in
`views.py`, not centralized in one place.

### Filtering/search/pagination

Standard DRF pattern repeated per viewset in `inventory/views.py`: `DjangoFilterBackend` (using
`FilterSet` subclasses in `inventory/filters.py`) + `SearchFilter` + `OrderingFilter`, with
`DefaultPagination` (`inventory/pagination.py`, page size 10) applied where set.

### Reporting/export endpoints

`AnalyticsView`, `ExportOrdersCSVView`, `ExportPurchasesCSVView` in `inventory/views.py` are all
admin-only (`IsAdminUser`) and support the same ad-hoc `?year=`/`?month=` (and for CSV exports,
`?date=`/`?order_id=`/`?purchase_id=`) query-param filtering, applied manually rather than through a
`FilterSet`. The Django admin (`inventory/admin.py`) has its own, separate CSV-export admin actions
(`export_orders_to_csv`/`export_purchases_to_csv`) and its own totals annotation — these are not shared
code with the API export views, so a formula/format fix usually needs to happen in both places.

### Media

`ProductImage` uses `ImageField(upload_to='inventory/images')` validated by
`inventory/validators.py::validate_file_size` (2MB cap). Served from `MEDIA_ROOT`/`media/` only when
`DEBUG=True` (see `ims/urls.py`).



## Frontend Development & Workflow Rules

**Git Workflow**: Create and switch to a new Git branch for all frontend development. Do not work directly on the main branch.
**Token Efficiency**: Maximize token efficiency and keep responses concise. When updating existing code, provide only the modified functions or search/replace blocks rather than rewriting entire files.

### Frontend Architecture & Design
- **Tech Stack**: React via Vite, Tailwind CSS, and modern functional components/hooks.
- **Apple/macOS Aesthetic**: The UI must look premium, modern, and native to macOS. Utilize glassmorphism (`backdrop-blur`), subtle drop shadows, clean rounded corners (`rounded-xl`), and minimalist typography (e.g., San Francisco or Inter).
- **Responsiveness**: The application must scale flawlessly across both mobile phones and laptop screens using Tailwind responsive breakpoints.
- **Animations & Dashboards**: Use libraries like `framer-motion` for smooth UI transitions and `recharts` (or similar) for interactive, animated statistics and diagrams on the main dashboard.

### Features & Boundaries
- **Required UI Tools**: Build a comprehensive dashboard, spreadsheet-like data views for inventory, printable invoices, and detailed views for orders, purchases, and products (ensuring product images are properly fetched and rendered).
- **Backend Boundaries**: You are encouraged to add useful frontend features and sorting logic, but **do not** alter the core transactional logic of the backend (e.g., how orders and purchases automatically adjust stock quantities).
- **Seed Data**: Before building the full UI, write a Python script or Django management command to populate the database with fake products, suppliers, customers, and transactions to facilitate UI/Chart testing.
- **No Deployment Yet**: Do NOT create Dockerfiles or prepare the application for publishing. Remain strictly in local development mode until explicitly authorized by the user.

---

# Active Plan — SaaS Migration & Feature Work

**Branch:** `feature/saas-single-db-migration` · **Started:** 2026-08-07
**Full design:** `docs/superpowers/specs/2026-08-07-saas-single-db-migration-design.md`
**Completed work log:** `HISTORY.md` — read it at session start.

**Status:** Phase 1 complete. Phase 2 next.

Phases are a dependency chain. 3–5 all touch models that Phase 2 restructures, so running them out of
order means writing migrations twice. Finish each phase (including its tests) before starting the next.

### Phase 1 — Order stock validation
Reject orders exceeding `Product.stock_quantity` with HTTP 400; disable the frontend add/increment
controls and show a limit badge at the cap.

Three things the obvious implementation gets wrong:
- Stock is deducted as `quantity * unit_multiplier`. Validating bare `quantity` lets an order pass and
  then drive stock negative.
- One order can list the same product on several lines — each under stock, together over. Sum requested
  units per product id before comparing.
- Two concurrent orders can both validate and both deduct. Re-read with `select_for_update()` inside
  the existing `@transaction.atomic` block and re-check before deducting.

### Phase 2 — Single DB, accounts, subscriptions
Remove `django-tenants`; introduce `Account` + `Membership`; scope all data per account; gate on
subscription status. Existing tenant data is **discarded** (approved) — clean-slate migrations, not
additive ones, because inventory tables live only inside tenant schemas today and the public schema has
none of them. Re-permission `AnalyticsView` and the CSV exports off `IsAdminUser`: under the new role
model `is_staff` means platform superadmin, so leaving them would either break every subscriber's
dashboard or hand every subscriber the platform. Drop the global `unique=True` on `Product`/`Supplier`/
`Category`/`Customer` `.name` for per-account uniqueness, or the first account to name a product blocks
every other account.

### Phase 3 — Expenses
`Expense` model + account-scoped CRUD. `net_profit = order profit − expenses`, with the *same* date
window applied to both sides — extract the window logic into one helper rather than duplicating it.
`created_at` uses `default=timezone.now`, not `auto_now_add`, so a receipt entered Friday for a Tuesday
purchase lands in the right month.

### Phase 4 — Barcodes
Optional indexed `Product.barcode`; add it to `ProductViewSet.search_fields` so `?search=` covers it.
Frontend input + list tag. Camera scanning is a later phase.

### Phase 5 — CSV export totals row
Append a TOTALS row to `ExportOrdersCSVView` (the API view the frontend calls — *not* the similarly
named `export_orders_to_csv` admin action, which has no cost/profit columns; that one gets a matching
row for its single Total Value column). The existing "Total Profit" column repeats the whole order's
profit on every line of that order, so summing that column multiplies each order's profit by its line
count. Sum per-line profit instead.

---

# Working Log — mistakes, gotchas, anti-patterns

Append here when something bites. Do not repeat these.

- **`CLAUDE.md` was badly stale** (2026-08-07): described MySQL, no frontend, no multi-tenancy, and a
  Pipfile missing `djoser`. All four were wrong. Verify this file against the code before trusting it,
  and update it when the architecture moves.
- **`product.stock` does not exist** — the field is `Product.stock_quantity`. Requests referring to
  `stock` mean this.
- **Two different order-CSV exporters exist** with near-identical names and different columns:
  `ExportOrdersCSVView` (`inventory/views.py`, API, what the frontend calls) and `export_orders_to_csv`
  (`inventory/admin.py`, admin action). A formula fix usually needs both.
- **DRF builds a separate `Product` instance per nested item**, so the `product.stock_quantity -= …;
  product.save()` loop in `CreateOrderSerializer`/`CreatePurchaseSerializer` writes stale copies when a
  product appears on two lines — the second save overwrites the first. Aggregate per product and use
  `F()` updates. (Fixed in Phase 1.)
- **`inventory/tests.py` is not a stub** — it holds a real suite (28 tests before Phase 1) using
  `TenantTestCase`/`TenantClient`, because `inventory` tables live only in tenant schemas. Phase 2 must
  migrate every one of these to plain `TestCase`/`APIClient`.
- **The frontend had no test runner** until Phase 1 added Vitest (`cd frontend && npm test`). Pure
  logic belongs in `frontend/src/lib/*.js` where it can be tested without React.
- **Node 22+ ships an experimental `localStorage` global** that resolves to undefined without
  `--localstorage-file` and shadows jsdom's. `frontend/src/test/setup.js` installs an in-memory
  implementation; without it every component test touching `CurrencyContext`, `ThemeContext`, or
  `lib/api`'s token store dies on `localStorage.getItem` of undefined.
- **`react-router-dom` has 2 open high-severity advisories** (`npm audit`). `npm audit fix --force`
  downgrades to 7.11.0, a breaking change — left alone deliberately; raise it as its own decision.