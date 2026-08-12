# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

---

## 2026-08-12 — One trial per account, an encrypted payment log, and the email-config fix

**`has_used_trial` latches on the first trial.** A null `trial_ends_at` could not stand in for
it: the revoke action clears that column, so a revoked account would have read as "never
trialed" and collected a second free fortnight. `start_trial` raises `TrialAlreadyUsed` rather
than returning quietly — a caller that thinks it granted a trial and did not is worse than a
loud failure. The admin's reset action passes `force=True`, which is the one sanctioned way
past the latch, and says so in a warning message.

Migration `0009` backfills the flag for every account with a `trial_ends_at`. Without it the
policy would only apply to signups from today. Accounts revoked *before* the backfill read as
never-trialed and stay False — the safe direction to be wrong in, since it grants a trial to
someone whose subscription was cancelled by hand rather than denying one to a real signup.

`VerifyEmailView` catches `TrialAlreadyUsed` and lands on `pending_payment`. An admin can put
an account back to `pending_verification`, and that path must not 500.

**The email bug was in settings, not in `emails.py`.** That module already caught, logged and
reported failures correctly. `EMAIL_USE_TLS` was parsed as `os.environ.get(...) == 'True'`,
which reads `true`, `TRUE`, `1` and `yes` as False — the connection is then attempted in the
clear, Resend rejects it on port 587, and every verification code fails to send with nothing
in the UI to say so. Now parsed by `_env_flag`, the same way `DEBUG` already was in the same
file. Also added: `EMAIL_TIMEOUT` (the send is inline on the request thread, so a wedged SMTP
server otherwise holds signup open until the dyno kills it) and a boot-time error when TLS and
SSL are both set, because Django's own message points at the backend rather than the
environment that caused it.

**`UserPaymentRecord` is not a card vault and must never become one.** Paddle is the merchant
of record and this app never sees a PAN; what lands here is the detail a cash or Whish sale
leaves behind. Fernet encrypts it at rest via `accounts/crypto.py`. The threat model is stated
in that module rather than implied: this defends against a leaked dump, a stray backup, or a
support user reading the table — not against a compromised server, since the key is in the
process environment. `method` and `amount_usd` stay in the clear because reporting groups by
them and "this was a cash sale" is not sensitive.

`get_fernet()` refuses to fall back to a SECRET_KEY-derived key when DEBUG is off. The
fallback would work perfectly until somebody rotated SECRET_KEY for unrelated reasons, and
then every record would be unreadable at once with no error to trace it to. Tests supply their
own key for the same reason — Django forces DEBUG=False under the runner. Decryption failure
returns a marker instead of raising, so one bad row cannot 500 a changelist showing fifty.

The admin changelist shows a masked length hint, not the note: a list view is what gets left
open on a shared screen, and answering "did this account pay?" does not require decrypting
fifty rows.

**`UserAdmin` is re-registered explicitly.** Django already ships the password-change form, so
this changes little functionally — but it pins the capability against a stray unregister,
surfaces which account a user belongs to (where support actually starts), and adds the check
that matters: a staff user cannot change another user's password, because that is a full
account takeover and no model permission should grant it.

`Settings` is out of `NAV_ITEMS`. It stays reachable everywhere because the account dropdown
is rendered twice — in the Dock (`sm:flex`) and in `WindowChrome` (`sm:hidden`) — which is
what makes removing the rail item safe on phones. "Back to Settings" on `/subscription` shows
only for a live subscriber: someone locked out did not arrive from Settings and cannot use the
app, so sign-out remains their exit.

Verified: `manage.py test` 500 passed; `npm test` 256 passed; lint and build clean.

---

## 2026-08-12 — Merge: Phases 3-8 join the Phase 2.5 billing work

`phase-3-expenses` (39 commits — expenses, barcodes, the dashboard profit series, CSV totals,
camera scanning, categories, the account menu with OTP password reset, and the OWASP audit)
merged into `feature/saas-single-db-migration`. Both branches had grown from the same commit
and neither had seen the other.

**Three conflicts needed real decisions, not just marker removal.**

`Settings.jsx` existed on both sides as different pages — a password-reset flow on one, a
subscription/billing/preferences page on the other. Neither was discardable, so the merged page
carries four cards: details, Subscription & Billing, Password, Preferences. Their card-based
`GlassCard` layout won over the flat sections, and the `Business` detail row was restored
because their test scopes to that region.

