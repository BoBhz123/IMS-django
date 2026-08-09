# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

---

## 2026-08-09 — Phase 4: product barcodes

Optional `Product.barcode`, added to `ProductViewSet.search_fields` so a scanned code finds its product
through the list endpoint the SPA already calls, rather than needing a second endpoint. Form input,
a tag in the products list, admin search, and seeded onto most demo products.

**Indexed, not unique — a decision, not an omission.** A shop legitimately reuses one code across
loose goods and own-label lines, and a unique constraint would reject that outright. A test asserts
two products *may* share a barcode, so introducing the constraint later breaks a visible test instead
of silently changing what the field means. If it is ever added it should be per-account and partial,
like the `name` constraints — a global one would let the first account to record an EAN block every
other account from recording the same real-world product.

**`Product.save()` normalizes `''` to `NULL` and strips whitespace.** Two separate bugs avoided:
without the first, `''` and `NULL` both mean "no barcode" and every lookup has to test for both — and
any future unique constraint collides on the second `''` row. Without the second, a scanner's or a
copy-paste's trailing space makes the code unfindable by the number printed on the label, which is
the one search anyone will actually type.

Camera scanning remains deliberately out of scope for a later phase; this ships the data and the
lookup it needs.

---

## 2026-08-09 — Phase 3: expense tracking and financial reporting

`Expense` CRUD is the small half of this phase. The large half is fixing what "profit" meant, because
the app shipped two definitions of it that disagreed under completely normal operation.

**Two contradicting definitions, and which one won.** `AnalyticsView` computed `revenue − purchases in
window` — cash out against cash in. `ExportOrdersCSVView` and `Order.total_profit` computed
`revenue − cost of the items sold` — margin. Buy $5,000 of stock in January and sell it over six
months: the dashboard reported a January loss followed by five inflated months while the CSV reported
steady margin, and both columns were labelled "profit". Margin won for the P&L; the cash figure
survives as `inventory_outlays`, deliberately outside it. Adding expenses on top of either definition
would have compounded the problem, so this was settled first.

**`OrderItem.unit_cost_price` is snapshotted, not derived.** `OrderItem.profit` used to read
`self.product.cost_price` live, so correcting a product's cost silently rewrote every past month —
last year's numbers were not reproducible. The cost is now stamped at the instant of sale, inside the
same `@transaction.atomic` block that already locks stock, and profit reads the snapshot.

**The backfill is an approximation, and knowingly so.** Existing lines were stamped with their
product's cost *as it stood at migration time*. The true cost at each historical sale was never
recorded anywhere and cannot be recovered; this was the last moment the number was knowable at all.
Historical gross profit shifted once and is stable forever after. Everything sold after this ships is
exact. The alternative — leaving profit recomputed from live costs — means no month is ever
reproducible, which is worse.

**`bulk_create` bypasses `save()`.** That is why `CreateOrderSerializer` stamps the cost itself,
reading off the rows it has already locked rather than re-querying, while `OrderItem.save()` covers
the paths that build rows one at a time — the admin inline and `seed_data`. Either half alone leaves a
route that records a zero cost and therefore a 100% margin. `save()` coerces through the field with
`to_python`, because an unsaved `Product` may still hold the string a fixture or form assigned it, and
`.profit` does arithmetic on that value.

**`DateWindow` was extracted before expenses existed, not after.** `AnalyticsView` applied five date
filters inline across three querysets; expenses would have been a fourth. A window applied to orders
but not to expenses misstates net profit and raises nothing — there is no error to notice. Extracting
it as a pure refactor first, with every pre-existing analytics test passing untouched, is what proves
the diff that added expenses could not have hidden a filtering regression.

**`spent_at`, not `created_at`.** A receipt entered on Friday for a Tuesday spend has to land in
Tuesday's month or that month's net profit is wrong. `default=timezone.now` is what makes that
possible; `auto_now_add` ignores assignment entirely and would have made backdating impossible. A
separate `created_at` keeps the audit trail of when the row was entered, which a money record
warrants. Categories are a fixed choice list because free text fragments `Rent`, `rent` and `Rent `
into separate rows in the per-category breakdown that is the main reason to record a category at all.

**`inventory_outlays` is deliberately outside the P&L**, and deliberately renamed. Stock bought this
month is not a cost of what was sold this month; folding it in makes margin swing with restocking
timing. Left as `total_costs` it would have sat immediately beside a new `total_cogs` — a permanent
invitation to read the wrong number. The chart `series` still uses `total_costs` for its purchases
line, where nothing resembling COGS is nearby.

