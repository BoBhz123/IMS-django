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

**Tests live in `inventory/tests.py` and `accounts/tests.py`**, all plain `TestCase`/`APIClient`.
Coverage is real but not total — it is strongest on stock arithmetic, account isolation, subscription
gating, and the security controls added in Phase 8 and the OWASP pass.

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
- **`frontend/`** — React + Vite + Tailwind SPA. Built to `frontend/dist/` and served by WhiteNoise
  via `ims/views.py::spa_index`, which is the catch-all route in `ims/urls.py`.

### Local development in Docker (added 2026-08-24)

Optional — `pipenv shell` + host Postgres still works exactly as before. Five new files, and
**no existing file was modified**, which is what keeps the Heroku path provably untouched:
`Dockerfile`, `.dockerignore`, `docker-compose.yml`, `frontend/Dockerfile`, `frontend/.dockerignore`.

```bash
docker compose up --build -d
docker compose exec backend python manage.py migrate    # required once; nothing auto-migrates
docker compose exec backend python manage.py test
docker compose exec frontend npm test
docker compose down       # keeps the DB volume;  down -v destroys it
```

SPA on `localhost:5173`, API on `localhost:8000`, Postgres on `localhost:5433`.

Things that are the way they are for a reason:

- **The base image is `python:3.14-slim`, not 3.12.** `Pipfile`/`Pipfile.lock` pin
  `python_version = "3.14"` and `pipenv install --deploy` aborts on a mismatch — that check is the
  point of `--deploy`, and dropping it would also drop the lockfile hash verification.
- **`pipenv install --system`, never a venv.** Packages land in `/usr/local/lib/python3.14/`, outside
  `/app`. The `.:/app` bind mount would shadow a `/app/.venv` and the container would fail to import
  Django.
- **Postgres publishes `5433:5432`.** The host already runs Postgres on 5432; 5432:5432 will not bind.
- **`VITE_API_BASE_URL` is deliberately unset in compose.** `lib/api.js` derives the origin from
  `window.location` (see the rule above). Setting it to `http://backend:8000` breaks everything — that
  string is inlined into JS running in the *host's browser*, which cannot resolve a Compose DNS name.
- **The frontend image is `node:22-alpine`** to match `engines.node: 22.x` in the root `package.json`,
  which is the Node major Heroku's buildpack actually builds the shipped bundle with. Alpine is safe
  here only because `package-lock.json` carries the `*-linux-x64-musl` native binaries for rollup,
  `@tailwindcss/oxide`, lightningcss and oxlint — checked before choosing it.
- **`frontend/.dockerignore` is a second, separate file.** A `.dockerignore` applies only to its own
  build context, and the frontend's context is `./frontend`, so the root one is not consulted.
- **`.env` is excluded from the image and injected at runtime** via compose `env_file`. Baking it into
  a layer would publish the Brevo password, `PAYMENT_ENCRYPTION_KEY` and the Paddle credentials to
  anyone who pulls the image.
- **The container runs as root against a bind mount.** `PYTHONDONTWRITEBYTECODE=1` stops `__pycache__`
  from appearing root-owned in your working copy, but anything that *writes* source will —
  `makemigrations` and `npm run build` especially. Use
  `docker compose exec --user "$(id -u):$(id -g)" backend python manage.py makemigrations`, or
  `chown -R "$(id -u):$(id -g)"` the output afterwards from inside the container.
- **`pip install pip-audit` is a separate Dockerfile layer, not a Pipfile entry.** The OWASP A06
  test (`inventory/tests.py::OWASPControlTests`) shells out to it and calls `self.skipTest()` when
  it is absent — so without it the container reported `OK (skipped=1)` while the host reported the
  real failure. Adding it to the Pipfile instead would relock the graph and risk a drive-by
  upgrade of what Heroku installs, which is the one thing this setup must not do.
- **`dns_opt: [no-aaaa]` on the backend is load-bearing, not tidying.** Docker hands containers
  AAAA records for public names on this host but no IPv6 route, so pip-audit died with
  `[Errno 101] Network is unreachable` rather than falling back to IPv4. `no-aaaa` (glibc 2.36+)
  stops the resolver returning AAAA at all. Remove it and the A06 test breaks again.

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
- ~~**No Deployment Yet**~~: superseded twice. The app *is* deployed (Heroku, see above), and on
  2026-08-24 the owner explicitly authorized a Docker setup. See "Local development in Docker" below.
  Docker here is a **local dev environment only** — it is not the production build path and must
  never become one without a separate decision.

---

# Active Plan — SaaS Migration & Feature Work

**Branch:** `feature/saas-single-db-migration` · **Started:** 2026-08-07
**Full design:** `docs/superpowers/specs/2026-08-07-saas-single-db-migration-design.md`
**Completed work log:** `HISTORY.md` — read it at session start.

**Status:** Phases 1–8 complete. One item from Phase 8 is deliberately open and needs an owner
decision — F-06, the `DJANGO_SECRET_KEY` boot guard; see the Settings note above and the findings
report.
**Phase 2.5b-2/-3/-4** are done. What still needs a human is real Paddle credentials and the three
USD prices in the catalog — not code; see "what shipped, and what still needs a human" below.

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

### Phase 2.5 — Secure onboarding & payment gateway — **done (2.5a, 2.5b-1 … 2.5b-4)**
**Design:** `docs/superpowers/specs/2026-08-08-secure-onboarding-payment-gateway-design.md`

Signup takes email + password + phone, emails a 6-digit code, and starts a **cardless 14-day trial**
once that code is verified. After the trial, access needs a Paddle card payment, a 100%-off discount
key, or a manual admin activation.

**⚠️ The 14-day trial was deleted in 2.5a and reinstated in 2.5b-2 (2026-08-12), by explicit
decision.** 2.5a's reasoning — "a trial is a free bypass of the payment wall" — is still true; the
business chose cardless acquisition over a hard wall anyway. Do not "fix" this back. What keeps it
safe is that trial liveness is *computed* from `trial_ends_at`, never read off the status column, so
an elapsed trial locks itself out with no scheduled job running, and a `trialing` row with a null
`trial_ends_at` denies rather than grants.

**One tier, three billing choices.** `monthly`, `annual`, `one_time` — all granting identical access.
Nothing in the app branches on `plan_type` to decide what a customer may *do*, only on whether their
subscription is live. The moment a feature checks `plan_type`, this becomes a tiered product and the
whole permission story needs revisiting.

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
- **2.5b-2** Paddle checkout, the signed webhook, and `ProcessedWebhookEvent` — **done**, see below.
  Built against the sandbox; the "will Paddle accept a Lebanon-registered seller?" risk is still open
  but no longer blocks anything, because keys and Whish/cash work without a gateway.

Routes to `active` today: a Paddle payment (once credentials are real), redeeming a discount key, or
the Django admin's activate/extend/reset/revoke actions. New signups also get 14 cardless trial days.

#### Phase 2.5b-2 — what shipped, and what still needs a human

`accounts/billing/paddle.py` (checkout + signature verification), `accounts/billing/webhooks.py`
(`POST /billing/webhook/paddle/`, `ProcessedWebhookEvent` idempotency), the `paddle_*` columns, and
Paddle.js in the SPA are all in place. `BILLING_PROVIDER='paddle'` no longer raises.

**Still needs a human, before production:**
- **Real Paddle credentials.** Everything in `.env` is a placeholder. `PADDLE_API_KEY`,
  `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET` and the three `PADDLE_PRICE_*` ids all come from the
  sandbox dashboard. With placeholders the provider reports card checkout unavailable and the app
  falls back to keys and Whish/cash, which is the designed degradation, not a bug.
