# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

---

## 2026-08-08 — Phase 2: single database, accounts, subscriptions

`django-tenants` is gone. The app was schema-per-tenant, resolved from the request's `Host` header;
it is now one database where every business row carries an `account` foreign key. The dependency is
out of the `Pipfile`, the lock, and the virtualenv; `tenants/` is deleted along with the `TENANT_*`
settings, the two database routers, and `TenantS3Storage`. Existing tenant data was discarded, as
approved during design — inventory tables lived only inside tenant schemas, so the public schema had
none of them and `inventory/migrations/` was regenerated as a clean `0001_initial`.

**Ownership.** New `accounts` app: `Account` (name, `subscription_status`, `plan_type`, `expires_at`)
and `Membership` (user ↔ account, `is_owner`). All six inventory models plus `Purchase`/`Order` gained
an `account` FK. `ProductImage`, `OrderItem`, and `PurchaseItem` deliberately did *not* — they reach
the owner through their parent, and a second copy of the owner on a child row is a divergence waiting
to happen. The global `unique=True` on `Product`/`Supplier`/`Category`/`Customer` `.name` became
`UniqueConstraint(['account', 'name'])`; left as-is, the first account to name a product "Coffee"
would have blocked every other account from doing the same.

**Scoping is two halves, and both are required.** `AccountScopedMixin` filters every viewset queryset
and stamps `account` on create; `AccountScopedSerializerMixin` narrows each relational field's
queryset to the same account. Scoping `get_queryset` alone protects reads only — without the
serializer half, a caller can POST a payload referencing another account's row by primary key and DRF
resolves it happily. `ProductImageViewSet` scopes through `account_lookup = 'product__account'`.

The serializer narrowing happens in `get_fields()`, not `__init__` as the plan specified. A nested
serializer is constructed twice before it ever sees a request — once when the class body runs, again
by DRF's `Field.__deepcopy__` — both times unbound with an empty context. Reading the account there
freezes `product` to `.none()` permanently and rejects every order. `get_fields()` runs lazily, after
binding, when `self.context` resolves through the root serializer.

**Subscription gating.** `DEFAULT_PERMISSION_CLASSES` moved off `DjangoModelPermissions` to
`IsAuthenticated + HasActiveSubscription`; `inventory/permissions.py` (`FullDjangoModelPermissions`)
is deleted. Per-model Django permissions were standing in for "may this person use the app" in a
single-tenant install — the real gates are now which rows you can see and whether you're paid up.
Liveness is `Account.has_active_subscription`, computed from status *and* `expires_at`, never read
from the status column alone.

`AnalyticsView` and both CSV export views lost `IsAdminUser`. Under the new role model `is_staff`
means platform superadmin, so leaving them would either have broken every subscriber's dashboard or
handed every subscriber the platform. They now scope to `get_account(request.user)`.

**Signup.** `POST /auth/users/` takes an extra `business_name` and, in one transaction, creates the
user, a 14-day trial `Account`, and an owner `Membership` — via `UserCreateWithAccountSerializer`
wired through `DJOSER['SERIALIZERS']`. Its `validate()` has to lift `business_name` out and put it
back, because djoser runs `User(**attrs)` there to feed Django's password validators and `User` has
no such column. Frontend: `/signup` and `/subscription` screens, a `register()` on `AuthContext`, and
an axios interceptor that redirects to `/subscription` on a lapsed subscription rather than toasting
an error on every dashboard call. The 403 body is *flat* — `{detail, code}`, not `{detail: {…}}` —
because DRF's exception handler passes a dict `detail` straight through as the response body; both
the test and the interceptor read `body.code` off that shape.

No payment gateway: the renew button is a `mailto:`. `seed_data` is account-aware (`--account`,
`--owner`) and creates a demo owner login rather than a tenant schema.

Two plan deviations, both recorded in the commits: the above `get_fields()` move, and folding Task 5
Steps 3–5 into Task 4. The task boundary as written was not implementable — Task 4's fixture users are
ordinary account owners with no model permissions, so under the old `FullDjangoModelPermissions`
default they 403 on every request, and Task 4's own isolation tests target endpoints that Task 5 was
scheduled to un-pin from `IsAdminUser`.

The 28 pre-existing tests moved off `TenantTestCase`/`TenantClient` to plain `TestCase`/`APIClient`.
`ExternalImageURLTests` now runs under a temporary `MEDIA_ROOT` — it writes a real file, which was
landing in the repo's tracked `media/` directory.

Verified: `manage.py test` 69 passed; `npm test` 22 passed; lint and build clean; `seed_data` runs
end-to-end. Nothing was deployed — production stays on the old code until a separate, authorized
release.

---

## 2026-08-07 — Phase 1: order stock validation

Orders exceeding available stock are rejected with HTTP 400 instead of silently driving
`stock_quantity` negative. Validation compares `quantity * unit_multiplier` (the same
expression the deduction uses), aggregated per product so duplicate lines cannot each
pass on their own, and re-checks under `select_for_update()` inside the atomic block to
close the concurrent-order race.

Fixed alongside it: DRF builds a separate `Product` instance per nested item, so the old
per-item `stock_quantity -= n; save()` loop wrote stale copies — ordering one product on
two lines only ever applied the last line. Both orders and purchases now aggregate per
product and update with `F()` expressions. This had been silently miscounting stock.

Frontend: `lib/stock.js` (unit-tested) holds the arithmetic; the order form caps each
line, disables out-of-stock products in the picker, badges the at-limit and over-limit
states, and blocks submission. Testing tooling added in this phase: Vitest, plus
@testing-library/react and jsdom for the `OrderForm` component tests.

Verified: `manage.py test` 50 passed; `npm test` 22 passed; lint and build clean.

---

## 2026-08-07 — SaaS migration planned

**Design approved:** `docs/superpowers/specs/2026-08-07-saas-single-db-migration-design.md`
Five phases on branch `feature/saas-single-db-migration`: order stock validation, single-database
account architecture with subscription gating, expense tracking, product barcodes, CSV export totals.

Key decisions made during design, recorded here because the reasoning won't be visible in the diffs:

- **Existing tenant data is discarded.** Chosen over a cross-schema data migration, which removed the
  bulk of Phase 2's risk. The two live tenant subdomains lose their data.
- **`Account` owns data, not `User`.** A tenant was a business, not a person. Adding a second employee
  later becomes a row insert rather than re-migrating every table.
- **Clean-slate migrations over additive ones.** Inventory tables exist only inside tenant schemas, so
  switching to the stock Postgres backend leaves the public schema with none of them — a database reset
  is required either way, which makes additive migrations pure ceremony.
- **Explicit scoping mixin over auto-filtering managers/middleware.** Auto-filtering needs thread-local
  request state, which silently does nothing in management commands, shell, and background jobs —
  exactly where a bulk mistake leaks data.
- **Subscription liveness is computed, never read from the status column.** Nothing flips `active` →
  `past_due` without a scheduled job, so a stale column would silently grant free service.
- **No payment gateway this cycle.** It plugs into the fields defined here; landing Stripe alongside
  the tenant teardown would couple two independent risks.

---

## Before 2026-08-07

See `git log`. Highlights: performance pass (pagination, N+1 removal, hot-column indexes), Sentry
monitoring, R2 media storage via a public custom domain, production `DEBUG`/`ALLOWED_HOSTS` hardening,
django-axes with correct proxy-aware client IPs, and the React dashboard frontend.