`accounts/views.py` needed the union of both import sets, minus `SubscriptionStatusSerializer`
— `SubscriptionStatusView` now calls `subscription_payload`, which absorbed the no-account case
the view used to spell out.

**Two `0006_` migrations both branched off `0005`** — `emailverification_purpose` and
`processedwebhookevent_…`. Django refuses multiple leaf nodes, so `0007_merge_20260812_1242`
joins them. This is the kind of thing that only shows up when two long-lived branches meet.

**The build caught what the tests could not.** Git cleanly auto-merged `App.jsx` into having
`import { Settings }` *twice* — valid to every test that mocks the module, fatal to rolldown.
`npm run build` is the only check in this project that sees it, which is exactly why CLAUDE.md
insists on running it before calling frontend work done.

`Settings` stays in `NAV_ITEMS` even though `UserMenu` also links to it: `MobileTabBar` renders
`NAV_ITEMS` and nothing else, so removing it would strand `/settings` on phones — and that page
is on the unpaid whitelist, so it has to stay reachable.

`npm install` was required after the merge: `package.json` gained `@zxing/library` and three
test files failed to resolve it until node_modules caught up. `npm audit` now reports 0
vulnerabilities — the react-router-dom advisories noted in the working log are gone.

Verified after merge: `manage.py test` 472 passed; `npm test` 251 passed; lint clean; build
clean. (An earlier run reported 5 `setUpClass` errors — two test runs racing for the same
Postgres test databases, not a defect.)

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
## 2026-08-10 — The playground app is deleted

Closing the last item the OWASP audit left open. `playground/` held `say_hello`, which read
`Order.objects` with no account filter and no authentication — every account's orders, to anyone.
It was never routed, so it was never exploitable, but it sat one innocuous line of `urls.py` away
from being a cross-tenant leak. Deleted rather than left tripwired.

**Removal was pure subtraction.** The app defined no models, held no migrations beyond the empty
`__init__.py`, and owned no tables — checked against the live dev database (`django_migrations` had
no `playground` rows and `information_schema` no `playground%` tables) before anything was removed,
because "it's only a scratch app" is exactly the assumption that loses data when it turns out to be
wrong.

**The tripwire test was replaced, not dropped.** `test_a05_the_playground_scratch_view_is_not_routed`
had nothing left to guard, but the lesson generalises:
`test_a05_every_routed_inventory_view_requires_authentication` now walks `inventory/urls.py` and
fails if any routed view does not demand an authenticated caller. A plain Django view — which has no
`permission_classes` at all — routed under `/inventory/` would be the same bug wearing a new name.

`HISTORY.md` and the audit specs keep their original wording; the finding is annotated as resolved
rather than rewritten, since they record what was true when they were written.

Verified: `manage.py test` 387 passed; `npm test` 178 passed; build clean; `check` and
`check --deploy` both report 0 issues; `makemigrations --check` reports no drift; `seed_data` runs
end to end.

---

## 2026-08-10 — OWASP Top 10 audit, CSP, and the security audit trail

Full report: `docs/superpowers/specs/2026-08-10-owasp-top-10-audit.md`. Ten categories, each
asserted by behaviour rather than by the presence of a setting, plus semgrep's `p/owasp-top-ten`
and seven supporting rulesets (281 rules, 187 files).

**The automated scans found nothing new, and that is the result worth recording.** Both real gaps
this pass — no CSP, no audit trail — are *missing controls*, and the worst bug of the previous pass
was broken authorization. Scanners find sinks. They do not find absent defences or authorization
mistakes, which look exactly like ordinary code.

**F-06 closed, as authorised.** The app now refuses to boot when `DEBUG` is off and `SECRET_KEY` is
still the committed default. This mattered more than a stale-config warning: `SIMPLE_JWT` has no
separate `SIGNING_KEY`, so that key signs every token — a deploy missing the variable let anyone who
can read this repository mint a token for any user. `manage.py check --deploy` is now clean.

**CSP added, hand-rolled rather than `django-csp`** — a dependency means `pipenv install`, which
relocks, and a relock has silently bumped Django and DRF here before. Two things were verified
before shipping a policy that could break the app: the Django 6 admin emits **zero** inline
`<script>` blocks and zero inline handlers, so `script-src 'self'` does not lock the owner out of
the admin; and the built `index.html` pulls Google Fonts from two hosts that both had to be listed
or the app renders in a fallback face. `'unsafe-inline'` stays in `style-src` because framer-motion
writes inline styles every frame and nonces cannot cover style *attributes* — stated rather than
quietly tolerated. `CSP_REPORT_ONLY=1` rolls a future policy change out without blocking.

