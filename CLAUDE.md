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

**Status:** Phases 1–2 complete. Phase 2.5 in progress.

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
  price id.
- **Discount keys are local, not Paddle coupons.** A gateway coupon still needs the checkout round
  trip, and the requirement is to bypass card checkout entirely. Local keys also record the cash sale
  where Phase 3's reporting can see it, and keep working if Paddle is down or unapproved. Redeem under
  `select_for_update()` or two concurrent posts share a single-use key.
- **v1 honours 100%-off keys only** — a partial discount needs a second gateway integration. The
  `percent_off` column exists so it is additive later.

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
- **`react-router-dom` has 2 open high-severity advisories** (`npm audit`). `npm audit fix --force`
  downgrades to 7.11.0, a breaking change — left alone deliberately; raise it as its own decision.