**Analytics money is raw numbers now.** The view pre-formatted `"$1,234.00"` and the dashboard
immediately parsed it back into a number so the LBP toggle could reformat it — format, parse,
reformat. The new tiles needed the same round trip, so it was removed rather than extended. Two
pre-existing tests asserted the old string contract and were updated; that is the intended change.

**`net_profit` changed meaning** from `revenue − purchases` to `gross_profit − expenses`. The number
on the dashboard moved, on purpose. The Gross profit and Net profit tiles carry no sparkline: the
series has revenue, purchases and expenses per period but not COGS, so there is no honest per-period
profit to draw, and a revenue−purchases line would be the old conflation back again in a shape that
looks authoritative.

---

## 2026-08-08 — Phase 2.5b-1: billing foundation and discount keys

Everything in Phase 2.5b that does not need a live Paddle account: one activation function, a
provider seam with a dummy behind it, locally-issued discount keys, three billing endpoints, and the
`/subscription` plan screen. A cash-only business is now fully operational whether or not Paddle ever
approves a Lebanon-registered seller — which is the whole reason the phase was split this way.

**`accounts/billing/activation.py::activate_account` is the only code that grants access.** Key
redemption calls it today; 2.5b-2's webhook will call the same function instead of reimplementing
expiry arithmetic somewhere it can drift. It already takes `grace_days` for that caller — a renewal
notification that arrives ten minutes late must not lock out a paying customer at midnight — and key
redemption passes 0, because there is no third party to be late.

Months extend from `max(now, expires_at)`. Extending from `now` would discard the time left on an
early renewal; extending from `expires_at` unconditionally would let a lapsed account's new month be
eaten by the months it spent expired. Both directions are tested.

`add_months` does calendar arithmetic with a clamp, not `timedelta(days=30 * n)`. Thirty-day months
drift about five days a year against the date the customer thinks they bought, and the drift
compounds on every renewal. Clamping is why 31 January + 1 month is 28 February rather than rolling
into 3 March and handing out days nobody paid for.

**The dummy provider refuses instead of faking success.** A dummy that activated accounts would make
a misconfigured production deployment indistinguishable from a working one until somebody went
looking for the money. `BILLING_PROVIDER='paddle'` raises `ImproperlyConfigured` naming the phase,
rather than half-working. `PLAN_KEYS` is derived from `Account.PLAN_TYPE_CHOICES` instead of retyped,
with a test pinning them together — drift there would let checkout accept a plan `activate_account`
rejects with a `ValueError`, which is a 500 where a 400 belongs.

**Keys are ours, not gateway coupons.** A coupon still needs the checkout round trip, and the
requirement is to bypass card checkout entirely for someone who paid cash, Whish, or OMT. Local keys
also record the sale where Phase 3's reporting can see it, and keep working if the gateway is down.
The alphabet excludes `0/O` and `1/I/L` because these get read aloud off WhatsApp; codes are stored
normalized (uppercase, no dashes) and displayed in dash-separated fours.

Redemption holds `select_for_update()` inside the atomic block. Without the row lock, two concurrent
posts both read `redemption_count = 0`, both pass the check, and both redeem a single-use key. The
unique `(key, account)` constraint is the second half — it catches the same account double-dipping on
a multi-use key.

**Unknown, expired, exhausted, and deactivated keys all return one identical body**, so the endpoint
is not an oracle that confirms which codes exist; a test asserts all four responses are byte-identical
rather than merely all being 400s. Two failures are deliberately distinguishable, and the trade is
worth stating: `already_redeemed` leaks nothing the caller cannot already see, and
`partial_discount_unsupported` tells the owner the key is real but unsupported instead of sending them
hunting for a typo. v1 honours `percent_off = 100` only — a partial discount needs a gateway charge
for the remainder, which does not exist yet.

All three billing endpoints declare `permission_classes = [IsAuthenticated]` explicitly, shedding the
`HasActiveSubscription` default, and each has a test asserting it is reachable while `pending_payment`.
This is the same trap Phase 2.5a documented: these are the endpoints an unpaid account needs in order
to stop being unpaid.

Keys are issued from the Django admin, where the owner already works. Leaving the code field blank
generates one — the generation happens in the admin form's `clean_code`, not `save_model`, because
`ModelForm` runs the model's `full_clean()` in between and that rejects a blank code. The model field
stays required, so no other path can create a key without one.

Frontend: `/subscription` replaces `SubscriptionExpired.jsx` and its `mailto:` renew button, and
doubles as the lapsed-subscription screen the Phase 2 axios interceptor already redirects to. Card
availability is a server fact from `GET /billing/config/`, so the screen hides the pay buttons rather
than offering one that always fails. `lib/billing.js` mirrors the Python alphabet and drops characters
outside it as the user types — silently keeping an `O` the customer substituted for a `0` guarantees a
failed redemption with no explanation.