CSP earns its place here specifically because **JWTs live in `localStorage`**, so an XSS is a full
account takeover. That is now recorded as an accepted risk with `HttpOnly` cookies named as the
structural fix — CSP is mitigation, not a solution, and the report says so.

**There was no security audit trail at all.** No `LOGGING` config, and no record of who deleted
what — and deletions here are irreversible, so "rows are missing from my customer list" had no
answer. `accounts/audit.py` now logs deletions, password changes, email verifications and
key-granted subscriptions, alongside `django.security` and `axes`, to stdout.

The deletion hook lives in `AccountScopedMixin.perform_destroy`, so one override covers every
scoped collection and a new viewset is audited by inheriting the mixin it already needs in order to
be scoped. The pk is captured *before* the delete and logged *after* it: Django's collector nulls
`instance.pk` on the way out, and logging beforehand would record deletions that never happened,
since a PROTECT foreign key raises and becomes a 409. Both directions are tested.

**Uploads were tested adversarially and held.** PHP source with an `image/jpeg` content type, an
SVG carrying `<script>`, a 2 MB+ file, and a `../../../../etc/` filename: rejected, rejected,
rejected, and stored safely inside the account's own directory. The declared content type is never
believed — Pillow has to be able to open the file.

**Swept clean:** no raw SQL, no `subprocess`/`eval`, no unsafe deserialization, no
`dangerouslySetInnerHTML`, and **no outbound HTTP client anywhere** — SSRF needs a fetcher and there
is none. A test now scans for one, so adding it becomes a deliberate act.

**One latent risk recorded rather than fixed:** `playground.views.say_hello` reads `Order.objects`
with no account filter and no authentication. It is unreachable — `playground.urls` is never
`include()`d — and a test is now the tripwire, because that view is one innocuous line of `urls.py`
away from being a cross-tenant leak. Deleting the scratch app is the better fix and is the owner's
call.

Also documented as accepted: access tokens outlive a password change by up to their remaining day
(revoking them needs a per-request revocation check), and there is no per-user role model inside an
account.

Verified: `manage.py test` 387 passed; `npm test` 178 passed; lint and build clean;
`check --deploy` reports 0 issues; `pip-audit` and `npm audit` both 0.

---

## 2026-08-10 — Phase 8: security audit and hardening

Scanned with `pip-audit`, `bandit`, `npm audit`, `semgrep` (5 rulesets, 256 rules) and
`manage.py check --deploy`. Findings report:
`docs/superpowers/specs/2026-08-09-phase-8-security-audit-findings.md`, committed as a baseline
*before* any fix, so it records what the scanners said rather than describing an already-clean tree.

**The worst finding came from a test, not a scanner.** The nested product-image route was
unscoped: `ProductImageViewSet.get_queryset()` replaced `AccountScopedMixin`'s instead of chaining
through it, so the only filter was the product id taken from the URL. Product ids are sequential, so
any subscriber could walk `/inventory/products/<n>/images/` and list, attach to, retrieve or delete
**any other account's** product images. The declared `account_lookup = 'product__account'` made the
viewset look scoped while doing nothing. semgrep, bandit and pip-audit were all silent — an
authorization bug reads as ordinary ORM code. The Task 8.2 matrix caught it on its first run.

That is the argument for the matrix over per-feature isolation tests: coverage previously tracked
whoever remembered to write it. The matrix drives every case from a resource list, so an endpoint
added without scoping fails rather than ships. It asserts 404 and never 403 throughout — a 403 on
someone else's row confirms the row exists, which is an existence oracle across the tenant boundary.

**CSV formula injection reached 4 of the 5 exports.** `_csv_safe` had existed since the export
redesign but was applied only to the products export, because it lived in `views.py` where
`admin.py` could not reach it while the shared `csv_format.py` held only `money()` and `iso()` — the
exact "a formula fix usually needs both" trap the Working Log warns about. It is now `text()` in
`csv_format.py`, applied everywhere. The admin half matters most: those rows span every account and
the file is opened by the platform superadmin, so a subscriber naming a customer `=HYPERLINK(…)` was
attacking them, not themselves.

