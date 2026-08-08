# Phase 2.5 — Secure Onboarding & Payment Gateway

**Date:** 2026-08-08 · **Branch:** `feature/saas-single-db-migration`
**Supersedes:** the 14-day free trial introduced in Phase 2.
**Depends on:** Phase 2 (accounts, account scoping, `HasActiveSubscription`).

## Goal

Nobody reaches the application without a verified email address and a completed payment. Payment is
either a card charge through Paddle (monthly subscription or a one-time lifetime licence) or the
redemption of a 100%-off discount key issued by hand to customers who paid cash, Whish, or OMT.

## Decisions

**Paddle, not Stripe.** Stripe does not onboard Lebanon-registered businesses, and the owner has no
foreign entity. Paddle is a merchant of record: it is the seller, collects the card and the tax, and
pays out — so no Lebanese acquiring relationship is required, and recurring billing plus signed
webhooks come for free. The cost is roughly 5% plus fees and a Paddle-branded receipt.

**A provider interface sits in front of it** (`accounts/billing/`), with a Paddle implementation and a
dummy used by tests and by local development without credentials. Not speculative generality: the
gateway is the single piece of this phase that can be rejected by a third party (see Risks), and the
seam is what makes that a config change instead of a rewrite.

**No trial of any kind.** `Account.TRIAL` and `PLAN_FREE_TRIAL` are deleted, along with `TRIAL_DAYS`
and the trial provisioning in `UserCreateWithAccountSerializer`. A trial is by definition a free
bypass of the wall this phase exists to build.

**The one-time licence is lifetime.** `expires_at` stays `NULL`, which Phase 2's
`has_active_subscription` already reads as "never expires". No new liveness logic.

**Email stays on `auth.User`; `AUTH_USER_MODEL` is not swapped.** Swapping it is a now-or-never
migration against live production users, and nothing here needs it. `username` is set to the
lowercased email and a case-insensitive unique index is added on `auth_user.email` via `RunSQL` —
Django cannot cleanly `AlterField` another app's model. JWT login keeps posting to the same endpoint
with the email as the username; only the frontend label changes.

**Phone lives on `Account`**, not on `User` or `Membership`. It is the billing contact for the
business, and `Membership` is a join row. Not verified this phase — no SMS.

**Discount keys are ours, not Paddle coupons.** A gateway coupon still requires the checkout round
trip, and the requirement is that a key bypass card checkout entirely. Local keys also record the cash
sale in our own database where Phase 3's profit reporting can see it, keep working when the gateway is
down or not yet approved, and are provider-independent.

## Account state machine

`Account.subscription_status` becomes:

| status                 | meaning                                     | app access |
|------------------------|---------------------------------------------|-----------|
| `pending_verification` | row exists, email unproven                  | no        |
| `pending_payment`      | email proven, nothing paid                  | no        |
| `active`               | card charge confirmed, or key redeemed      | **yes**   |
| `past_due`             | renewal charge failed                       | no        |
| `canceled`             | canceled or refunded                        | no        |

`LIVE_STATUSES` narrows to `(ACTIVE,)`. That single change is what enforces the wall: Phase 2's
`HasActiveSubscription` is already the default permission on every endpoint, so a pending account can
authenticate and sees nothing, everywhere, with no new permission checks. This is why the design
creates the account up front rather than inventing a parallel "signup session" table — the account
cannot be charged or verified before it exists, and an inert account is already harmless.

`plan_type` becomes blank-by-default (`''` until a plan is chosen) with choices `monthly` and
`one_time`.

**The deadlock trap.** Every endpoint the user needs *in order to escape* the wall must declare
`permission_classes = [IsAuthenticated]` explicitly, shedding the `HasActiveSubscription` default.
That is: subscription status, resend code, verify code, create checkout, redeem key. Miss one and the
paywall blocks the only route out of the paywall, and the account is unrecoverable without admin
intervention. Every one of these gets a test asserting it is reachable while pending.

## Data model

`accounts/models.py` gains:

**`Account`** — new fields `phone`, `paddle_customer_id`, `paddle_subscription_id`,
`paddle_transaction_id` (all blank by default, for reconciliation against Paddle's dashboard).

**`EmailVerification`** — `user` FK (a row per issued code, kept as history so the hourly send cap and
any abuse investigation have something to count), `code_hash`, `created_at`, `expires_at`, `attempts`,
`consumed_at`. Indexed on `(user, created_at)`.

**`DiscountKey`** — `code` (unique, stored normalized), `percent_off` (default 100), `grants`
(`months` | `lifetime`), `grant_months` (required when `grants='months'`), `max_redemptions`
(default 1), `redemption_count`, `expires_at`, `is_active` kill switch, `amount_paid_usd` and `note`
recording who paid what through which channel, `created_by`, `created_at`.

**`DiscountKeyRedemption`** — `key` FK, `account` FK, `redeemed_at`, unique on `(key, account)`.

**`ProcessedWebhookEvent`** — `provider`, `event_id`, `event_type`, `received_at`, unique on
`(provider, event_id)`. Existence is the idempotency check.

## Flows

### 1. Register

`POST /auth/users/` — djoser's create endpoint, extended with `email`, `phone`, `business_name`.
In one transaction: create `User` (username = lowercased email), `Account`
(`pending_verification`), owner `Membership`, and an `EmailVerification`; then send the code.

The send is deliberately outside the transaction's success path in effect — an SMTP failure is caught,
logged to Sentry, and does **not** fail registration. The account exists and the user can hit resend.
Blocking a signup on a third party's SMTP availability trades a recoverable annoyance for an
unrecoverable one. A background worker is the right long-term answer; there is no queue in this
project and adding one is out of scope.

### 2. Verify email

Both OTP endpoints are **authenticated**. The frontend already logs in immediately after registering,
and login is not subject to `HasActiveSubscription`. Requiring the JWT means only someone already
holding the account's credentials can probe a code — which eliminates account enumeration by
construction, rather than by carefully matching response shapes.

- `POST /accounts/verify-email/` `{code}` → on success sets `pending_payment`, stamps `consumed_at`.
- `POST /accounts/resend-code/` → issues a new code, invalidating outstanding ones.

A six-digit code is one million guesses, which is a few minutes of scripting. Expiry alone does not
protect it. Therefore:

- codes generated with `secrets`, never `random`
- `HMAC-SHA256(SECRET_KEY, code)` at rest, compared with `hmac.compare_digest`. Not PBKDF2: any hash
  of a six-digit space falls instantly to an offline attacker, so the hash's only jobs are to keep the
  code out of logs, backups, and the admin, and to make a database-only leak useless without the
  secret key. The real defence is the two limits below.
- **5 wrong attempts and the code is dead**, resend required
- 10-minute expiry
- resend throttled to 1 per minute and 5 per hour per user — an unthrottled resend endpoint is both an
  email bomb aimed at a third party and a bill

`django-axes` guards login only and does not cover these; they get their own DRF throttle scopes.

### 3. Pay

- `POST /billing/checkout/` `{plan: "monthly" | "one_time"}` → server maps the plan **key** to a
  configured Paddle price id, creates the transaction server-side, returns what Paddle.js needs.
  The client never sends a price, an amount, or a currency. Accepting any of them means someone edits
  the request to one cent.
- `POST /billing/webhook/` — the **only** code path that grants access. It verifies Paddle's
  `Paddle-Signature` header (HMAC-SHA256 over `ts:body` with the webhook secret), rejects unsigned or
  mismatched bodies with 403 before parsing, and records `event_id` in `ProcessedWebhookEvent` — a
  duplicate returns 200 and does nothing, because providers retry and a double-activation would
  double-extend `expires_at`.

Handled events: `transaction.completed` → activate; `subscription.activated` /
`subscription.updated` → push `expires_at`; `subscription.canceled` → `canceled`;
`subscription.past_due` → `past_due`; `adjustment.created` (refund) → `canceled`. Anything else is a
logged no-op.

Monthly renewal sets `expires_at = period_end + SUBSCRIPTION_GRACE_DAYS` (3). Without the grace
window, a webhook that arrives ten minutes late locks a paying customer out at midnight.

The browser's post-checkout redirect **polls account status**. It never reports success. Card data
never touches Django — Paddle's hosted overlay keeps the app out of PCI scope.

### 4. Redeem a key

`POST /billing/redeem-key/` `{code}`. Normalizes the input (uppercase, dashes and spaces stripped —
these get read aloud off WhatsApp), then inside `transaction.atomic`: `select_for_update()` on the key
row, re-check `is_active`, expiry, and `redemption_count < max_redemptions`, create the redemption,
increment the count, activate the account. Without the row lock two concurrent posts both pass the
count check and share a single-use key.

Codes are 12 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — no `0`/`O`, `1`/`I`/`L` — displayed
in dash-separated groups. That is ~10^17 combinations, and redemption attempts are throttled per user
regardless. Unknown, expired, exhausted, and inactive codes all return the same generic 400, so the
endpoint is not a key oracle.

**Scope cut, explicit:** v1 honours `percent_off = 100` only. A partial discount has to go back
through the gateway with a reduced amount, which is a second integration for a case that was not
asked for. Anything less than 100 is rejected at redemption with a clear message; the column exists so
support is additive later. Keys are generated from the Django admin, which is where the owner works.

## Frontend

A three-step wizard, routed rather than modal so a refresh or a returning user resumes correctly:

- `/signup` — email, phone, password, business name. The "Free for 14 days — no card needed" line goes.
- `/signup/verify` — six-digit input, resend with a live cooldown timer.
- `/subscription` — plan cards (monthly vs one-time lifetime), Paddle checkout, and a "Have a discount
  key?" field. This replaces `SubscriptionExpired.jsx` and its `mailto:` button, and doubles as the
  lapsed-subscription screen the Phase 2 axios interceptor already redirects to.

`ProtectedRoute` reads `GET /accounts/subscription/` and routes `pending_verification` →
`/signup/verify`, `pending_payment` / `past_due` / `canceled` → `/subscription`. Paddle.js loads from
Paddle's CDN; that is unavoidable for hosted checkout.

## Configuration

All env-var driven with local-dev fallbacks, matching the existing `ims/settings.py` style. Nothing
committed.

`BILLING_PROVIDER` (`paddle` | `dummy`), `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`,
`PADDLE_PRICE_MONTHLY`, `PADDLE_PRICE_ONE_TIME`, `PADDLE_ENVIRONMENT` (`sandbox` | `production`),
`PADDLE_CLIENT_TOKEN` (public, exposed to the SPA as `VITE_PADDLE_CLIENT_TOKEN`).

Email goes through Resend over plain SMTP (`smtp.resend.com:587`, user `resend`, password = API key),
so Django's existing `EmailBackend` is reused and **no new dependency is added**. The current
smtp4dev defaults stay as the local fallback.

## Testing

Django test runner and Vitest only — no browser, per project policy. Paddle is exercised through the
dummy provider and synthetic signed payloads; the sandbox is used for manual checks.

Backend: OTP correctness, attempt cap, expiry, replay, plaintext-absence, resend cooldown and hourly
cap. Paywall coverage for both pending states across inventory endpoints, plus an explicit test per
escape-hatch endpoint proving it is reachable while pending. Webhook signature rejection, replay
no-op, per-event-type outcomes, and grace-window arithmetic. Checkout ignoring client-supplied
amounts and rejecting unknown plan keys. Key redemption: activation, month-granting, expired,
inactive, exhausted, double-redemption by the same account, concurrent redemption of a single-use key,
generic error parity, and that the cash amount is recorded. Plus a test asserting no code path
produces a trial account.

Frontend: the verify step's cooldown and error states, plan selection, and `ProtectedRoute` routing
per status.

## Sequencing

**2.5a — identity and email verification.** Ships independently and needs no third party beyond
Resend.

**2.5b — payments and discount keys.** Needs live Paddle credentials.

Split because Paddle approval takes days to weeks; as one phase, all of it would sit blocked in a
compliance queue. Discount keys land in 2.5b but do not depend on Paddle, so a cash-only business is
fully operational at the end of 2.5b even if card payments are still pending approval.

## Risks

**Paddle may not accept a Lebanon-based seller.** This is the top risk and it must be validated before
2.5b is built, not after. Paddle is a merchant of record and maintains a supported-seller-country
list; Lebanon's banking status makes it a real possibility that onboarding or payout is refused.
Validate by applying — sandbox access is available immediately and unblocks all development either
way. Paddle also requires a live site with terms, privacy, and refund policies before approval.

**The mitigation already exists in this design.** The discount-key system is a complete manual billing
path: the owner collects cash, Whish, or OMT, generates a key from the admin, and the customer
activates. If Paddle refuses, the business still runs and the loss is card convenience, not the
product. This is the main reason keys are local rather than gateway coupons.

**Synchronous email** on a request thread is a latency and failure surface. Mitigated by not failing
signup on send errors; a proper fix is a worker queue, out of scope.

## Out of scope

SMS or phone verification. Partial-percentage discount keys. Multiple users per account. Dunning
emails and failed-payment retries beyond the `past_due` status. Invoice PDFs. Plan upgrades,
downgrades, and proration. Refund handling beyond marking the account canceled. Any deployment: this
phase changes signup and billing, and goes to production only under separate, explicit authorization.