- **The three prices do not exist in the Paddle catalog yet.** They could not be created from here:
  the Paddle MCP connection is read-only (no `product.write`). Grant it at
  https://vendors.paddle.com/mcps, or create them by hand under Catalog → Products. All three must be
  **USD** — see the USD-only rule above.
- **The webhook destination.** Point it at `/billing/webhook/paddle/` and subscribe to
  `transaction.completed`, `subscription.activated`, `subscription.updated`, `subscription.canceled`,
  `subscription.paused`. Anything else is logged and acknowledged.
- **The seller-approval question is still open** ("will Paddle accept a Lebanon-registered seller?").
  The code no longer blocks on it, because discount keys and Whish/cash work regardless.

What the obvious implementation gets wrong:
- **"No account until paid" is not implementable.** You cannot charge a card or verify an email before
  a row exists to attach them to. The account is created immediately in `pending_verification` and is
  simply inert: `LIVE_STATUSES` is `(ACTIVE, TRIALING)` and a fresh account is neither, so Phase 2's
  default `HasActiveSubscription` already locks every endpoint with no new checks.
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

### Phase 9 — Admin lockdown, editable transactions, invoice redesign — **done (2026-08-13)**

Three unrelated pieces of work, done together.

**1. `/admin/` is superuser-only.** `ims/admin_site.py::SuperuserOnlyAdminSite` overrides
`has_permission` (`is_active and is_superuser`, dropping Django's `is_staff` test) and `login`
(an already-authenticated non-superuser is redirected to `/`, the SPA, instead of being shown a
login form for the session they are already in). Wired through `ims/apps.py::IMSAdminConfig`'s
`default_site` and the `INSTALLED_APPS` entry — *not* `'django.contrib.admin'` any more — because
that hook is read before `autodiscover()`, so every existing `admin.site.register` lands on the
restricted site with no edits.

This **reverses** the earlier "staff may still look a customer up" decision (`AccountAdmin`
deliberately not using `SuperuserOnlyAdmin`). A customer lookup is not worth a hole in a site that
also exposes every other account's business data. The per-model gates
(`SuperuserOnlyAdmin`, `get_actions`, `get_readonly_fields`) all stay — they are the layer
underneath, and `AdminPermissionBoundaryTests` now asks them directly rather than over HTTP,
because the site bounces staff before any view runs.

**2. Orders and purchases are editable.** `CreateOrderSerializer`/`CreatePurchaseSerializer` gained
`update()`, and both viewsets route `PUT`/`PATCH` to them — left on the read serializers an edit
returns 200 having silently discarded every line change, since their `items` is read-only. Names
keep the `Create*` prefix; they are the write serializers for all three verbs now.

Editing **replaces** the line items wholesale rather than diffing them: a line has no
client-visible id, so "the second line" is a position and positions do not survive a reorder.
Stock moves by the *net delta* under `select_for_update()` inside the existing `@transaction.atomic`
— lock the union of old and new products, validate, then apply `old − new` (orders) or `new − old`
(purchases). A `PATCH` without `items` leaves lines and stock untouched.

What the obvious implementation gets wrong:
- **An order's own units are already out of stock.** Comparing new lines against the bare
  `stock_quantity` rejects an order for units it is itself holding — an order that sold the last 10
  cannot even have its customer corrected. `_insufficient_stock_errors(credited_units=…)` credits
  them back first. The frontend has the same rule in `lib/transactionEdit.js`, or every line of such
  an order renders as "over stock" and the save button stays disabled.
- **A dropped product appears on only one side.** Iterating the new items alone never returns the
  stock of a line that was deleted. `_stock_deltas` works over the union.
- **Reducing a purchase can drive stock negative** — the goods may already be sold. Refused with a
  400, not clamped: clamping leaves the books saying goods were never received while the sale that
  consumed them stands.
- **An edit must not restate COGS.** A product already on the order keeps its
  `OrderItem.unit_cost_price` snapshot; only a genuinely new line takes today's `product.cost_price`.
  Re-reading it for every line would rewrite the profit of a past sale each time a supplier price is
  corrected.
- **Nothing is denormalised, so nothing needs recalculating.** Totals, profit and analytics are all
  computed from the rows — `total_price`, `total_profit`, `AnalyticsView`. There is no ledger,
  balance or metrics table to reverse. `OrderEditingTests.test_analytics_reflect_the_edited_order`
  pins that.

Out of scope, and absent from the data model: per-line or per-order **discounts**, and
**customer/supplier balances**. Neither exists as a field anywhere; adding either is its own
decision.

**3. Invoice redesign.** `Invoice.jsx` rebuilt to the reference layout: letterhead with the real
business name/phone/email (from `useSellerIdentity`, reading the account off `AuthContext` — no
logo, no seller address, neither is stored), a `BILL TO` block with the customer's name, location
and phone, a `# / ITEMS / UNIT / QTY / UNIT COST / TOTAL` table, subtotal and total with their LBP
conversions, a `PAID` badge, and a configurable tagline in `lib/invoiceConfig.js`.

~~`UNIT` is `unit_multiplier` and `QTY` is `quantity`, in separate columns~~ — **superseded
2026-08-24.** `unit_multiplier` was removed; the table has one `Qty` column carrying the
physical unit count. ~~The `PAID` badge is static~~ — also superseded: `Order`/`Purchase` now
carry `payment_status` and `paid_amount` (Phase A below).

The `@media print` block in `index.css` was reworked for mobile printing: `@page { size: auto;
margin: 0 }` (which is also the only lever CSS has over the browser's own URL/timestamp headers —
Chrome and Safari suppress them at zero margin, Firefox honours its own preference regardless), the
invoice sized `width: 100%; max-width: 800px` with its own `12mm` padding instead of a fixed
`210mm`, `html`/`body` forced white to kill the dark margin bars, and `table-layout: fixed` so no
column can be clipped off a narrow sheet.

### Domain migration — client.myimsapp.com → myimsapp.com — **done (2026-08-13)**

The canonical domain is **`myimsapp.com`**. `ims/settings.py` grew a `SITE_DOMAIN` /
`SITE_URL` pair that `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` and the `CORS_ALLOWED_ORIGINS`
fallback all derive from, so moving domain again is one edit (or one `SITE_DOMAIN` env var),
not a hunt through settings. Every default stays overridable from the environment.

Two changes of substance, beyond the string swap:

- **`ALLOWED_HOSTS` no longer falls back to `'*'`.** The wildcard accepted any Host header and
  gave up Django's Host-header protection entirely — a placeholder from before this app had a
  domain. The fallback is now `myimsapp.com,.myimsapp.com,localhost,127.0.0.1`, so a deploy
  that forgets the env var fails closed.
- **`CSRF_TRUSTED_ORIGINS` did not exist.** It has to name the site or the Django admin's
  login POST is rejected with "Origin checking failed" the moment a custom domain fronts the
  app — it only worked before because the admin was reached over the `*.herokuapp.com` host.

`.myimsapp.com` is a leading-dot entry: per Django's docs it matches the domain *and* every
subdomain, which is what keeps the existing `client.` and `testlab.` hosts serving.

**Production state after the cutover** (`ims-tenant-app`, config v46):
- Domains registered: `myimsapp.com` (ALIAS/ANAME → `curly-parrot-w6pzgej6b6zwtm2b66ynh1zp.herokudns.com`),
  `*.myimsapp.com` (CNAME → `darwinian-pheasant-5sravvq7x6t5lxt0dklt42l9.herokudns.com`), plus
  the pre-existing `client.` and `testlab.` hosts.
- `ALLOWED_HOSTS=myimsapp.com,.myimsapp.com` — **the `*.herokuapp.com` dyno hostname was
  deliberately dropped** at the owner's direction, having been warned. That URL no longer
  serves the app.
- `CSRF_TRUSTED_ORIGINS=https://myimsapp.com,https://*.myimsapp.com`.

**Still outstanding, and it is DNS, not code:** `myimsapp.com` has no A/CNAME record at all, so
the apex does not resolve. DNS is on Cloudflare, which supports CNAME flattening, so the
ALIAS/ANAME target above can be entered as a proxied CNAME at the root. Until that record
exists the site is reachable only at `client.myimsapp.com`.

**The frontend API base URL is deliberately not hardcoded to the domain.** `lib/api.js`
derives it from `window.location.origin`; baking in `https://myimsapp.com` breaks local dev
outright and, during a cutover, makes the copy of the app served from one host issue
credentialed calls to another. Same-origin derivation already *is* `https://myimsapp.com`
when the page came from there.

`DomainConfigurationTests` (`inventory/tests.py`) pins all of this, including a guard that
fails if the old subdomain reappears in `ims/`, `accounts/`, `inventory/` or `frontend/src/`.

### UX polish, payment controls, filter consolidation — **done (2026-08-24)**

**Design:** `docs/superpowers/specs/2026-08-24-ux-polish-payment-controls-filters-design.md` ·
**Plan:** `docs/superpowers/plans/2026-08-24-ux-polish-payment-controls-filters.md`

Seven pieces of frontend work plus one additive backend filter, grouped because they all land in
the same six files. What shipped:

- **`FilterPopover`** — one "Show filters" button per list page (Orders, Purchases, Products,
  Expenses) with an active-filter count and "Clear all". The primary action and the export button
  deliberately stay outside it; burying the thing the user came to do is not a tidier header.
- **Payment controls** on both transaction forms (`components/forms/PaymentSection.jsx`,
  `lib/payment.js`) and **payment badges** with the outstanding balance on both list pages.
- **Fluid product selection**: no seeded blank row, picker closes on select, quick-create works.
- **`?payment_status=`** on `OrderFilter`/`PurchaseFilter`. No model change, no migration.

Two defects were fixed behind the reported "modal freeze", and both are recorded in the Working
Log below: `ProductForm` crashing when quick-created without lookup props, and nested overlays
fighting over `document.body.style.overflow`.

**Requirement 3 (default price pre-fill) was already implemented** before this work started —
`applyScannedProduct` and `handleProductChange` in both forms already read `default_sell_price` /
`cost_price`. It was discharged by adding tests that pin it rather than by writing it twice.

Also fixed in passing: `Orders.jsx::openInvoice` built its invoice object without
`payment_status`/`paid_amount`/`remaining_amount` and then passed all three to `<Invoice>`, so
every invoice printed as unpaid with a zero balance regardless of what had been settled.

Out of scope by decision: per-line or per-order discounts, customer/supplier balances, and a
whole-SPA restyle (Dashboard, Settings, Subscription, Login and Signup are untouched).

### Dashboard cash & settlement figures — **done (2026-08-25)**

Payment status now reaches the dashboard, without moving the P&L. `AnalyticsView` grew five
summary keys and four series keys, and the SPA grew four tiles (Collected, Owed to you, Owed to
suppliers, Net cash flow).

**The books stay accrual, and that is the whole design decision.** Revenue is what was
invoiced; COGS is the `OrderItem.unit_cost_price` snapshot taken at the sale. Recognising
revenue on collection instead — the obvious reading of "revenue should reflect actual collected
funds" — pairs a part-collected order against its *whole* COGS and reports a loss on a sale that
was profitable, because the cost is per line and known immediately while the cash is per
transaction and arrives later. So cash became a second, parallel set of figures rather than a
redefinition of the first:

| Accrual (unchanged by payment) | Cash (moves with payment) |
| --- | --- |
| `total_revenue`, `total_cogs`, `gross_profit`, `total_expenses`, `net_profit` | `revenue_collected`, `revenue_outstanding`, `outlays_paid`, `outlays_outstanding`, `net_cash_flow` |

`inventory_outlays` keeps straddling neither: it is purchase spend, already outside the P&L.

`revenue_collected + revenue_outstanding == total_revenue`, exactly, in every window — pinned by
`assertBalances` in every `AnalyticsSettlementTests` case. That identity is the only reason the
tiles can be read as adding up, and it is what forces the per-row clamping described in the
Working Log below.

The arithmetic lives in `inventory/reporting.py` (`line_total_subquery`, `with_settlement`,
`settlement_totals`) beside `DateWindow`, for the same reason `DateWindow` is there: it has to be
identical across every queryset a report touches, and it is testable without a view.

**Not built, and it is the honest limit of this feature:** there is no payment ledger. `Order`
and `Purchase` carry a single `paid_amount`, not dated payment rows, so the series buckets cash
by the *transaction's* date — "collected against orders placed in this period", not "collected
during this period". Enough to see whether a period's sales are being paid for; not enough to
reconcile a bank statement. A real cash-flow statement needs a `Payment` model and is its own
decision.

### Refocus performance, live trial countdown, dashboard hierarchy — **done (2026-08-25)**

Three strands, done together because they all bear on what happens when somebody returns to a
tab this app has been sitting in for days.

**1. `CONN_MAX_AGE = 60` + `CONN_HEALTH_CHECKS`.** Django's default is 0 — a TCP connect, TLS
handshake and authentication before *every* request. The dashboard issues ten. See the Working
Log for the trap in how it must be set.

**2. The trial banner counts from `trial_ends_at`, live.** It read the server's
`trial_days_remaining`, which is a snapshot taken when the payload was fetched and then frozen
for as long as the tab stays open. `lib/billing.js::trialDaysRemaining` derives the count
instead, against a clock (`hooks/useDailyTick.js`) that reticks at local midnight and on tab
resume. `trial_days_remaining` remains the fallback for a payload without the timestamp.

Deliberately **not** derived from `date_joined + 14`, which was the other option on the table:
an admin can extend, reset or revoke a trial, so a join-date guess is wrong for exactly the
accounts somebody has intervened on, and wrong in the direction of promising days they do not
have.

**3. Visibility and aborts.** `lib/visibility.js` + `hooks/usePageVisible.js` are the single
place that touches `document.visibilityState`. VerifyEmail's per-second countdown parks while
hidden. Four list pages (Categories, Suppliers, Customers, Expenses) were still using a
`cancelled` flag, which suppresses the *response* while the request runs to completion; they
use `AbortController` now, like Orders/Purchases/Products already did.

**4. Leaked timers and listeners**, all of which fired `setState` into an unmounted tree:
`ExportButton`'s error revert, `ToastContainer`'s auto-dismiss (one per toast), `Invoice`'s
copy-confirmation revert and its `afterprint` title restore.

**5. Re-render cost.** `AuthContext`'s value was an object literal rebuilt every render, so any
state change re-rendered every consumer in the app; it is `useMemo` + `useCallback` now, matching
what `CurrencyContext` already did. `StatTile`, `Sparkline`, `RecentOrdersTable`,
`TopProductsChart` and `DashboardCarousel` are `React.memo`, and the dashboard's ~30 derived
figures — including the sparkline arrays, whose identity is what makes the memos work — are one
`useMemo`.

**6. Dashboard hierarchy.** The ten equal tiles became four hero KPIs (Total revenue with its
outstanding balance as a badge, Net profit with gross margin, Collected, Net cash flow) over two
`MetricGroup` widgets (Working capital; Cost & outlays), with the catalog count moved beside Top
products. Ten equally weighted tiles had no entry point — the figure a shopkeeper opens the app
for competed with the catalog size for attention.

### Currency switcher consolidated into one toggle — **done (2026-08-25)**

`components/ui/CurrencyToggle.jsx` is the single display-currency control, used by both the dock
(`placement="right"`) and the mobile window header (`placement="bottom"`). One press flips the
view currency; there is no menu.

A dropdown picker was built first and **removed the same day at the owner's direction**. Don't
reintroduce it: for a two-item list a menu costs two interactions where one will do. What the
dropdown was solving is kept — the button shows the currency **code** (`USD` / `LBP`) beside the
symbol, where it previously showed a bare `$` or `ل.ل`. A lone glyph is ambiguous in the one way
that matters: it reads equally as "you are in dollars" and "press for dollars", which are
opposite claims, and nothing else on screen settled it.

The accessible name carries what the visible label cannot — `Currency: US Dollar. Switch to
Lebanese Pound.` The previous label was only the action ("Show in LBP"), which reads as the
current mode to anyone who never sees the glyph.

`enableDualCurrency` off renders **nothing** rather than a disabled control: the account is
strictly single-currency then, so a switch is offering something that does not exist. That rule
now lives in the component, so the two surfaces cannot disagree about it.

The dock variant renders through `components/layout/DockButton.jsx`, which was lifted out of
`Dock.jsx` for it — `Dock` imports `CurrencyToggle`, so importing `DockButton` back from `Dock`
would be a cycle. Anything else that lands in the rail should come through it too, or the rail
ends up with controls that are visibly dock buttons and silently not. `DockButton` takes an
optional `ariaLabel` separate from `label`: the tooltip is read beside a control the user can
already see and carries the action alone, while the accessible name has to carry the current
state as well.

---

# Working Log — mistakes, gotchas, anti-patterns

Append here when something bites. Do not repeat these.

- **`unit_multiplier` no longer exists** (removed 2026-08-24). A line is `quantity * unit_price`,
  stock moves by `quantity`, profit is `(unit_price - unit_cost_price) * quantity`. Migration
  `inventory/0006` folded the old column into the quantity (`quantity := quantity * unit_multiplier`)
  rather than dropping it, because dropping it would have divided the line total, the stock movement
  and the profit of every multi-unit line by its multiplier — 41% of the development data (1,154 of
  2,840 line items) carried a multiplier of 6 or 12, and nothing would have raised an error.
  `UnitMultiplierFoldMigrationTests` pins that the fold is lossless. **The fold is one-way**: 36 could
  have been 3x12, 6x6 or 36x1, and the factorisation was not recorded.
- **`CONN_MAX_AGE` must be passed *into* `dj_database_url.config()`, not applied around it.**
  `config()` replaces `DATABASES['default']` wholesale and writes its own `CONN_MAX_AGE` of 0 —
  so setting it in the literal block above is discarded, and a later `.setdefault()` never fires
  because the key is present, just zero. Both failures are invisible locally (no `DATABASE_URL`,
  so the literal block survives) and take effect only on Heroku, which is the deployment that
  needed persistent connections in the first place.
  `PersistentDatabaseConnectionTests.test_the_setting_survives_a_database_url_deployment` is the
  guard and it caught exactly this on the first run.
- **A `cancelled` flag is not a cancellation.** `let cancelled = false` in an effect suppresses
  the *response handler*; the request still crosses the network, still occupies a connection and
  still costs the server a query. Every superseded keystroke in a debounced search ran to
  completion. Use `AbortController` and pass `signal` — and then treat `axios.isCancel(error)`
  as not-an-error, or an aborted request paints a failure over the load that replaced it.
- **`document.visibilityState` goes through `lib/visibility.js`, never a bare listener.**
  `subscribeVisibility` returns its own unsubscribe, so a call site that leaks is visibly wrong
  rather than silently wrong. Browsers throttle background timers, they do not stop them — and
  the throttling is what makes a resumed *counter* wrong, which is why anything gated on
  visibility must recompute from a deadline rather than resume decrementing.
- **A timer scheduled in an event handler can only be cancelled by an unmount effect.** The
  `setTimeout` in a click handler outlives the component by default: `ExportButton`,
  `ToastContainer` (one per toast) and `Invoice` all fired `setState` into unmounted trees.
  React 19 removed the warning that used to make this visible, so the only symptom is
  accumulating scheduled work — and, in the suite, timers from one file firing during the next.
  Hold the id in a ref and clear it from `useEffect(() => () => clearTimeout(ref.current), [])`.
- **`window.addEventListener('afterprint', …)` that removes itself on fire is still a leak.**
  Some embedded and mobile browsers never fire it, and the tab can be closed from the print
  preview. `Invoice` keeps the restore function in a ref and *runs* it on unmount — not merely
  detaches it — or the browser tab stays named after an invoice nobody has open.
- **A context provider's value must be `useMemo`d, and its actions `useCallback`ed.** An object
  literal in the JSX is a new identity every render, so every consumer in the tree re-renders
  whether or not anything changed. `AuthContext` sat at the root of the app doing this for
  eight phases. `CurrencyContext` already had it right — copy that shape.
- **`React.memo` on a component whose props are built inline does nothing.** The dashboard's
  sparkline arrays were `sparkline.map(...)` in the JSX, so every tile got a fresh array on every
  render and every memo missed. The arrays are built in the same `useMemo` as the figures now.
  Memoising a component without checking where its props come from is decoration.
- **The Vitest suite cannot catch a syntax error in a module every test mocks.** 476 tests
  passed against a `TopProductsChart` whose `memo()` wrapper closed on the wrong brace, because
  the only test importing it stubs it out (recharts needs a layout engine jsdom does not have).
  `npm run build` caught it. This is the concrete case behind the standing rule that the build
  is a required check and not a formality.
- **Never sum a transaction column and a line expression in one aggregate.** This is the mirror
  image of the "revenue and COGS must be summed in one `annotate()`" rule, and it bites in the
  opposite direction. `orders.aggregate(revenue=Sum(LINE_TOTAL), collected=Sum('paid_amount'))`
  fans out across the `items` join, so `paid_amount` — which lives on the *order* — is counted
  once per line: a three-line order paid $100 reports $300 collected. Revenue stays correct, so
  the only wrong number is the one with no second source to check it against, and the error
  scales with basket size. `reporting.line_total_subquery` reaches the line total by correlated
  subquery instead, so the outer query never joins `items`.
- **Collected is capped and outstanding is floored *per row*, never across the queryset.**
  `Sum(total) - Sum(paid)` looks equivalent and is not: one customer who rounded a cash payment
  up silently cancels out another customer's real debt, and the dashboard reports less owed than
  it is. `with_settlement` uses `Least`/`Greatest` per transaction, which also matches
  `PaymentTrackedTransaction.remaining_amount`'s own clamp. The cap on collected is what keeps
  `collected + outstanding == total_revenue` exact — an overpayment is a customer credit, not
  revenue.
- **The P&L must not move when a payment lands.** `AnalyticsSettlementTests.test_payment_status_does_not_change_profit`
  exists because "make revenue reflect what was actually collected" is a natural-sounding request
  that quietly breaks profit: COGS is snapshotted per line at the sale, so pairing it with
  partial cash reports a loss on a profitable order. Cash is a parallel set of keys, never a
  redefinition of the accrual ones. See the plan section above.
- **A transaction with no line items must total 0, not NULL.** The `Coalesce` around
  `line_total_subquery` is load-bearing — a NULL total propagates through `Least`/`Greatest` and
  turns the whole account's collected figure NULL, which the view then renders as `0.00` with no
  hint that anything was dropped. Reachable: `Order.objects.create()` with nothing added yet.
- **`payment_status` is derived, never assigned.** `paid_amount` is the source of truth and
  `_settle_payment` (`inventory/serializers.py`) recomputes the status from it — including on an edit
  that changed only the line items, because moving the total can turn a PAID transaction into a
  PARTIALLY_PAID one. Writing the status directly reintroduces exactly the stale-column bug
  `Account.subscription_status` already has. `payment_status` is accepted on the wire only as
  shorthand (`PAID` -> pay the full total, `UNPAID` -> pay nothing); `PARTIALLY_PAID` without an
  amount is a 400, because there is no defensible default for a partial settlement.
- **`_settle_payment` must run after `bulk_create`, never before.** The total is summed from the
  line rows, so calling it first sees a total of zero and marks every transaction PAID.
- **`remaining_amount` is a property, not a column**, matching `total_price`. It clamps at zero:
  overpayment (a rounded-up cash settlement, routine here) reads as a zero balance, because a
  negative remainder renders on the invoice as a refund the business does not owe.
- **`Account.primary_currency` / `enable_dual_currency` are DISPLAY ONLY.** Every stored amount is
  USD and stays USD; these choose how those USD figures are rendered. They live on their own endpoint
  (`/accounts/currency-settings/`) rather than in `subscription_payload`, whose field set is pinned by
  `SubscriptionPayloadContractTests`. `CurrencySettingsDoNotReachBillingTests` fails if anything under
  `accounts/billing/` ever reads them — every card charge is USD by contract.
- **There is exactly one unauthenticated endpoint: `PublicInvoiceView`** (`/inventory/public/invoice/<token>/`).
  Its entire access control is a 32-byte `secrets` token in the URL. `PublicInvoiceSerializer`
  lists its fields explicitly and omits `unit_cost_price`, `profit` and the internal order UUID —
  never swap it for `OrderSerializer` or an `exclude` list, or the next field added to the read
  serializer is published to every customer holding a link. The A05 guard allowlists it **by name**,
  and a second test asserts the allowlist has exactly one member.
- **Revoking a share destroys the token, it does not flag it.** `share_token` is nulled, so the
  capability is gone rather than merely marked. A `revoked` boolean would leave a working secret in
  the database one forgotten filter away from still opening the door.
- **Re-sharing an already-shared order returns the same token.** Minting a fresh one would silently
  cut off the customer who was sent the link yesterday.
- **Never call a setter from inside another setter's updater.** React treats an updater as a
  pure function and may call it more than once; StrictMode does so deliberately, and `main.jsx`
  wraps the whole app. `toggleCurrency` flipped the display currency from inside a `setSettings`
  updater purely to read `enableDualCurrency` from it — so every press ran the flip twice,
  USD -> LBP -> USD, and the currency never changed. The button was visible, the handler fired,
  and nothing happened. Read the value through the `useCallback` dependency array instead.
- **A component test that does not render under `StrictMode` cannot see this class of bug**, and
  `@testing-library/react`'s `render` does not add it. That is how a toggle that did nothing in
  the real app kept a green suite across several passes. `CurrencyContext.test.jsx` has a
  `describe('under StrictMode')` block for exactly this; put stateful-context regressions there.
- **`useOverlayLayer` does two separable jobs, and popovers want only one.** Escape ordering is
  wanted by every overlay; freezing the page behind it is wanted only by the ones that cover it.
  The refcounted scroll lock was added unconditionally, so `FilterPopover` inherited a body lock
  its own doc comment said it must not have — opening a filter panel silently froze the table
  the user opened it to filter. Pass `{ lockScroll: false }` for anchored chrome. The release
  must be gated on the same flag: a layer that never acquired must not release, or closing a
  popover opened over a modal hands scrolling back while the modal still covers the page.
- **A `role="option"` and its click handler must be on the same element.** Putting the role on
  the `<li>` and the handler on a `<button>` inside it produces a control that does nothing when
  the option is activated — a click on a parent never reaches a child. Same for `menuitem`,
  `tab`, and anything else a test or a screen reader activates by role.
- **Escape closes the topmost overlay only** (`lib/overlayStack.js` + `hooks/useOverlayLayer.js`).
  Modal and SlideOver each bind their own document listener; before the stack existed, one Escape
  inside a quick-create modal also closed the order form underneath it and discarded every entered
  line item. Any new overlay primitive must go through `useOverlayLayer` or it reintroduces that —
  `FilterPopover` does, which is why it is safe to open one over a slide-over.
- **Body-scroll locking is a refcount in `overlayStack`, not a line in each overlay** (2026-08-24).
  Modal and SlideOver each used to set `document.body.style.overflow = 'hidden'` and blank it on
  close, independently. With the order form → picker → quick-create stack the app actually
  produces, closing the *inner* overlay handed page scrolling back while two were still open; the
  reverse unmount order left the page locked with nothing on screen to explain it. `acquire`/
  `releaseScrollLock` save and restore the page's own value rather than assuming `''`, and
  `resetOverlayStack()` zeroes the count — without that a test that unmounts untidily leaves every
  later test in the file running against a locked body.
- **A component that spreads a list prop must be given the list, or fetch it.** `ProductForm`
  spreads `categories`, and the order/purchase forms rendered it as a quick-create with no
  `categories` and no `suppliers` — spreading `undefined` threw, React unmounted the tree, and the
  user saw a backdrop with nothing on it. That is the "modal freeze" that was reported. Defaulting
  to `[]` is *not* the fix: the category select is `required`, so an empty list is a form that can
  never be submitted. `hooks/useProductLookups.js` fetches both when the props are absent.
- **Quick-create forms return the created record**: `onSaved(created)` on Customer/Supplier/
  Category/ProductForm. That is what lets the order and purchase forms select the new row without a
  refetch. Existing callers ignore the argument, so it stayed backward compatible.
- **Adding a line goes through `applyScannedProduct` in both forms**, whether it came from the
  product picker or a barcode scan. One path means the stock cap and the increment-don't-duplicate
  rule cannot drift between the two entry points. The old "Add row then choose" flow and its
  `addItem` helper are gone — duplicate lines can no longer be created from the UI, though the
  server and `lib/stock.js` still aggregate them because older orders have them.
- **`ProductSearchModal` takes `disableOutOfStock`**: true for orders (cannot sell what is absent),
  false for purchases (a zero-stock product is exactly the one being restocked).
- **The picker closes on select, and there is no seeded blank line** (owner's decision,
  2026-08-24). This *reverses* the earlier "stays open so three items is three taps" optimisation.
  Closing is the caller's job — both call sites do it — so the modal itself assumes neither
  behaviour. `applyScannedProduct` keeps its "reuse the first blank line" branch even though the UI
  no longer creates one: editing a saved transaction can still hydrate a blank, and dropping the
  branch would append a duplicate line beside it.
- **`payment_status` filtering is safe; `payment_status` *branching* is not.** `?payment_status=`
  exists on `OrderFilter`/`PurchaseFilter` because `_settle_payment` re-derives the column on every
  write, so unlike `Account.subscription_status` it cannot go stale. That is a statement about this
  column only — the rule that `paid_amount` decides and the status is derived still holds.
- **The payment controls send a status, and only sometimes an amount.** `lib/payment.js`:
  `PAID`/`UNPAID` go over the wire as `payment_status` alone so the server settles them against the
  total it computed from the rows it just wrote — a browser-side `paid_amount` would let a stale
  form total overwrite the real one. `PARTIALLY_PAID` must carry `paid_amount`; the server 400s
  without it, and the submit button is disabled on the same condition so the message lands beside
  the field instead of after a round trip.
- **`SegmentedControl`'s pill `layoutId` is per instance.** It was the constant `'segmented-pill'`,
  and framer-motion treats one layoutId as one element *moving* — with two controls mounted the
  pill flew across the screen between them. Reachable on the dashboard already; adding the payment
  selector would have put a third on top.
- **A trigger with a count badge needs an explicit `aria-label`.** The default name computation
  concatenates with no separator, so `FilterPopover`'s button announced "Show filters2". It sets
  `aria-label={...(N active)}` and marks the visual badge `aria-hidden`.
- **List pages render every row twice** — a table (`hidden sm:block`) and cards (`sm:hidden`).
  jsdom has no viewport to resolve the breakpoint, so both are in the DOM and every row assertion
  in `Orders.test.jsx`/`Purchases.test.jsx` has to use a `*All` query. A `getByText` on a row value
  fails with "found multiple elements", which looks like a duplicate-render bug and is not one.
- **`AppShell`'s window card must never be `overflow-hidden`.** Every page renders inside
  `<div className="mx-auto max-w-6xl ...">`, so a clipping context there slices anything a page
  floats outside its own flow — it cut the filter popover off at the card's bottom border
  whenever the table underneath was shorter than the open panel. Border-radius already clips the
  card's own background and border, and nothing inside paints a background of its own, so
  overflow-hidden bought nothing there. The AppShell root is `overflow-x-hidden` for the same
  reason: the ambient blobs are wider than the viewport and must not scroll, but the vertical
  axis has to stay open. `AppShell.test.jsx` guards both.
- **The table cards' `overflow-hidden` is NOT the popover bug and must stay.** `GlassCard >
  div.overflow-x-auto > table` is the correct arrangement on all five list pages: the card clips
  row hover backgrounds to its rounded corners, the inner div is what scrolls a wide table. Those
  cards are *siblings* of the page header, never ancestors of the popover, so removing their
  clipping fixes nothing and lets rows paint over the card's corners.
- **jsdom implements no layout, so a clipping bug cannot be caught by rendering.**
  `getBoundingClientRect` returns zeroes and nothing is ever painted or clipped; a test that
  rendered the shell and asserted "the popover is visible" passes just as happily with the bug
  present. `AppShell.test.jsx` asserts the structural invariant against the source instead, the
  same way `DomainConfigurationTests` greps the tree. Browser automation is forbidden here, so
  the visual check across viewports is the owner's.
- **`border-hairline-strong` is not a token.** `index.css` defines `--hairline` only, so that class
  emitted no border colour at all. Check `index.css` before inventing a variant name.
- **`CurrencyProvider` is mounted INSIDE `AuthProvider`** (changed 2026-08-24). The settings belong to
  the signed-in account, so the provider has to know when that changes. It reads `AuthContext` through
  `useContext`, not `useAuth()`, so a component test that renders a consumer without an auth provider
  gets the USD defaults instead of an exception.
- **`formatSecondary()` returns `null` when dual display is off**, and every caller renders the
  conversion line only if it returns a string. That is what makes "hide every secondary total" one
  rule instead of a flag re-checked in fifteen components. Don't reintroduce `enableDualCurrency &&`
  at call sites.
- **`showExchangeRate` is not `enableDualCurrency`.** With dual off *and* USD primary the rate is
  noise and the field hides. With **LBP primary** it stays visible even with dual off, because the
  rate is what turns every stored USD figure into the number on screen — hiding it would remove the
  user's control over all of them. The stored `exchange_rate` column is written either way.
- **`formatLBP` rounds before formatting, not just on display.** LBP has no circulating subunit, so
  a fractional figure reads as a mistake; rounding first keeps the rendered string and the number a
  reader would add up in agreement. `compact` keeps one decimal on purpose — "1.5M LBP" is a
  magnitude for a chart axis, not a pound amount.
- **CSV exporters build their TOTALS row by column name, never by counting blanks.** The rate column
  now appears or disappears per account (`enable_dual_currency`), so a hand-counted run of `''` puts
  every figure under the wrong heading. `SingleCurrencyExportTests` pins the alignment both ways.
- **The `Invoice` component takes `primaryCurrency` / `showSecondaryCurrency` as props, not context.**
  It is a printable document and stays context-free so it can render from a print view or a future
  PDF path without a provider. `Orders`/`Purchases` pass the account's real settings.
- **A migration test must name every app in its target list.** `UnitMultiplierFoldMigrationTests`
  first named only `inventory`, which left `accounts` at a state whose historical `Account` model had
  no `paddle_customer_id` while the real table still had it NOT NULL — the insert then failed on a
  column the test never mentions.
- **Don't run two `manage.py test` invocations against the same container at once.** The second finds
  `test_inventory` already present, prompts to delete it, and dies on `EOFError` under
  `docker compose exec -T`. Pass `--noinput` and serialise the runs.

- **`EmailVerification` rows are scoped by `purpose`.** Any new query against that table must filter
  on it, or a code issued for one flow becomes spendable in another and the two flows start expiring
  each other's outstanding codes and sharing one hourly send budget. `issue_code`/`verify_code` both
  take `purpose`; the default is `email_verification` only because that flow predates the field.
- **There has never been a hardcoded `123456` fallback.** `verification.generate_code` uses
  `secrets.randbelow`; every `123456` in the tree is test data. If a report says otherwise,
  check `RegistrationSessionEndpointTests.test_the_emailed_code_is_generated_not_fixed`
  before changing anything — it signs up five times and fails if two codes ever match.
- **Two clocks, and they are not the same clock.** `verification.CODE_TTL` (10 min) expires a
  *code* and is recoverable by resending. `registration.REGISTRATION_SESSION_TTL` (60 min)
  expires the whole unverified *sign-up* and hard-deletes it. Collapsing them throws away a
  registration over a ten-minute-old email; the endpoints return `code_expired` and
  `registration_expired` respectively, and the SPA branches on the slug, never the wording.
- **`Account.registration_expires_at` is what makes deleting an account safe, and it must
  stay a stored column.** Deriving the deadline from `created_at` would sweep any paying
  customer an admin has put back to `pending_verification`. It is stamped once at signup and
  cleared for good at the first verification, so NULL means "verified at least once" and
  `is_pending_registration` requires both halves. `registration.discard` raises
  `NotDiscardable` for anything else — never bypass it to delete an account.
- **Discarding a registration frees the email address, so the abandon endpoint is throttled
  per client address, not per user.** Sign-up → code → abandon → sign-up mails one victim
  repeatedly, and each pass creates a new user row with a fresh per-user budget, so a
  user-keyed throttle counts nothing. Any new endpoint that can delete an unverified account
  needs the same treatment.
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
- **`BILLING_PROVIDER='paddle'` works now** (2.5b-2). With placeholder credentials it reports card
  checkout unavailable rather than erroring — `is_configured()` is what the plan screen asks, not
  `name != 'dummy'`, because a half-credentialed provider takes payments exactly as well as no
  provider at all.
- **The Paddle webhook signs the *raw* body.** Use `request.body`, never `request.data` — DRF's
  parsed dict re-serialises with different key order and whitespace, and the HMAC stops matching.
- **Idempotency is an insert, not a check-then-insert.** `ProcessedWebhookEvent.objects.create()`
  inside `try/except IntegrityError` is what makes two concurrent deliveries of the same Paddle retry
  safe; `if not exists(): create()` lets both through and double-extends `expires_at`.
- **A `trialing` account whose `trial_ends_at` has passed still reads `trialing` in the database.**
  Nothing sweeps the column on a schedule (the admin action is housekeeping, not enforcement), so any
  code branching on the bare status is wrong — ask `has_active_subscription`. This bit the frontend
  router: `routeForAccountStatus` needs the account object, not just the status string.
- **Don't nest a `<button>` inside a `role="button"` card.** The Subscription plan cards did this;
  the accessible name of the outer control swallowed the inner button's text, so
  `getAllByRole('button', {name: /pay with card/i})` matched six elements instead of three. The cards
  are radio inputs now, which is both valid ARIA and free arrow-key navigation.
- **Discount key codes are stored normalized** — uppercase, no dashes. Querying `DiscountKey` by the
  dash-separated form the user was shown never matches; run it through
  `accounts.billing.keys.normalize_key` first.
- **The Paddle MCP connection is read-only.** It has no `product.write`, so prices cannot be created
  from a session — `client.products.create` fails with "not authorized". Grant the permission at
  https://vendors.paddle.com/mcps or use the dashboard.
- **`ModelAdmin.actions` resolves strings against the admin class only.** Listing module-level
  action functions by name registers nothing and every action silently disappears from the
  dropdown — pass the callables. `get_actions` gates by *name*, so derive those off `__name__`
  rather than retyping them.
- **Superuser-only admin needs `has_module_permission` too**, not just the four object
  permissions. Without it the section still renders on the admin index and only the links 403,
  which looks like a bug rather than a boundary. `SuperuserOnlyAdmin` in `accounts/admin.py`
  overrides all five; `AccountAdmin` deliberately does not use it (staff may look a customer
  up; only superusers may change what they paid for, via `get_actions`/`get_readonly_fields`).
- **The unpaid route whitelist is `/subscription` + `/settings`**, and it must not apply to
  `pending_verification` — an unverified account has not proved it owns the address, which is a
  worse hole than an unpaid one. Match exact paths and nested children, never bare
  `startsWith`, or `/settings-export` walks through.
- **The subscription wire names are `subscription_status` / `subscription_live` / `is_trial`**,
  not the model's `has_active_subscription` / `is_trialing`. One projection —
  `accounts.serializers.subscription_payload` — feeds both `/accounts/subscription/` and the
  `subscription` key of `/auth/users/me/`; `SubscriptionPayloadContractTests` pins the field set.
- **`force_authenticate` reuses one `User` instance**, and Django caches `user.membership` and
  that membership's `account` on it. A test that reuses the client after changing the account
  in the database reads the stale in-memory row and looks like a caching bug in the API. Build a
  fresh client from `User.objects.get(pk=…)` per request, as `AdminOverrideSyncTests` does.
- **One trial per account, latched on `Account.has_used_trial`.** `start_trial` raises
  `TrialAlreadyUsed`; only the admin reset action may pass `force=True`. Do not use a null
  `trial_ends_at` as the signal — the revoke action clears it, which would hand a revoked
  account a fresh trial.
- **`UserPaymentRecord` must never hold a card number.** Paddle is merchant of record and this
  app is deliberately outside PCI scope. It stores cash/Whish detail, Fernet-encrypted via
  `accounts/crypto.py`. `PAYMENT_ENCRYPTION_KEY` is required when `DEBUG` is off and is
  effectively write-once: rotating it makes every existing record unreadable.
- **`525 5.7.1 Unauthorized IP address` from Brevo is not a credential problem.** It is
  Brevo's "Authorised IPs" allowlist rejecting the sending host. Rotating the SMTP key does
  nothing. `manage.py send_test_email <addr> --show-config` reproduces it and prints the hint.
- **Transactional mail is `multipart/alternative`, always.** `accounts/emails.py` renders
  `emails/otp_code.html` *and* `.txt`; dropping the text part is a well-known spam signal.
  Templates are table-based with inline styles because Outlook renders through Word.
- **`DEFAULT_FROM_EMAIL` is composed in settings** into `IMS Support <addr>` and skips wrapping
  when the env value already has a display name. Double-wrapping produces a header Brevo
  rejects.
- **Brevo needs a verified sender.** `DEFAULT_FROM_EMAIL` on a free-mail domain (gmail.com)
  cannot be DKIM-signed by us, so it is spam-filed or refused even once the IP is allowed.
- **Boolean env vars need `_env_flag`, not `== 'True'`.** That comparison read
  `EMAIL_USE_TLS=true` as False, attempted port 587 in the clear, and silently broke every
  verification email. Any new boolean setting goes through the helper.
- **This app has no `/api/` prefix.** The billing/onboarding endpoints are `/accounts/…`,
  `/billing/…` and `/auth/…`. Requests naming `/api/accounts/redeem-code/` mean
  `/billing/redeem-key/`.
- **`react-router-dom` has 2 open high-severity advisories** (`npm audit`). `npm audit fix --force`
  downgrades to 7.11.0, a breaking change — left alone deliberately; raise it as its own decision.
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
  filled row shape is the guard — extend it, never loosen it. It has a backend twin,
  `AnalyticsSeriesProfitTests.test_every_period_row_has_every_key`, which asserts the row's key
  set exactly; a new series field means editing both, and both were written to fail rather than
  shrug.
- **The series period list is a union over every source queryset.** `_build_series` unions the
  order, purchase, expense *and* both cash groupings. Leave one out and a period whose only
  activity was of that kind vanishes from the chart entirely — a month spent paying down supplier
  invoices simply does not appear.
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
- ~~**`Quantity` is deliberately not totalled in the CSV footer**~~ — **superseded 2026-08-24.**
  `unit_multiplier` is gone, so `Quantity` *is* the physical unit count and is the column
  totalled. `Unit Multiplier` and `Total Units` were both removed from all four exporters.
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
- **There is no scratch app.** `playground/` was deleted on 2026-08-10: its `say_hello` view read
  every account's orders with no auth and no scoping, and although it was never routed it sat one
  line of `urls.py` away from being a cross-tenant leak.
  `test_a05_every_routed_inventory_view_requires_authentication` is the generalised guard that
  replaced it — it fails if any view routed under `/inventory/` does not demand an authenticated
  caller. Don't add a scratch app back; use a test or the shell.
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
- **`ALLOWED_HOSTS` on Heroku no longer lists the `*.herokuapp.com` dyno hostname.** Dropped
  during the 2026-08-13 domain cutover at the owner's direction. Requests arriving on that
  URL no longer serve the app, so it is not a fallback and not a way to check whether a
  deploy is healthy — use `client.myimsapp.com` (or the apex, once its DNS record exists).
- **`.myimsapp.com` with the leading dot already matches the bare domain.** Django's docs are
  explicit: a leading-dot entry matches the domain and every subdomain. Listing both is for
  the human reading settings.py, not because either is redundant to add.
- **Never hardcode the API base URL in `frontend/src/lib/api.js`.** It derives from
  `window.location.origin` on purpose — the same bundle is served from the apex, every
  subdomain, and a LAN/tunnel URL in dev. A baked-in origin breaks local development and,
  mid-cutover, makes one host's copy of the app call another host with credentials.
- **The Django admin is superuser-only, and the check is at the AdminSite.**
  `ims/admin_site.py` overrides `has_permission`; `INSTALLED_APPS` names
  `ims.apps.IMSAdminConfig`, not `django.contrib.admin`. Reverting that one line lets every
  `is_staff` user back into every account's data, and no per-model test would fail — which is
  why `SuperuserOnlyAdminSiteTests` asserts `admin.site`'s class directly.
- **`Create*Serializer` handles PUT and PATCH too, not just POST.** Routing an edit to
  `OrderSerializer`/`PurchaseSerializer` instead returns 200 having changed nothing but the
  exchange rate — their `items` and party fields are read-only representations. A silent
  discard, not an error.
- **An edit's stock check must credit back the transaction's own units.** The rows are already
  deducted, so `new_units > stock_quantity` rejects an order for stock it is itself holding.
  Server: `_insufficient_stock_errors(credited_units=…)`. Browser:
  `lib/transactionEdit.js::availableStock`. Both, or the two disagree and the form blocks a save
  the API would have accepted.
- **Stock deltas on an edit are computed over the *union* of old and new products.** A product
  removed from the transaction appears in neither the new items nor any loop over them, so its
  stock never comes back. `_stock_deltas` in `inventory/serializers.py`.
- **Editing must not re-read `product.cost_price` for a line that was already there.**
  `OrderItem.unit_cost_price` is a snapshot of what the sale cost at the time; re-stamping it
  restates the profit of a past sale whenever a cost is corrected. Only genuinely new lines take
  today's cost.
- **`PurchaseItem.product` is a product *name* on the wire, `OrderItem.product` is an id.**
  PurchaseItemSerializer declares it as a StringRelatedField. Any code turning saved items back
  into form state has to know which — `toFormLines(..., {productKey})` does.
- **Print rules hang off `.invoice-print` in `index.css`, and `@page { margin: 0 }` is
  load-bearing.** It is the only CSS lever over the browser's own print headers/footers, and with
  it the invoice must supply its own padding or the content runs to the paper edge. Don't
  reintroduce a fixed `210mm` width — it overflows Letter's printable area and forces a scale-down
  on mobile print renderers.
- **`ProductPicker` only learns a product's name by being clicked.** Any code path that sets a line's
  `product` id some other way must also pass `selectedName`, or the picker reads "Select product"
  while holding a real id.
- **Django's `{# ... #}` is a SINGLE-LINE comment.** A newline between the delimiters means it is
  not a comment at all: the whole block renders as literal text. Three multi-line ones sat in
  `emails/otp_code.html` and Gmail displayed them as paragraphs of prose above the verification
  code. There is no error and no warning — the template renders "successfully" and the defect is
  visible only in an inbox, after the mail has gone. Use `{% comment %}` blocks in templates,
  always. `HtmlEmailTests.test_no_raw_template_syntax_reaches_the_reader` checks both bodies of
  both flows for every delimiter.
- **The OTP email's brand mark is drawn from table cells, not an `<img>`.**
  `test_the_html_has_no_remote_content` forbids `<img`, `http://` and `https://` outright — a code
  email that fetches a remote asset shows "images not displayed" warnings, adds spam weight and
  delays the six digits. The mark is a rounded tile of stacked bars built from `<td>`s carrying
  `bgcolor` and `height` *attributes* alongside the inline style, which is the most reliable
  construct in Word's renderer. It mirrors `frontend/public/favicon.svg`; change one and change both.
- **Intl formatters must be built once and reused, never per call.** Constructing an
  `Intl.NumberFormat` costs ~20µs against ~0.4µs to format with an existing one — measured at 54x.
  Every function in `lib/format.js` used to construct one per call, and `toLocaleDateString` does
  it internally too. A list page renders ten rows *twice* (table + cards), each with several money
  figures, so a debounced search was paying hundreds of locale resolutions per keystroke. The
  caches are keyed on the option object; adding a new formatter means going through
  `numberFormatter`/`dateFormatter`, not calling `Intl` directly.
- **`@page { margin: 0 }` is not a placeholder to be tidied into `10mm`.** It is the only lever CSS
  has over the browser's own print headers and footers, and a non-zero page margin hands Chrome and
  Safari back the source URL, the document title and a timestamp — printed onto a customer's
  invoice. The 10mm of paper margin comes from `.invoice-print`'s own padding instead: same
  geometry, no browser chrome. `invoicePrint.test.js` asserts it against the stylesheet source,
  because jsdom has no layout and cannot observe a print rule by rendering.
- **The on-screen invoice is scaled with `zoom`, not `transform: scale()`.** A transform scales the
  painted result but leaves the layout box at full size, so the modal keeps reserving the unscaled
  height and the saving appears as empty space below the invoice rather than as more visible rows.
- **`navigator.share` cannot be pointed at WhatsApp or Telegram.** Neither `wa.me` nor
  `t.me/share/url` has a parameter for an attachment — no encoding adds one — so sharing the actual
  PDF has to go through the Web Share API, which opens the OS sheet and lets the *user* pick the
  target. Both buttons therefore do exactly the same thing, and that is not a bug to be tidied
  into one button: they are two familiar affordances onto one sheet.
- **The invoice share carries the PDF and no link, by decision (2026-08-26).** `buildShareMessage`,
  `whatsappShareUrl` and `telegramShareUrl` were deleted, not deprecated — a share must not deliver
  a URL back into this app under a button labelled WhatsApp. The payload is
  `{ files: [pdf], title }` with **no `text`**, and `shareInvoiceFile` omits absent keys rather than
  passing `text: undefined`, which some implementations validate against.
  Where file sharing is unsupported (Firefox, most desktop Linux) the fallback is a **download**,
  never a `wa.me` link — reopening that path is what the change existed to stop. A dismissed sheet
  (`AbortError`) must *not* trigger the download; only a real failure does.
- **The send buttons are deliberately not gated on `shareUrl`.** They were, while they still built
  link-based messages. Now that they carry only the PDF, gating them would force every send to first
  mint a public share token — publishing the customer's details to an unauthenticated URL that is
  then never used. "Share invoice"/"Copy link" remain for the case where a URL is actually wanted.
- **`lib/pdf.js` is hand-rolled and the PDF must be built synchronously.** jsPDF + html2canvas is
  ~550 kB for a document that is text, rules and filled rectangles, against ~9 kB for this. More
  importantly `navigator.share` must be called inside the user gesture that triggered it: awaiting
  a dynamic import or a canvas render first spends the gesture and Safari throws. Scope is the
  standard 14 fonts and Latin-1 only — non-Latin product names become `?`, and Print / Save PDF
  stays the full-fidelity route for those.
- **Authentication joins the account in: `accounts/authentication.py`.** Every request resolves
  `get_account(request.user)`, and `user -> membership -> account` is two lazy hops on top of the
  user fetch — three queries before a view sees any business data, on every call. The custom
  `AccountAwareJWTAuthentication` selects the join and makes it one (orders and products list:
  6 queries -> 4). It is a *full override* of simplejwt's `get_user`, so the library's own
  rejections are copied code here; each is pinned by `AccountAwareJWTAuthenticationTests` so a
  dropped check fails rather than silently widening who can authenticate.
- **List-endpoint query counts are pinned by slope, not by a fixed number.**
  `ListEndpointQueryBudgetTests` compares 4 orders against 40 and requires the counts be equal. A
  hardcoded `assertNumQueries(4)` fails on every harmless refactor and still passes an N+1 that
  happens to land on the same total; a difference between two dataset sizes is a per-row query and
  nothing else is.