The escape is deliberately **not** applied to `money()` output. `-` leads a formula and also leads a
negative line profit, so escaping money cells would emit `'-6.00`, turn the numeric columns back into
text and silently undo the redesign that made them summable. A test pins that.

`CORS_ALLOW_ALL_ORIGINS` now follows `DEBUG`, with the allowlist read from the environment so adding
a domain is config rather than a deploy. Verified in a subprocess: the test runner forces
`DEBUG = False` *after* `ims.settings` is imported, so an in-process assertion proves nothing about
production. The three CSV exports share one `exports` throttle scope at 30/hour per user — they walk
every line item an account has recorded, and a per-view budget would just be three times the ceiling
for the same work. Patching `ScopedRateThrottle.THROTTLE_RATES` in place is what makes that testable;
`override_settings(REST_FRAMEWORK=…)` never reaches it, because DRF copies the rates into a class
attribute at import.

**Accepted without change, with reasons:** bandit's 93 findings are all LOW and all noise — test
fixtures plus false positives on strings like `'password_reset'` and `'10/hour'`, and `random` used
only by `seed_data`. That last one was verified rather than assumed: `random` appears nowhere outside
the seeder, and both real generators (`verification.py`, `billing/keys.py`) use `secrets`.
`pip-audit`'s only hits are three CVEs in `mcp`, which is pinned by **semgrep itself** and is not a
project dependency — re-running against the declared dependencies alone reports nothing.

**Two corrections to previously recorded beliefs.** `npm audit` is now completely clean: the
`react-router-dom` advisories the Working Log described as open were resolved upstream, and the entry
has been removed rather than carried forward. And installing the tooling did *not* relock the
project — `Pipfile.lock` is untouched and Django is still 6.0.8 with DRF 3.17.2.

**Deliberately left open — needs an owner decision.** `SECRET_KEY` and `DEBUG` both default to their
*unsafe* values, so a deploy missing `DJANGO_SECRET_KEY` runs on the key committed to this repo, and
`SIMPLE_JWT` has no separate `SIGNING_KEY`, so that key signs every token. The obvious hardening is to
refuse to boot when `DEBUG` is off and the key is still the default — but if the live deployment is
currently running on that default, shipping the guard takes production down on the next release.
Confirm whether `DJANGO_SECRET_KEY` is set on Heroku first. Everything else in `check --deploy`
already passes: HSTS, SSL redirect, secure and HTTP-only cookies, `X_FRAME_OPTIONS`.

Verified: `manage.py test` 350 passed; `npm test` 178 passed; lint and build clean.

---

## 2026-08-10 — Account menu and OTP password reset

An account menu replaces the bare Sign out button, and `/settings` carries a three-screen password
reset driven by the same emailed 6-digit code Phase 2.5a built for onboarding.

**Codes are now scoped by `purpose`.** Reusing `EmailVerification` for a second flow without a
discriminator breaks three ways: a signup code can be spent at the password-reset endpoint,
requesting a reset silently expires a signup code the user is halfway through typing, and both flows
share one five-sends-per-hour budget so using either exhausts the other. Every query in
`accounts/verification.py` now filters on it, the throttle scopes are separate for the same reason,
and the field defaults to `email_verification` — which is what makes the backfill correct, since
every row predating it came from signup.

**The three screens are not three decisions.** The obvious build gives step 2 a verify endpoint and
step 3 a "set password" endpoint that trusts it, which makes the code decorative: anyone holding a
borrowed session skips to step 3 and locks the owner out. Here `confirm/` takes the code *and* the
new password in one request and consumes the code there, so the decision is made exactly once.
Step 2 exists only so a typo is caught before the user is asked to think up a password, and it
checks with `consume=False` so the code survives to be spent. A wrong guess at that endpoint still
counts against the attempt cap — not counting would make it a free oracle for grinding six digits.
`test_a_valid_session_alone_cannot_change_the_password` is the test that pins this.

**Password rules run before the code is spent.** The other order costs a user who picks something
Django's validators dislike a fresh email and a 60-second wait, which reads as the app being broken.
Validation goes through the configured `AUTH_PASSWORD_VALIDATORS`, not a hand-rolled length check,
so this flow cannot become the one way into the app that accepts `12345`.

**A reset blacklists every outstanding refresh token.** Resetting is what someone does when they
think they are compromised; the SPA holds JWTs, and a refresh token issued beforehand stays valid
for its full 30 days unless blacklisted, so without this the reset locks out nobody. Access tokens
already issued still run out their remaining hours — closing that needs a revocation check on every
request, which is a larger change, and is stated here rather than left as a silent gap.

