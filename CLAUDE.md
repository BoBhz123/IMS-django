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
python manage.py test inventory.tests    # single module
python manage.py seed_data               # demo account + fake data (--account/--owner)
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

**Tests live in `inventory/tests.py` (69) and `accounts/tests.py` (22)**, all plain
`TestCase`/`APIClient`. `playground/tests.py` is still the Django-generated stub. Coverage is real but
not total — it is strongest on stock arithmetic, account isolation, and subscription gating.

**Settings are env-var driven** in `ims/settings.py`: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`,
`ALLOWED_HOSTS`, `DATABASE_URL`, `SENTRY_DSN`, and the `AWS_*` block (Cloudflare R2) all fall back to
local-dev defaults when unset. The local DB is Postgres (`inventory` on localhost:5432, user
`postgres`). `CORS_ALLOW_ALL_ORIGINS` follows `DEBUG` since Phase 8, and `CORS_ALLOWED_ORIGINS` is
read from the environment (comma-separated) with the Vite dev origins as the fallback — so adding a
production domain is a config change, not a deploy.

`DJANGO_SECRET_KEY` and `DJANGO_DEBUG` still *default* to their unsafe values for local dev, but
**the app now refuses to boot when `DEBUG` is off and `SECRET_KEY` is still the committed default**
(F-06, closed 2026-08-10 once the owner confirmed the variable is set on Heroku). `SIMPLE_JWT` has no
separate `SIGNING_KEY`, so that key signs every token — a silent insecure boot meant anyone who could
read this repo could mint a token for any user.

Security headers live in `ims/security_headers.py` (CSP + Referrer-Policy), hand-rolled rather than
`django-csp` to avoid a lockfile relock. `CSP_REPORT_ONLY=1` rolls a policy change out without
blocking; `CSP_EXTRA_IMG_SRC` / `CSP_EXTRA_CONNECT_SRC` add origins without a code change.

**This app is deployed** (Heroku, with WhiteNoise serving the built React app and R2 for media).
Deployment steps are not in scope for routine work — never run migrations, resets, or config changes
against production without explicit authorization.

### ⚠️ Pre-deploy checklist — dev-only relaxations to revert

Things loosened deliberately for local development. Check each before a production deploy.

1. **`frontend/vite.config.js` → `server.allowedHosts`** is set to `['.trycloudflare.com',
   '.loca.lt']` so tunnel URLs can reach the dev server — the only way to test the camera barcode
   scanner, since `getUserMedia` needs a secure context and a phone on the LAN has none. Revert it
   to the default (remove the key) once phone testing is done.

   *This one cannot reach production by itself:* `server.*` configures the Vite dev server only,
   and `vite build` ignores it, so nothing in `dist/` is affected. The exposure is the local
   machine while a tunnel is actually running — treat the tunnel as public, because it is.
2. ~~**`CORS_ALLOW_ALL_ORIGINS = True`**~~ — fixed in Phase 8; it now follows `DEBUG`.
3. **`BILLING_PRICE_MONTHLY_USD` / `BILLING_PRICE_ONE_TIME_USD`** — the committed `15` / `299` are
   display-only placeholders, not agreed pricing. See the Phase 2.5 section.

## Architecture

Django apps under a single `ims` project, plus a React frontend:

- **`ims/`** — project config: `settings.py`, root `urls.py`, `storage.py`, wsgi/asgi.
- **`inventory/`** — the actual product: models, DRF serializers/views/filters, admin. This is where
  almost all work happens.
- **`accounts/`** — `Account` + `Membership`: who owns data, and subscription state. Also holds
  `permissions.py` (`HasActiveSubscription`), `mixins.py` (`AccountScopedMixin`), and the signup
  serializer that provisions an account.
- **`playground/`** — scratch/dev-only app (`say_hello` view rendering `hello.html`), not part of the
  real API surface. Don't extend it as if it were production code.
- **`frontend/`** — React + Vite + Tailwind SPA. Built to `frontend/dist/` and served by WhiteNoise
  via `ims/views.py::spa_index`, which is the catch-all route in `ims/urls.py`.

**There is no `tenants/` app.** It held `django-tenants` schema-per-tenant routing and was deleted in
Phase 2, along with the dependency itself. Any surviving mention of `TENANT_*` settings,
`django_tenants`, `MULTITENANT_RELATIVE_MEDIA_ROOT`, or `TenantS3Storage` is a stale comment, not live
code — the app is single-database and account-scoped.

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

`AnalyticsView`, `ExportOrdersCSVView`, `ExportPurchasesCSVView` in `inventory/views.py` run on the
default permissions (any subscriber, own account only — they scope by `get_account(request.user)`
manually, since they are `APIView`s and not viewsets, so `AccountScopedMixin` does not apply). They
support the same ad-hoc `?year=`/`?month=` (and for CSV exports,
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

**Status:** Phases 1–8 complete. One item from Phase 8 is deliberately open and needs an owner
decision — F-06, the `DJANGO_SECRET_KEY` boot guard; see the Settings note above and the findings
report.
**Phase 2.5b-2** remains blocked on Paddle merchant approval; see the PAUSE STATUS below.

Phases are a dependency chain. 3–5 all touch models that Phase 2 restructures, so running them out of
order means writing migrations twice. Finish each phase (including its tests) before starting the next.

### Phase 1 — Order stock validation — **done**
Reject orders exceeding `Product.stock_quantity` with HTTP 400; disable the frontend add/increment
controls and show a limit badge at the cap.

Three things the obvious implementation gets wrong:
- Stock is deducted as `quantity * unit_multiplier`. Validating bare `quantity` lets an order pass and
  then drive stock negative.
- One order can list the same product on several lines — each under stock, together over. Sum requested
  units per product id before comparing.
- Two concurrent orders can both validate and both deduct. Re-read with `select_for_update()` inside
  the existing `@transaction.atomic` block and re-check before deducting.

### Phase 2 — Single DB, accounts, subscriptions — **done**
Removed `django-tenants`; introduce `Account` + `Membership`; scope all data per account; gate on
subscription status. Existing tenant data is **discarded** (approved) — clean-slate migrations, not
additive ones, because inventory tables live only inside tenant schemas today and the public schema has
none of them. Re-permission `AnalyticsView` and the CSV exports off `IsAdminUser`: under the new role
model `is_staff` means platform superadmin, so leaving them would either break every subscriber's
dashboard or hand every subscriber the platform. Drop the global `unique=True` on `Product`/`Supplier`/
`Category`/`Customer` `.name` for per-account uniqueness, or the first account to name a product blocks
every other account.

### Phase 2.5 — Secure onboarding & payment gateway — **2.5a + 2.5b-1 done, 2.5b-2 blocked on Paddle approval**
**Design:** `docs/superpowers/specs/2026-08-08-secure-onboarding-payment-gateway-design.md`

Signup takes email + password + phone, emails a 6-digit code, and grants no access until either a
Paddle card payment (monthly subscription or one-time lifetime licence) or a 100%-off discount key is
redeemed. **This deletes Phase 2's 14-day trial** — a trial is a free bypass of the wall.

**Paddle, not Stripe.** Stripe does not onboard Lebanon-registered businesses and there is no foreign
entity. Paddle is a merchant of record, so no local acquiring relationship is needed. A provider
interface (`accounts/billing/`) fronts it, with a dummy implementation for tests and credential-free
local dev — the gateway is the one piece a third party can refuse (see the spec's Risks).

**💵 Card payments and subscriptions are USD-only. Non-negotiable.** Every card charge, plan price,
checkout session, and subscription renewal is denominated in USD and nothing else. Do not add a
currency parameter to any billing endpoint, do not pass LBP or a local amount to the gateway, and do
not convert an amount before charging it. `BILLING_PRICE_*_USD` are USD by name and by contract.

LBP exists in this app for exactly two things, neither of which touches billing:
1. the **frontend display toggle** (`CurrencyContext`, `DEFAULT_EXCHANGE_RATE = 89000`), which
   reformats USD figures for reading and never changes a stored value; and
2. **local cash bookkeeping** — `Purchase`/`Order`/`Expense` amounts are stored in USD with an
   `exchange_rate` recorded alongside for the informal dual-currency record-keeping this business
   does.

The rule to hold onto: the exchange rate is a *presentation and record-keeping* detail. The moment an
amount is on its way to a payment gateway it is USD, it came from a server-side configured price, and
it is never multiplied by anything.

Split for sequencing, and 2.5b split again once the Paddle dependency was isolated:

- **2.5a** identity + email verification (no third party but Resend) — **done**, see `HISTORY.md`.
- **2.5b-1** activation, the provider seam, discount keys, and the `/subscription` screen — **done**.
  Plan: `docs/superpowers/plans/2026-08-08-phase-2.5b1-billing-foundation-discount-keys.md`. None of
  it depends on Paddle, so a cash-only business is fully operational today.
- **2.5b-2** Paddle checkout, the signed webhook, and `ProcessedWebhookEvent` — **blocked**. Needs
  live credentials, and the design requires the "will Paddle accept a Lebanon-registered seller?"
  risk validated *before* this is built, not after. Sandbox access unblocks development either way.

Routes to `active` today: redeeming a discount key, or the `activate_accounts` Django admin action.

#### ⏸ PAUSE STATUS — where Phase 2.5b stopped and what resumes it

Read this before touching `accounts/billing/`. Work moved on to Phase 3 with 2.5b deliberately
half-finished; that is a pause, not an oversight, and not a bug to be fixed by improvising a gateway.

- **Completed:** Phase 2.5a (email OTP onboarding) and Phase 2.5b-1 (billing foundation and 100%-off
  discount keys). Both are recorded in `HISTORY.md`.
- **Paused at:** Phase 2.5b-2 — Paddle checkout, the signed webhook, `ProcessedWebhookEvent`
  idempotency, and Paddle.js in the SPA. None of it is written.
- **Reason for the pause:** awaiting Paddle merchant-account approval and sandbox/production
  credentials. The design also requires the "will Paddle accept a Lebanon-registered seller?" risk
  validated *before* 2.5b-2 is built rather than after, so this is a sequencing decision and not
  merely a missing password.
- **Current state:** the provider seam is live with `BILLING_PROVIDER='dummy'`. The dummy refuses card
  checkout (`503 card_checkout_unavailable`) instead of faking a payment, and `BILLING_PROVIDER='paddle'`
  raises `ImproperlyConfigured` on purpose until 2.5b-2 lands. Discount keys and the admin
  `activate_accounts` action are the only routes to `active`, and they are sufficient — a cash-only
  business is fully operational as things stand.
- **Environment setup before any production deploy:** set `BILLING_PRICE_MONTHLY_USD` and
  `BILLING_PRICE_ONE_TIME_USD`. The committed values (`15` and `299`) are display-only placeholders,
  not agreed pricing. They are what the plan cards render; the server never accepts an amount from
  the client, so these do not control what anyone is charged — but shipping them unset would quote
  invented prices to real customers.

**To resume:** get sandbox credentials, then build `accounts/billing/paddle.py` behind the existing
`BillingProvider` interface and add the webhook. `activate_account` already accepts `grace_days`, so
the renewal path is a new caller rather than a rewrite.

What the obvious implementation gets wrong:
- **"No account until paid" is not implementable.** You cannot charge a card or verify an email before
  a row exists to attach them to. The account is created immediately in `pending_verification` and is
  simply inert: `LIVE_STATUSES` narrows to `(ACTIVE,)`, so Phase 2's default `HasActiveSubscription`
  already locks every endpoint with no new checks.
- **The paywall will block the escape from the paywall.** Every endpoint needed to get *out* of
  pending state — subscription status, resend code, verify code, create checkout, redeem key — must
  declare `permission_classes = [IsAuthenticated]` explicitly to shed the default. Miss one and the
  account is unrecoverable without admin intervention.
- **A 6-digit code is 1,000,000 guesses.** Expiry alone does not protect it: cap wrong attempts at 5
  and kill the code, throttle resend (1/min, 5/hr), generate with `secrets`, compare with
  `compare_digest`. `django-axes` guards login only and does not cover these endpoints.
- **Only the webhook may grant access.** A post-checkout redirect parameter is forgeable; the browser
  polls status and never reports success. Verify Paddle's signature before parsing, and record
  `event_id` for idempotency — providers retry, and a double-activation double-extends `expires_at`.
- **Never accept an amount from the client.** It sends a plan *key*; the server maps it to a configured
  price id. It never sends a currency either — see the USD-only rule above; the only correct answer to
  "which currency?" at checkout is USD, so there is no parameter to get wrong.
- **Discount keys are local, not Paddle coupons.** A gateway coupon still needs the checkout round
  trip, and the requirement is to bypass card checkout entirely. Local keys also record the cash sale
  where Phase 3's reporting can see it, and keep working if Paddle is down or unapproved. Redeem under
  `select_for_update()` or two concurrent posts share a single-use key.
- **v1 honours 100%-off keys only** — a partial discount needs a second gateway integration. The
  `percent_off` column exists so it is additive later.

### Phase 3 — Expenses — **done**
**Design:** `docs/superpowers/specs/2026-08-08-expense-tracking-design.md` ·
**Plan:** `docs/superpowers/plans/2026-08-08-phase-3-expense-tracking.md` · see `HISTORY.md`

`Expense` model + account-scoped CRUD at `/inventory/expenses/`, an Expenses page in the SPA, and a
financial reporting model with one honest definition of profit: `total_revenue`, `total_cogs`,
`gross_profit`, `total_expenses`, `net_profit`, with `inventory_outlays` (formerly `total_costs`) kept
outside the P&L as cash flow. COGS is snapshotted onto `OrderItem.unit_cost_price` at sale time, and
the date window is one shared `inventory/reporting.py::DateWindow` applied to every reporting
queryset. `spent_at` uses `default=timezone.now`, not `auto_now_add`, so a receipt entered Friday for
a Tuesday purchase lands in the right month.

### Phase 6 — Dashboard profit series — **done**
The analytics `series` carries `total_cogs`, `gross_profit` and `net_profit` per period, and the
Gross profit / Net profit tiles draw sparklines from them. See `HISTORY.md`. Tile sparklines all use
the fixed last-7-days daily window by decision — making them follow the period selector would mean
restructuring Dashboard's two data-loading effects.

### Phase 7 — Camera barcode scanning — **done**
Plan: `PLAN.md` · see `HISTORY.md`. `@zxing/library` behind a dynamic import, one
`BarcodeScannerModal`, and three call sites (product form, order flow, purchase flow). Manual
verification on a physical phone is the owner's; automated coverage mocks the decoder, since browser
automation is forbidden here.

Scanned lookups resolve through `lookupByBarcode` (`frontend/src/hooks/useBarcodeLookup.js`), which
returns `found | ambiguous | not_found | error`. Since 2026-08-10 barcodes are unique per account, so
`ambiguous` should not occur; it is kept as the safe response to the database saying otherwise (a bulk
import, or the constraint dropped) rather than silently taking the first match. Order scans increment
through `maxQuantityFor` so Phase 1's stock cap still holds; purchase scans are uncapped, because a
purchase adds stock.

### Phase 8 — Security audit — **done**
Findings: `docs/superpowers/specs/2026-08-09-phase-8-security-audit-findings.md`. See `HISTORY.md`.

Fixed: an unscoped nested product-image route (**cross-account read and write** — the most serious
bug found in the project, and no scanner saw it; the isolation matrix did), CSV formula injection in
4 of the 5 exporters, CORS wide open outside `DEBUG`, and unthrottled CSV exports.

Open by design: **F-06**, the `SECRET_KEY`/`DEBUG` fail-open default. Needs confirmation that
`DJANGO_SECRET_KEY` is set on Heroku before a boot guard can be added safely.

### Phase 4 — Barcodes — **done**
Optional indexed `Product.barcode` in `ProductViewSet.search_fields`, so `?search=` covers it. Form
input, list tag, admin search, seeded data. See `HISTORY.md`. Camera scanning is still a later phase.

**Superseded (2026-08-10): barcodes are unique per account.** Phase 4 shipped the field indexed but
not unique, on the reasoning that a shop reuses one code across loose goods. Reversed at the owner's
direction — one code, one product. `UniqueConstraint(['account', 'barcode'])`, never global: an EAN
identifies a real-world product, so a global constraint would let the first account to record one
block every other account from recording the same item. See `HISTORY.md`.

The `'' → NULL` normalization in `Product.save()` is load-bearing for it — NULLs do not collide in a
unique index but two `''` rows do, so without it the second product entered with no barcode is
rejected. A duplicate is a 400 from `ProductSerializer.validate_barcode`, not an `IntegrityError`
500, for the same reason `AccountUniqueNameMixin` exists: `account` is not a serializer field, so DRF
generates no validator for the constraint.

### Phase 5 — CSV export totals row — **done**
All four transaction exports end in a TOTALS row — both API views and both admin actions. The
products catalogue export is deliberately excluded. See `HISTORY.md`.

`ExportOrdersCSVView` gained a `Line Profit (USD)` column, which is what the profit total sums.

**Superseded by the export redesign (same day):** the repeating `Total Profit (USD)` column was
initially kept for saved formulas, then removed outright at the owner's direction — BI tools summing
it was judged the larger risk. That redesign also made all money numeric, added `Barcode` and
`Total Units`, and moved dates to ISO 8601. See `HISTORY.md`.

---

# Working Log — mistakes, gotchas, anti-patterns

Append here when something bites. Do not repeat these.

- **`EmailVerification` rows are scoped by `purpose`.** Any new query against that table must filter
  on it, or a code issued for one flow becomes spendable in another and the two flows start expiring
  each other's outstanding codes and sharing one hourly send budget. `issue_code`/`verify_code` both
  take `purpose`; the default is `email_verification` only because that flow predates the field.
- **A multi-step OTP flow must not spread its decision across steps.** If the endpoint that changes
  something trusts an earlier "verify" call, being authenticated is enough to skip the code entirely
  and the extra screens are theatre. `PasswordResetConfirmView` takes the code and the new password in
  one request; `PasswordResetVerifyView` uses `consume=False` and grants nothing. Keep it that way.
- **Changing a password must blacklist outstanding refresh tokens.** The SPA holds JWTs, so Django's
  session invalidation does nothing here, and a refresh token issued before the change stays valid for
  30 days. `accounts/views.py::_revoke_refresh_tokens`.
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
- **Every test needs an `Account`** — models carry a non-null `account` FK, so a bare
  `Product.objects.create(name=…)` in a new test fails on the not-null constraint. Use
  `AccountFixtureMixin.make_account_user()` (top of `inventory/tests.py`), which returns the account,
  user, authenticated client, and JWT header together.
- **Tests that write files need an isolated `MEDIA_ROOT`** — `ExternalImageURLTests` saves a real image
  and, without the `override_settings(MEDIA_ROOT=tempdir)` in its `setUpClass`, drops it into the
  repo's tracked `media/` directory where it gets committed as a stray artifact.
- **Account scoping is two independent halves.** `AccountScopedMixin` on the viewset, *and*
  `AccountScopedSerializerMixin.account_scoped_fields` on every write serializer with a relational
  field. Adding a new FK to an inventory model without the second half lets a caller POST another
  account's row by id. The narrowing must stay in `get_fields()`, not `__init__` — nested serializers
  are constructed unbound with an empty context, twice, before any request exists.
- **`pipenv uninstall` relocks everything.** Removing `django-tenants` that way silently bumped Django
  6.0.8 → 6.1 and DRF 3.17 → 3.18 in `Pipfile.lock` (then failed anyway). To drop a package without a
  drive-by upgrade: delete it from the `Pipfile`, remove just its block from the lock, `pipenv verify`,
  then `pipenv run pip uninstall <pkg>`.
- **The frontend had no test runner** until Phase 1 added Vitest (`cd frontend && npm test`). Pure
  logic belongs in `frontend/src/lib/*.js` where it can be tested without React.
- **Node 22+ ships an experimental `localStorage` global** that resolves to undefined without
  `--localstorage-file` and shadows jsdom's. `frontend/src/test/setup.js` installs an in-memory
  implementation; without it every component test touching `CurrencyContext`, `ThemeContext`, or
  `lib/api`'s token store dies on `localStorage.getItem` of undefined.
- **A new `Account` defaults to `pending_verification`, not active.** Since Phase 2.5a `LIVE_STATUSES`
  is `(ACTIVE,)`, so any fixture that does `Account.objects.create(name=…)` without
  `subscription_status=Account.ACTIVE` produces an account that 403s every request — the test then
  fails somewhere far from the cause. `AccountFixtureMixin.make_account_user()` already passes it;
  `seed_data` forces it too, or the demo data would be unreachable.
- **`EmailVerification.created_at` is `default=timezone.now`, not `auto_now_add`** — deliberately, so
  the resend rate-limit tests can shift a row backwards in time instead of sleeping through a real
  60-second cooldown. `auto_now_add` is not writable and would make those tests impossible.
- **There is a unique index on `auth_user.email` that `makemigrations` cannot see.** It is raw SQL in
  `accounts/migrations/0004_auth_user_email_unique.py` (functional on `LOWER(email)`, partial on
  `email <> ''`), because Django cannot cleanly `AlterField` another app's model. `makemigrations`
  will never report it as missing and never recreate it — don't assume the constraint is absent
  because no model field declares it.
- **`activate_account` (`accounts/billing/activation.py`) is the only supported way to set
  `subscription_status = ACTIVE`** outside the admin action. Assigning the column directly skips the
  expiry arithmetic — the account reads as live with a stale or absent `expires_at`.
- **`BILLING_PROVIDER='paddle'` raises `ImproperlyConfigured` by design** until 2.5b-2. That is not a
  broken import; the error message names the phase.
- **Discount key codes are stored normalized** — uppercase, no dashes. Querying `DiscountKey` by the
  dash-separated form the user was shown never matches; run it through
  `accounts.billing.keys.normalize_key` first.
- **`OrderItem.unit_cost_price` is the only correct source of COGS.** `product.cost_price` is a
  *current* figure that gets corrected; reading it for any historical calculation restates the past.
  The snapshot is what `OrderItem.profit`, `LINE_COGS`/`items_cogs`, `AnalyticsView` and
  `ExportOrdersCSVView` all read.
- **`bulk_create` bypasses `OrderItem.save()`**, so any new bulk creation path must stamp
  `unit_cost_price` itself. `save()` only covers the row-at-a-time callers (admin inline, `seed_data`);
  `CreateOrderSerializer` stamps it explicitly from the products it has already locked.
- **`AnalyticsView` returns money as raw numbers, not `"$..."` strings**, and the summary key for
  purchases is `inventory_outlays` — but `series` rows still use `total_costs`. That difference is
  deliberate, not a bug: the tile sits next to `total_cogs` and the series does not.
- **Every reporting queryset must be filtered through `inventory/reporting.py::DateWindow`.** A window
  applied to one side of a profit calculation and not the other misstates it silently — no exception,
  no error, just a wrong number.
- **`fillSeriesGaps` (`frontend/src/lib/format.js`) drops any key it does not name.** Adding a field
  to the analytics `series` requires adding it there too, or the chart reads `undefined`, `Math.max`
  returns `NaN`, and the sparkline renders invisible with no error. The exact-match test on the
  filled row shape is the guard — extend it, never loosen it.
- **Series money keys and summary money keys differ on purpose.** `series` rows use `total_costs` for
  purchases; the summary uses `inventory_outlays`. Both are correct in place, and the series has no
  equivalent of the summary's `total_cogs` naming hazard.
- **Per-period revenue and COGS must be summed in one `annotate()`.** Both traverse the `items` join;
  two calls on the same queryset fan out and multiply each other's row counts.
- **CSV money is written bare — no `$`, no thousands separators — via `inventory/csv_format.py`.**
  A `$` makes a spreadsheet treat the column as text and refuse to sum it; a thousands comma inside
  an unquoted cell splits it in two and shifts every column after it. Both exporters and both admin
  actions import `money()`/`iso()` from there, so formatting cannot drift between the four.
- **The orders CSV has no per-order profit column.** It used to, and it repeated each order's whole
  profit on every one of its lines, so any tool summing it inflated profit by the line count (3.1x on
  the demo data). `Line Profit (USD)` is per-line and is what the TOTALS row sums. Don't reintroduce
  an order-level column into a line-level export.
- **CSV totals are accumulated in the row loop, never a second aggregate query.** `ExportOrdersCSVView`
  has a test pinning its query count constant as rows grow; a totals aggregate would break it.
- **`Quantity` is deliberately not totalled in the CSV footer** — summing it across lines with
  different `unit_multiplier`s is meaningless. `Total Units` (`quantity * unit_multiplier`) is the
  column that carries a real physical count, and it is the one totalled.
- **`Product.barcode` is normalized in `Product.save()`** — `''` becomes `NULL` and surrounding
  whitespace is stripped. Query by the stripped value; do not assume `''` is ever stored. This is
  load-bearing for the per-account unique constraint added on 2026-08-10: NULLs do not collide, two
  `''` rows do. Any new write path that skips `save()` (`bulk_create`, `update()`, raw SQL) must
  normalize for itself or it will either store `''` or trip the constraint.
- **A per-account unique constraint needs a serializer validator too.** `account` is stamped in
  `perform_create`, so DRF never sees it as a serializer field and generates no `UniqueTogether`
  validator — the constraint then surfaces as an uncaught `IntegrityError` 500 instead of a 400. See
  `AccountUniqueNameMixin` and `ProductSerializer.validate_barcode`. Both strip before comparing,
  because the model strips before storing.
- **The security audit trail is `accounts/audit.py`, logged to `ims.security`.** Deletions are
  hooked in `AccountScopedMixin.perform_destroy`, so any new account-scoped viewset is audited for
  free — but capture the pk *before* `super().perform_destroy()` and log *after* it: Django's
  collector nulls `instance.pk`, and logging first records deletions that a PROTECT foreign key then
  prevented. Never put a code, token or password in the trail.
- **CSP is enforced (`ims/security_headers.py`), so no inline `<script>` may ever be added** to the
  SPA's `index.html` or to a Django template — `script-src` is `'self'` with no nonce. Check
  `npm run build` output if a build tool starts inlining. `'unsafe-inline'` in `style-src` is
  load-bearing for framer-motion and cannot be removed without replacing the animation library.
- **JWTs live in `localStorage`, so any XSS is a full account takeover.** This is a recorded,
  accepted risk — `HttpOnly` cookies are the structural fix and a much larger change. Treat any new
  HTML-rendering or `dangerouslySetInnerHTML` path as security-critical.
- **`playground.views.say_hello` reads every account's orders with no auth and no scoping.** It is
  not routed, and `test_a05_the_playground_scratch_view_is_not_routed` is the tripwire. Do not
  `include('playground.urls')`.
- **Scanners do not find authorization bugs.** Phase 8's worst finding — an unscoped nested route
  allowing cross-account read *and* write — was invisible to semgrep, bandit and pip-audit, because
  it looks like ordinary ORM code. It took a test that crossed the tenant boundary. Run the matrix
  (`inventory.tests.TenantIsolationMatrixTests`), and add any new scoped collection to its
  `RESOURCES` list.
- **Overriding `get_queryset()` on a scoped viewset silently opts out of `AccountScopedMixin`.**
  Always chain through `super().get_queryset()`. `ProductImageViewSet` declared
  `account_lookup = 'product__account'` and never reached it for four phases, which made the viewset
  *look* scoped. A nested route also needs the parent checked in `perform_create` — queryset scoping
  governs reads only, and the parent id comes off the URL.
- **`csv_format.text()` escapes formula-leading cells; never apply it to `money()` output.** `-`
  leads a formula and also leads a negative line profit, so escaping money emits `'-6.00` and turns
  the numeric columns back into text — undoing the redesign that made them summable.
- **DRF caches throttle rates in a class attribute.** `override_settings(REST_FRAMEWORK=…)` does not
  change them: `SimpleRateThrottle.THROTTLE_RATES` is bound at import and `api_settings` rebuilds a
  different dict. Patch `ScopedRateThrottle.THROTTLE_RATES` in place instead.
- **`settings.DEBUG` is forced to `False` by the test runner**, *after* `ims/settings.py` has been
  imported. Anything derived from `DEBUG` at import time therefore cannot be asserted in-process —
  check it in a subprocess, or the test proves nothing about production.
- **`@zxing/library` must stay behind `await import()`.** A top-level import puts ~450 kB into every
  page load of a bundle already past Vite's size warning. Measured: the entry chunk grows ~5 kB and
  the library gets its own chunk. Check `npm run build` output after touching a scanner call site.
- **zxing fires the decode callback with `NotFoundException` on every frame without a barcode** —
  nearly all of them. Treating it as an error puts the modal in a permanent failure state one frame
  after opening. `BarcodeScannerModal` filters it by `name`.
- **One physical scan decodes across many frames.** `BarcodeScannerModal`'s `handledRef` is what
  stops a single barcode from incrementing an order line five times. Do not remove it when
  refactoring the callback.
- **Scanned lookups use `?barcode=` (exact), never `?search=`.** `?search=` is `icontains` over name,
  description *and* barcode, so it resolves to the wrong product with nothing on screen to reveal it
  — and the scan flows add order lines without confirming each one.
- **Camera scanning cannot be verified in this project** — browser automation is forbidden. Tests
  mock the `@zxing/library` module id (which is what the dynamic import resolves) and drive the
  decode callback by hand. `getUserMedia` also needs a secure context, so the LAN dev URL a phone
  uses is camera-less by platform rule, not by bug.
- **`beforeEach(() => mock.mockReset())` — the concise arrow is a trap.** `mockReset()` returns the
  mock, and Vitest treats a function returned from a hook as a *teardown callback*: it calls the mock
  after every test. With a rejecting implementation set, that surfaces as an unhandled rejection
  attributed to a test that is otherwise passing. Use braces.
- **`CurrencyInput` deliberately does not mirror `valueUsd` on every change.** It re-syncs only when
  the text does not already parse back to `valueUsd`, so a part-typed `6.` or `6.50` survives and an
  emptied field is not refilled with the `0` that emptying it reported. Widening that effect makes
  the field fight the user mid-keystroke; narrowing it back to mount-only reintroduces the bug where
  picking or scanning a product left the price showing `0` beside a correct total.
- **`ProductPicker` only learns a product's name by being clicked.** Any code path that sets a line's
  `product` id some other way must also pass `selectedName`, or the picker reads "Select product"
  while holding a real id.