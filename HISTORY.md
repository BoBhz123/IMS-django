# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

---

## 2026-08-12 — Phase 2.5b-4: one subscription contract, and a smart plan screen

**The wire names changed.** `status` → `subscription_status`, `has_active_subscription` →
`subscription_live`, `is_trialing` → `is_trial`, and `VerifyEmailView`'s bespoke `status` key
joins them. Renamed rather than aliased: two names for one value in the same payload is a
question every future reader has to answer, and every consumer lives in this repo.
`subscription_payload()` is now the single projection, shared by `/accounts/subscription/` and
by `/auth/users/me/` (nested under `subscription`, reusing the same serializer — nested rather
than flattened because `id` and `email` would otherwise collide with the user's own).
`SubscriptionPayloadContractTests` pins the exact field set and asserts the two endpoints
return byte-identical bodies, because four separate frontend concerns read this shape and a
silent rename breaks all four in different, hard-to-trace ways.

**`payment_method` is inferred, not stored.** 'trial', 'card' if the Paddle ids are set,
'manual' for anything else that reached `active` — key, cash, Whish, or an admin. A stored
column would mean every activation path has to remember to set it; the Paddle ids are written
only by the webhook, so their presence is already a reliable signal.

**`/subscription` stops showing a price list to people who already pay.** A live subscriber
gets a "Current active subscription" card — plan, payment type, renewal date — with the
catalog, the Whish/cash pitch and the key box all behind a "Change or upgrade plan" reveal.
Fronting checkout to someone who has paid reads as "we lost your payment". An account that is
*not* live sees a `role="alert"` and the plans immediately: no extra click, because for them
this screen is the only way back in.

**Redemption now routes off the refreshed liveness, not the 200.** It was checking
`refreshed?.status === 'active'`; a 200 from redeem is not proof of access, and routing home
on one would have ProtectedRoute bounce the user straight back. There is a test for each
direction.

`renewalInfo` picks the clock that matters — `trial_ends_at` while trialing, `expires_at` when
paid, and null for a lifetime licence, because "Renews: —" invites the question of whether
something is broken. `subscriptionBadge` takes the whole account rather than a status string,
for the reason that keeps recurring in this phase: an `active` row past its expiry still reads
`active` in the database, so only the computed flag can be trusted.

Settings gains the "Subscription & Billing" card the same helpers feed — plan, renewal date,
account id — with the account id moved off the generic identity grid, since quoting it to
support is a billing act.

**Admin overrides sync because nothing caches.** `AdminOverrideSyncTests` activates, revokes,
extends a trial and hand-edits an expiry through the real admin, then asserts each shows up on
the customer's next fetch *and* opens or closes `/inventory/products/`. Writing it surfaced a
test-only trap worth knowing: `force_authenticate` holds one `User` instance, and Django caches
`user.membership.account` on it, so a reused client serves a stale in-memory Account and the
sync appears broken. Real requests re-authenticate every time; the tests now build a client
from a freshly loaded user.

Verified: `manage.py test` 260 passed; `npm test` 129 passed; lint and build clean.

---

## 2026-08-12 — Phase 2.5b-3: unpaid whitelist and superuser-only billing admin

Two gaps closed on top of 2.5b-2, plus badges. Most of the requested scope was already
standing — `secrets`-based key generation, the redemption validation and payload, and the
login/signup cross-links all shipped in earlier phases and are unchanged.

**`/settings` joins `/subscription` on the unpaid whitelist.** An expired account was being
bounced off every screen including its own account details, which is where the account id and
email support asks for actually live — locking someone out of that while asking them to pay is
hostile, and neither screen calls a gated endpoint, so allowing it costs nothing. The whitelist
lives in `routeForAccountStatus`, which now takes the current path; `isAllowedWhileUnpaid`
matches exact routes and nested children only, because a bare `startsWith` would let
`/settings-export` through.

**The whitelist deliberately does not apply to `pending_verification`.** An unverified account
has not proved it owns the email address; that is a different and worse hole than an unpaid
one, so verification still wins over the path check. There is a test pinning it.

**Billing admin is superuser-only, enforced five ways.** `SuperuserOnlyAdmin` overrides
`has_module_permission` alongside the four object permissions — the module check is what keeps
the section off the admin index, and without it a staff user sees the links and gets a 403,
which reads as a broken admin rather than a boundary. All five are needed because Django
consults them independently, so a group grant would otherwise be enough to reach the models
that hand out free subscriptions. Applied to `DiscountKey`, `DiscountKeyRedemption` and
`ProcessedWebhookEvent`. The test grants a staff user *every* permission in the table and
asserts they still cannot get in.

**`AccountAdmin` is the deliberate exception.** It stays visible to staff, because a name and
phone are ordinary support data and a support user who cannot find the customer cannot help
them. What is gated is the ability to *change* what they have paid for: `get_actions` strips
every activation action for non-superusers, and `get_readonly_fields` freezes the subscription
and Paddle columns. Read-only rather than hidden, so support can still see why a customer is
locked out. `get_actions` is the real gate — the action dropdown is only a UI affordance, and a
test posts a `revoke_subscription` a staff user cannot see and asserts nothing happens.

`admin.actions` takes the callables, not their names. A string there is resolved only against
methods on the ModelAdmin, and these are module-level functions, so naming them registered
nothing at all and every action silently vanished. The names are derived back off `__name__`
for the gating, which is keyed by name.

Status/plan/live badges via `format_html` — escaping matters because a business name is user
input and reaches that column. `trialing` is amber rather than green: the account is live but
on borrowed time, and that distinction is the point of scanning the column. The live badge
shows the *computed* answer, so an `active` row whose expiry has passed reads "No" — the
disagreement between column and enforcement becomes visible at a glance instead of via a
support ticket.

**Endpoint paths were left alone.** The request named `/api/accounts/me/`,
`/api/accounts/redeem-code/` and friends; this app has no `/api/` prefix and the real paths are
`/auth/users/me/`, `/accounts/subscription/`, `/billing/redeem-key/` and `/auth/jwt/blacklist/`.
Read as identifying *which* endpoints must stay reachable rather than as a rename, since
renaming them would break every caller in the SPA for no functional gain. `UnpaidWhitelistTests`
pins all four as reachable while `canceled`, and the core inventory endpoints as blocked.

Verified: `manage.py test` 248 passed; `npm test` 107 passed; lint and build clean.

---

## 2026-08-12 — Phase 2.5b-2: cardless trial, Paddle checkout, and the signed webhook

The gateway half of Phase 2.5, plus a reversal: **the 14-day trial is back.** 2.5a deleted it on the
grounds that a trial is a free bypass of the payment wall. That is still true, and the business chose
cardless acquisition anyway — recorded here so it is not later "fixed" back as a regression.

**The trial is safe because liveness is computed, not stored.** `LIVE_STATUSES` gains `TRIALING`, but
`has_active_subscription` reads `trial_ends_at` for a trialing row, so an elapsed trial locks itself
out with no scheduled job in existence. A `trialing` row with a *null* `trial_ends_at` denies rather
than grants: an unbounded free trial is the one failure a payment wall cannot survive, so the null
case fails closed. The admin's sweep action only tidies the stored column so the list filter tells
the truth; it is explicitly not enforcement.

**The clock starts at verification, not signup.** Setting `trialing` at account creation would have
made the trial a way around email verification, since trialing grants access. So signup writes
`trial_ends_at` (the column is never null) but leaves the status at `pending_verification`, and
`VerifyEmailView` calls `start_trial`, which restamps from now — a customer who took three days to
find the email still gets a full fourteen.

**One tier, three billing choices.** `monthly`, `annual`, `one_time`, all granting identical access;
nothing branches on `plan_type` to decide what a customer may do. `activate_account` now defaults
`months` per plan via `PLAN_MONTHS`, because the webhook names a plan rather than computing a
duration — an omitted argument would otherwise activate an annual purchase for one month.

**Checkout is opened by Paddle.js, not by a server-side transaction create.** The overlay needs only
a price id and the public client token, so starting a checkout costs no API call and cannot fail on a
stale server key. The server's job is to decide which price the customer may buy and to stamp the
account id into `custom_data` so the webhook can find its way back. Still no amount and no currency
anywhere in the request — see the USD-only rule.

**Only the webhook grants access.** Signature verification runs against `request.body`, not
`request.data`: DRF's parsed dict re-serialises with different key order and whitespace and the HMAC
stops matching. Idempotency is an *insert* — `ProcessedWebhookEvent.objects.create()` in a
`try/except IntegrityError` — because check-then-insert lets two concurrent deliveries of the same
retry both through, and a double activation double-extends `expires_at`. The plan comes from the
line item's price id rather than `custom_data.plan`: custom_data is what we asked for, the line item
is what the money bought, and when they disagree the money is the authority. An unrecognised price or
an unmatchable account is logged and answered 200 — retrying will not fix either, and a non-2xx just
tells Paddle to keep trying forever. `subscription.past_due` deliberately does *not* revoke: Paddle
retries a failed card for days, and cutting access on the first failure locks out customers whose
second attempt succeeds.

**Local payments settle over chat.** WhatsApp and Telegram deep links on `/subscription`, pre-filled
with account id, email and selected plan — the three things a customer otherwise forgets to include.
Blank contact settings hide the button rather than rendering a link to nowhere.

The plan cards became radio inputs. They had been a `role="button"` container with a "Pay with card"
button nested inside, which is invalid ARIA — the outer control's accessible name swallows the inner
button's text, and a screen reader cannot tell the two targets apart. The test caught it as six
matches for three buttons.

Admin gains activate-monthly/annual/lifetime, extend trial, reset trial, revoke, and the trial sweep.
Activation runs each row through `activate_account` rather than `queryset.update()` — the old bulk
update set the status column and left `expires_at` null, producing an account that reads active and
computes as not live. Revoke clears both clocks, since a leftover date would keep serving a
chargeback. `ProcessedWebhookEvent` is registered read-only: deleting a row lets the next retry
re-activate an account.

Frontend also gains a persistent trial banner (quiet until the last three days — a fortnight-long
banner that shouts from day one is one users stop seeing) and a `/settings` page showing subscription
state from the server's computed fields rather than re-deriving them against the device clock.

**Not done, needs a human:** every Paddle credential in `.env` is a placeholder, and the three prices
do not exist in the catalog. They could not be created from the session — the Paddle MCP connection
is read-only and `client.products.create` fails without `product.write`. With placeholders the
provider reports card checkout unavailable and the app falls back to keys and Whish/cash, which is
the designed degradation. No end-to-end sandbox checkout has therefore been exercised.

Verified: `manage.py test` 226 passed; `npm test` 91 passed; lint and build clean.

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