The flow sheds `HasActiveSubscription` as well as being authenticated: changing a password is not a
paid feature, and someone who thinks their account is compromised must be able to secure it. It is
not open to anonymous callers, which is why the enumeration problem a forgot-password endpoint has
does not exist here — the code goes to the address on file for the authenticated user.

**Menu, not a button.** Sign out sat one mis-tap from the theme toggle in both the dock and the
mobile chrome. It now costs a deliberate second tap, which is the right price for the only
irreversible control in the shell. Escape returns focus to the trigger rather than stranding a
keyboard user with nothing focused.

`lib/passwordReset.js` holds the step and validation logic so it is testable without React, matching
`lib/onboarding.js`. Its `errorMessage` reads DRF's two shapes — `{detail}` for a flow error and
`{field: [messages]}` for a rejected password — because reading only `detail` renders
`[object Object]` for exactly the case that matters most.

**Known limitation:** a lapsed account cannot reach `/settings` in the SPA, because
`routeForAccountStatus` sends any unpaid status to `/subscription` before the app shell renders. The
API allows it; only the router does not. Loosening that would put a hole in the paywall, so it is
recorded rather than fixed.

Verified: `manage.py test` 318 passed; `npm test` 178 passed; lint and build clean.

---

## 2026-08-10 — Barcodes are unique per account

Reversing Phase 4's decision at the owner's direction: every product carries its own barcode, so
`Product` gains `UniqueConstraint(['account', 'barcode'])`. Phase 4 left the field indexed but not
unique on the reasoning that a shop reuses one code across loose goods; the owner's actual working
rule is one code, one product, and the loose-goods case is not how this business runs.

**Per account, never global** — the shape Phase 4 said to use if the constraint was ever added. An
EAN identifies a real-world product, so a global constraint would let the first shop to record
`5901234123457` block every other shop from recording the same item. Two accounts sharing a code is
tested explicitly, not left to be inferred.

**Phase 4's `save()` normalization is what makes the constraint workable, and it was written for
this.** NULLs do not collide in a unique index, but two `''` rows do — without `'' → NULL`, the
second product entered with no barcode would be rejected for a reason no user could act on. The
stripping half matters too: the check has to strip before comparing, or `' 5901234123457'` walks past
the serializer and hits the constraint as a 500.

**The migration clears duplicates before it constrains.** Rows predating this may share a code, and
`AddConstraint` against them fails outright, leaving a half-applied deployment. Within each account
the earliest product keeps the code and the rest go to NULL — the honest answer, since a shared code
means the database cannot say which product it identifies, and a generated suffix would fabricate a
barcode matching no physical label. The cleared products are printed by name so they can be rescanned.
Applied to the local dev database it found one real duplicate and named it.

**A duplicate is a 400 naming the field, not a 500.** DRF cannot generate the validator itself:
`account` is stamped in `perform_create` and is not a serializer field, so it sees `barcode` as
unconstrained — the same trap `AccountUniqueNameMixin` was written for on `name`. Reusing a code is
an everyday mistake (scanning the wrong box, entering a product twice) and belongs under the input.
`ProductForm` already rendered `errors.barcode`; a test now pins that wiring.

`seed_data` draws its 13-digit codes against a set of the ones already taken. Random draws from a
9×10¹² range collide rarely enough that an `IntegrityError` mid-seed would be baffling rather than
instructive.

**`lookupByBarcode`'s `ambiguous` branch is kept**, though a scan can no longer match two products in
one account. It is now the safe response to the database disagreeing — a bulk import, or the
constraint being dropped — and the alternative is silently adding whichever row the API returned
first. Phase 7's `BarcodeLookupFilterTests.test_a_shared_barcode_returns_every_match` was replaced
with one asserting a scan resolves to exactly one product.

Verified: `manage.py test` 290 passed; `npm test` 146 passed; lint and build clean; `seed_data` runs
end to end against the migrated database.

---

## 2026-08-09 — Phase 7: camera barcode scanning

`@zxing/library` behind one `BarcodeScannerModal`, wired into three places: the product form (scan a
code into the field), the order flow (scan to add or increment a line) and the purchase flow (scan to
select a product and fill its cost). Typing a barcode by hand still works everywhere — the camera is
an accelerator, never the only way in, because cameras get denied, break, and are absent on desktops.