**Deferred to 2.5b-2, still blocked on credentials:** `accounts/billing/paddle.py`, `POST
/billing/webhook/` with signature verification, `ProcessedWebhookEvent` idempotency, the `paddle_*`
columns, and Paddle.js. The design requires the seller-approval risk validated before they are built.

Prices are display-only settings (`BILLING_PRICE_MONTHLY_USD` = 15, `BILLING_PRICE_ONE_TIME_USD` =
299) and are placeholders — the real amounts will come from configured Paddle price ids, and the
server never accepts an amount from the client.

Verified: `manage.py test` 175 passed; `npm test` 55 passed; lint and build clean.

---

## 2026-08-08 — Phase 2.5a: onboarding identity and email verification

Registration now takes email + password + phone, emails a 6-digit code, and grants no access until
the code is verified. Phase 2's 14-day trial is deleted — a trial is a free bypass of the payment
wall that 2.5b is being built to erect.

**"No account until paid" is not implementable, so the account is created inert instead.** There has
to be a row before a code can be attached to it or a card charged against it. `subscription_status`
gains `pending_verification` (the new default) and `pending_payment`, and `LIVE_STATUSES` narrows to
`(ACTIVE,)`. Phase 2's `HasActiveSubscription` default then locks every endpoint for an un-onboarded
account with no new permission checks written anywhere — the state machine *is* the wall.

**The wall would otherwise block its own exit.** `SubscriptionStatusView`, `VerifyEmailView` and
`ResendCodeView` each declare `permission_classes = [IsAuthenticated]` explicitly, shedding the
project-wide default. Miss one and the account is stranded in a pending state with no route out
except an admin editing the database.

**The OTP's real defence is the attempt cap, not the hash.** Six digits is 1,000,000 guesses, which
expiry alone does not protect — a script can exhaust that inside a 10-minute window. So:
`secrets.randbelow` to generate (`random` is a Mersenne Twister whose state is recoverable from
enough observed output), HMAC-SHA256 with `SECRET_KEY` at rest, `hmac.compare_digest` to compare,
5 wrong attempts then the code is dead, resend limited to 1/minute and 5/hour, and issuing a new
code expires the outstanding one. The attempt counter increments via `F()` — `row.attempts += 1`
lets two concurrent guesses each read 4 and write 5, making the cap racelessly bypassable.
`django-axes` guards login only and covers none of this.

The code endpoints are authenticated, which is what prevents enumeration: there is no unauthenticated
route that behaves differently for a registered address than an unregistered one.

**`AUTH_USER_MODEL` was not swapped.** `username` is set to the lowercased email, so simplejwt keeps
authenticating against the column it already uses and no table rewrite is needed. Uniqueness on the
address is a raw-SQL functional partial index (`LOWER(email)`, `WHERE email <> ''`) because Django
cannot cleanly `AlterField` another app's model — it will never appear in `makemigrations` output.
The `WHERE` clause matters: superusers created without an address would otherwise all collide on the
empty string.

Email goes out over plain SMTP through Django's existing `EmailBackend` (Resend at
`smtp.resend.com:587`), so no SDK dependency was added and local dev falls through to smtp4dev. It
sends inline on the request thread — this project has no worker queue and adding one is a bigger
change than the phase warrants. A failed send never fails the request: the user's recourse is the
resend button either way, and blocking registration on a third party's SMTP availability would turn
a recoverable annoyance into an unrecoverable one. `ResendCodeView` reports success even when the
send failed, since the distinction leaks nothing useful.

`EmailVerification.created_at` is `default=timezone.now`, not `auto_now_add`, so the rate-limit tests
can shift a row backwards in time instead of sleeping through real cooldowns.

**Until 2.5b lands, `pending_payment` → `active` is a Django admin action** (`activate_accounts`).
Stated here so it is not later discovered as a bug. It stays useful after checkout exists, for the
customer who pays cash or phones the order in.

Frontend: `/signup` collects email and phone, `/signup/verify` takes the code, and `ProtectedRoute`
sends an authenticated-but-un-onboarded user to whichever screen their status calls for rather than
rendering the app shell and filling the screen with 403s. The routing decision is
`lib/onboarding.js::routeForAccountStatus`, unit-tested without React; a `null` status means a
superadmin with no account row and must pass through, or the platform owner is redirected to a
paywall for a subscription they don't have. `AuthContext` fetches the account alongside the user
because the router needs the status before it can render anything.

Verified: `manage.py test` 114 passed; `npm test` 39 passed; lint and build clean; `seed_data` runs
end to end. `--owner` is now an email address (`demo@example.com`) and the seeded account is forced
`ACTIVE` — with the new default it would otherwise seed demo data that 403s.

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