**Lookups use `?barcode=` (exact), never `?search=`.** The existing search filter is `icontains` over
name, description *and* barcode. A scanner submits a complete code, so a fuzzy match would resolve to
the wrong product with nothing on screen to reveal it — and these flows add order lines without
confirming each one. `ProductFilter.barcode` is the exact-match filter that backs this.

**A scan can legitimately match several products, and the UI asks rather than guesses.** Phase 4
deliberately left `Product.barcode` indexed but *not* unique, because a shop reuses one code across
loose goods and own-label lines. `lookupByBarcode` therefore returns `found | ambiguous | not_found |
error`, and `ambiguous` renders the matches for the user to pick from. Taking the first row would
silently add the wrong line.

**`not_found` and `error` are kept apart on purpose.** Not-found should send the user to add the
product; error should send them to retry. Collapsing the two has people creating duplicate products
every time the network drops.

**Scan-to-increment in the order flow goes through `maxQuantityFor`** — the same cap Phase 1's stock
validation put on the quantity input. Without it a repeated scan walks past available stock, and the
server rejects the *whole* order at submit time with nothing to indicate which line was at fault. The
purchase flow is deliberately uncapped: a purchase adds stock, so buying four of something you hold
two of is the normal case, not an error.

**zxing is loaded with `await import()` inside the component.** The library is ~450 kB and the app
bundle is already past Vite's size warning. Measured: wiring the first call site moved the entry
chunk 927.0 → 932.0 kB and put the library in its own 451 kB chunk, fetched only when somebody opens
the scanner.

**zxing calls the decode callback with `NotFoundException` on every frame that has no barcode** —
which is nearly all of them. Surfacing that as an error puts the modal into a permanent failure state
one frame after opening, so it is filtered out by name. A `handledRef` guard is the matching trap in
the other direction: one physical barcode decodes across many frames, and without it a single scan
increments an order line several times.

**`getUserMedia` requires a secure context, with `localhost` the only exception.** Opening the Vite
dev server from a phone on the LAN (`http://192.168.x.x:5173`) is therefore silently camera-less,
which reads as a broken feature rather than a platform rule. The modal detects this before touching
the camera and says so, pointing at the type-it-instead path.

**Verified with a mocked decoder, because browser automation is forbidden in this project.** The
tests mock the `@zxing/library` module id — which is what the dynamic import resolves — and drive the
decode callback by hand, covering the duplicate-frame guard, the `NotFoundException` filter, denied
permission, the camera switch, teardown on close, and the insecure-context path. The physical-phone
check is the owner's, by agreement.

**Fixed a pre-existing `CurrencyInput` bug this exposed.** It synced its displayed text only on mount
and on a currency toggle, so filling a line's price from a product left the field reading `0` while
the order total read the real figure. A probe confirmed *manual* product selection had the same bug,
so it predates the scanner. The re-sync deliberately leaves part-typed decimals (`6.`, `6.50`) and
fields the user has emptied alone — fighting the keystroke is why the effect was narrow originally.

`ProductPicker` gained a `selectedName` fallback: it only learns a product's name by being clicked,
so a line filled by a scan would otherwise read "Select product" while holding a real product id.

---

## 2026-08-09 — Phase 6: per-period profit and the dashboard profit sparklines

The analytics `series` gains `total_cogs`, `gross_profit` and `net_profit` per period, and the Gross
profit and Net profit tiles finally draw sparklines.

**Why those two tiles shipped bare in Phase 3.** The summary payload has carried gross and net profit
since then, but the *series* had only revenue, purchases and expenses — no per-period COGS. Drawing
`revenue − purchases` under a tile labelled "profit" would have put the exact conflation this project
spent Phase 3 removing back on screen, in a shape that looks authoritative. Leaving them bare was the
honest option until the data existed. Now it does.

**Revenue and COGS are summed in one `annotate()`.** Both expressions traverse the `items` join;
split across two `annotate()` calls on the same queryset, each multiplies the other's row count. The
same reasoning already governs the summary aggregate, and a test pins the per-period version too.

**`net_profit` is allowed to be negative.** A month with rent and no sales is a loss, and that is the
month most worth seeing on a chart. Verified on the seeded account: 11 of 297 daily periods report a
loss, and they survive the API, the gap-fill and the sparkline unclamped.

**`fillSeriesGaps` names every key explicitly, so it silently drops any it does not name.** A field
added to the series without being added there reads as `undefined` in the chart, `Math.max` returns
`NaN`, every SVG coordinate becomes `NaN`, and the tile renders an invisible line with no error. The
existing exact-match test on the filled row shape is what catches that, and it was extended rather
than loosened when the three new keys landed.

`total_costs` stays the series key for purchases while the summary tile is `inventory_outlays`. Both
are correct in place — the tile sits beside `total_cogs` and the series does not.

Sparklines continue to use the fixed last-7-days daily window, matching the existing revenue and
outlays tiles. Making them follow the All time / Last month / Last year selector was considered and
deliberately deferred: it means restructuring Dashboard's two independent data-loading effects.

---

## 2026-08-09 — CSV export redesign: machine-readable output

A follow-up to Phase 5, redesigning what the four exports actually emit so downstream spreadsheets
and BI tools can consume them without cleanup.

**Money is written bare — no `$`, no thousands separators.** A leading `$` makes a spreadsheet treat
the whole column as text and silently refuse to sum it, which defeats the point of an export. The
separator is the worse half: a comma inside an unquoted numeric cell splits it in two and shifts every
column after it, so a single order over $1,000 would have corrupted the row shape. `csv_format.py`
holds `money()` and `iso()`, imported by both API views and both admin actions — the four exporters
already differ on columns, and formatting was the one thing they must not also differ on.

**The repeating `Total Profit (USD)` column is gone.** Phase 5 kept it and added `Line Profit (USD)`
alongside, on the reasoning that saved formulas pointed at it. That was reversed at the owner's
direction: a BI tool summing a column that repeats each order's profit on every line inflates profit
by the line count — 3.1x on the demo data — and silently producing a wrong number was judged worse
than breaking a formula that would be noticed. A line-level export now carries only line-level figures.

**`Total Units` = `quantity * unit_multiplier`.** The physical count. `Quantity` alone cannot be
summed across lines that use different multipliers, so it is deliberately left out of the totals row
while `Total Units` is totalled.

**`Barcode` sits immediately after `Product Name`**, blank where a product has none — the field is
optional, so a stock list exported for reconciliation has to survive that.

**Dates are ISO 8601 to the second** (`YYYY-MM-DDTHH:MM:SS`) rather than `%Y-%m-%d %H:%M`. The format
changed, not the timezone: both render the stored UTC value.

Two pre-existing tests asserted the old shape — one reading a `$`-prefixed total, one addressing the
now-removed profit column — and were updated. A test now asserts every money cell matches
`^-?\d+\.\d{2}$`, that no row contains a `$` or `,`, and that every row is exactly as wide as the
header, which is the cheap guard against a hand-built footer drifting out of step with the columns.

---

## 2026-08-09 — Phase 5: CSV export totals rows

All four transaction exports now end in a `TOTALS` row: `ExportOrdersCSVView` and
`ExportPurchasesCSVView` (the API views the SPA calls) and the two separate admin actions with
near-identical names. The products catalogue export is deliberately untouched — it is a stock list,
not a transaction ledger, and a total of its price columns would mean nothing.

**The orders export could not simply total its existing profit column.** `Total Profit (USD)` repeats
the *whole order's* profit on every line of that order, so summing it multiplies each order's profit
by its line count. On the seeded demo account that is $8,032,964 against a true $2,609,170 — inflated
3.1x, and plausible enough that nobody would question it.

A new `Line Profit (USD)` column carries each line's own profit, and the totals row is the sum of
that. `Total Profit` was left exactly as it was: it is an existing column and saved spreadsheets and
formulas point at it. The alternative — redefining it in place — would have silently changed the
meaning of a column people already use. The cell beneath `Total Profit` in the totals row is
deliberately blank, because no single figure honestly belongs at the foot of a column of repeated
values.

**Totals are accumulated in the loop that already walks the rows**, never a second query. The orders
export has a standing test that its query count is constant regardless of row count — a fix for an
earlier N+1 — and a totals row computed with its own aggregate would have quietly reintroduced a
per-export query. A new test asserts the count is unchanged as rows grow.

The totals row also applies the *same* filters as the rows above it. A total computed over an
unfiltered queryset would disagree with the rows printed beneath it, which is worse than no total.

One pre-existing test read `row.split(',')[-1]` — "whichever column happens to be last" — and broke
when `Line Profit` was appended. It now addresses columns by header name and excludes the footer,
which is what it meant all along.

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
