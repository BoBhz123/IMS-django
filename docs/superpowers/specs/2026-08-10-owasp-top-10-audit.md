# OWASP Top 10 (2021) audit

**Date:** 2026-08-10 · **Branch:** `phase-3-expenses` · **Baseline commit:** `44d365b`
**Scope:** Django backend (`inventory/`, `accounts/`, `ims/`, `playground/`) and the React SPA
(`frontend/src/`).

Follows the Phase 8 audit
(`2026-08-09-phase-8-security-audit-findings.md`), which this extends per-category rather than
repeats. Controls are asserted by **behaviour** wherever possible — a scanner can see
`SECURE_HSTS_SECONDS`, but only a request shows what header the browser actually gets.

## Method

| Tool | Invocation | Result |
|---|---|---|
| semgrep | `p/owasp-top-ten`, `p/django`, `p/react`, `p/secrets`, `p/command-injection`, `p/sql-injection`, `p/xss`, `p/insecure-transport` — 281 rules, 187 files | 5 findings, all the same already-fixed CSV rule (see A03) |
| bandit | `-r inventory accounts ims` | 93, all LOW, all triaged in the Phase 8 report |
| pip-audit | against `Pipfile.lock` `default` only | 0 |
| npm audit | `frontend/` | 0 |
| `manage.py check --deploy` | `DEBUG=False` + real key | **0 issues** (was 1) |
| custom tests | `inventory.tests.OWASPControlTests` (32) + `SecretKeyBootGuardTests` (3) + `SPASecurityHeaderTests` (2) | — |

**Automated scanning found nothing new.** That is the headline result and it is not a
reassurance: the two genuine gaps below (A05 missing CSP, A09 no audit trail) and Phase 8's
worst finding (an unscoped nested route) were all invisible to every scanner run. Scanners
find *sinks*; they do not find missing controls or broken authorization.

---

## A01 — Broken Access Control · **PASS**

Covered exhaustively by `TenantIsolationMatrixTests` (Phase 8): every scoped collection ×
{list, retrieve, PATCH, DELETE, POST-with-foreign-FK}, driven from a resource list so a new
endpoint that skips scoping fails a test. Phase 8 found and fixed one real cross-tenant
read/write hole here (`ProductImageViewSet`).

Added this pass:

- **djoser's user endpoints probed directly.** `/auth/users/` mounts a full ModelViewSet, so
  if it listed every user the platform's entire customer roster would be readable by any
  subscriber. It does not: the list returns only the caller, another user by id is 404,
  PATCH is 404, DELETE is 403. Now pinned by
  `test_a01_the_user_endpoint_lists_only_the_caller` and
  `test_a01_another_users_account_cannot_be_read_or_changed`.
- **No existence oracle.** A foreign row and a nonexistent row return *identical* statuses
  (404). A 403 on the foreign row would confirm it exists across the tenant boundary.

**Accepted, documented:** there is no per-user role model within an account —
`Membership.is_owner` exists but every member currently has full access to the account's
data. That is correct for a single-operator business and becomes a gap the moment staff
logins are handed out. It is a design limit, not a defect.

---

## A02 — Cryptographic Failures · **PASS** (one accepted risk)

- OTP codes: `secrets.randbelow`, HMAC-SHA256 at rest, `hmac.compare_digest` to compare.
  Discount keys: `secrets.choice`. Asserted structurally by
  `test_a02_codes_and_keys_are_generated_with_secrets_not_random`, because `random` is a
  Mersenne Twister whose state is recoverable from observed output.
- No password material, hash, or `code_hash` appears in any API response
  (`test_a02_no_password_material_is_ever_serialized`). The OTP is never echoed back
  (`test_a02_the_otp_is_never_returned_in_a_response`).
- The audit log deliberately carries identifiers only — never a code, token or password
  (`test_a09_the_audit_trail_never_carries_a_credential`).
- **JWT signing key isolation: fixed this pass.** `SIMPLE_JWT` has no separate `SIGNING_KEY`,
  so `SECRET_KEY` signs every token. That made the fail-open default (Phase 8 F-06) a
  token-forgery risk, not merely a session-invalidation one. The app now **refuses to boot**
  when `DEBUG` is off and `SECRET_KEY` is still the committed default.

**⚠️ Accepted risk — JWTs are stored in `localStorage`.** Any successful XSS is therefore a
full account takeover: the token can be read and exfiltrated by script. The structural fix is
`HttpOnly` cookies, which is a substantially larger change (CSRF handling, the axios
interceptor, the token store, the refresh flow). The CSP added under A05 reduces the blast
radius and is **mitigation, not a solution**. Recorded here so it is a known accepted risk
rather than an oversight.

---

## A03 — Injection · **PASS**

Swept and clean, with `grep` over `inventory/`, `accounts/`, `ims/`:

| Vector | Result |
|---|---|
| `.raw()`, `.extra()`, `RawSQL`, `connection.cursor()` | **none** — every query goes through the ORM |
| `subprocess`, `os.system`, `eval`, `exec`, `__import__`, `popen` | **none** |
| `pickle`, `yaml.load`, `marshal`, `shelve` | **none** |
| `dangerouslySetInnerHTML`, `innerHTML`, `new Function` | **none** in `frontend/src` |

Behavioural checks: a SQL metacharacter payload in `?search=` is treated as text and the table
survives; a `<script>` tag in a category name round-trips as *data*, byte-identical — the API
is JSON and React escapes by default, and silently mangling a legitimate name would be its own
bug.

**semgrep's 5 remaining `csv-writer-injection` hits are stale.** They point at `writerow`
calls whose cells now pass through `csv_format.text()`; the rule matches the sink and cannot
see the sanitizer. Verified by `CSVFormulaInjectionTests` instead, which asserts no cell in
any of the five exports opens with a formula character — the assertion the rule is a proxy
for.

---

## A04 — Insecure Design · **PASS**

Throttles, all asserted present by `test_a04_sensitive_endpoints_declare_a_throttle`:

| Action | Limit |
|---|---|
| Login | `django-axes`, 5 failures, 1h cooloff, by username **and** IP |
| Verify email | 30/hour + 5 wrong guesses kills the code |
| Resend code | 10/hour endpoint, 1/min + 5/hour per code |
| Password reset request | 10/hour |
| Password reset verify/confirm | 30/hour (one scope — both take the same credential) |
| Redeem discount key | 20/hour |
| CSV exports | 30/hour, one shared scope |

**`django-axes` guards login and nothing else.** It never sees the OTP, billing or export
endpoints. Restated because "we have django-axes" reads like blanket rate limiting.

Transaction controls: order creation validates stock, re-reads under `select_for_update()`
inside `@transaction.atomic`, and deducts with `F()` expressions — the Phase 1 fix for the
concurrent-order race. Asserted structurally plus behaviourally
(`test_a04_an_order_beyond_stock_is_refused`).

---

## A05 — Security Misconfiguration · **2 FIXED**

**Fixed: no Content-Security-Policy.** There was none. Given JWTs in `localStorage` (A02),
CSP is the control limiting what an XSS can do, so its absence mattered more here than it
would in a session-cookie app. Added `ims/security_headers.py` — hand-rolled rather than
`django-csp`, because adding a dependency means `pipenv install`, which relocks, and this repo
has had a relock silently bump Django and DRF before.

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis.com;
font-src 'self' fonts.gstatic.com data:; img-src 'self' data: blob: <R2 domain>;
connect-src 'self' <sentry>; media-src 'self' blob:; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'
```

Two things were checked rather than assumed before shipping it:

- **The Django 6 admin emits zero inline `<script>` blocks and zero inline event handlers**,
  so `script-src 'self'` does not break the admin the owner uses to issue discount keys.
  Probed directly across three admin pages.
- **The built `index.html` loads Google Fonts** from `fonts.googleapis.com` (stylesheet) and
  `fonts.gstatic.com` (files). Omitting either renders the app in a fallback face.

`'unsafe-inline'` remains in `style-src` and is not removable today: framer-motion writes
inline styles every frame, and nonces cannot cover style *attributes*. Stated rather than
quietly tolerated. `CSP_REPORT_ONLY=1` switches to report-only for rolling out a policy change
against a live deployment.

**Fixed: no Referrer-Policy.** Now `strict-origin-when-cross-origin`; without it, product and
order ids in the URL path leak to any third-party origin the browser is sent to.

Already correct, verified on a real response: `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, HSTS 1 year with subdomains and preload, SSL redirect, CORS
(fixed in Phase 8). `manage.py check --deploy` now reports **0 issues**.

`debug_toolbar` is absent from both `INSTALLED_APPS` and `MIDDLEWARE` when `DEBUG=False`,
verified in a subprocess.

**⚠️ Latent risk recorded, not currently exploitable — `playground.views.say_hello`.** It
reads `Order.objects` with **no account filter and no authentication**: every account's orders,
to anyone. It is unreachable today because `playground.urls` is never `include()`d in
`ims/urls.py`. `test_a05_the_playground_scratch_view_is_not_routed` is the tripwire — the view
is one innocuous-looking line of `urls.py` away from being a cross-tenant data leak. Deleting
the app outright is the better fix and is left as the owner's call, since it is their scratch
space.

---

## A06 — Vulnerable & Outdated Components · **PASS**

`pip-audit` against `Pipfile.lock`'s `default` section: **0**. `npm audit`: **0** at every
severity. `test_a06_no_declared_python_dependency_has_a_known_cve` now runs pip-audit in CI-able
form so a vulnerable pin fails the suite.

Two notes carried from Phase 8, both still true: the only `pip-audit` hits in the virtualenv
are three CVEs in `mcp`, which **semgrep itself pins** and which is not a project dependency;
and the `react-router-dom` advisories the Working Log described as open were resolved upstream
(7.18.2 is clean).

---

## A07 — Identification & Authentication Failures · **PASS**

- **Password change invalidates every outstanding refresh token** — verified end to end: a
  token minted before the reset returns 401 at `/auth/jwt/refresh/` after it. Without this,
  resetting a compromised account locks out nobody, since a refresh token is valid 30 days.
- **Logout blacklists the refresh token**, verified the same way.
- **Brute force**: `AXES_FAILURE_LIMIT` failures then the *correct* password is also refused —
  which is what proves a lockout rather than a rejected guess.
- **Registration enforces Django's `AUTH_PASSWORD_VALIDATORS`**; `12345` is refused and no user
  row is created. The password reset flow runs the same validators.
- OTP endpoints are authenticated, so there is no unauthenticated route that behaves
  differently for a registered address than an unregistered one — no enumeration oracle.

**Known limit, unchanged:** access tokens already issued stay valid for their remaining
lifetime after a password change (1 day max). Revoking them needs a per-request revocation
check, which is a real architectural change; stated rather than left as a silent gap.

---

## A08 — Software & Data Integrity Failures · **PASS**

No unsafe deserialization anywhere (see A03). Uploads tested adversarially, all rejected:

| Payload | Result |
|---|---|
| PHP source named `payload.jpg`, `Content-Type: image/jpeg` | **400** — the declared type is not believed; Pillow must open it |
| SVG containing `<script>` | **400** — would be stored XSS if served from the media origin |
| 2 MB+ file | **400** — `validate_file_size` |
| Filename `../../../../etc/evil.gif` | **201**, stored inside `inventory/images/<account_id>/` with no `..` in the path |

**Webhooks: none exist.** Paddle's signed webhook is Phase 2.5b-2 and is not written. When it
lands, the signature must be verified *before* parsing and `event_id` recorded for idempotency
— already specified in the 2.5b design, restated here because it is the A08 control this app
will eventually need.

---

## A09 — Security Logging & Monitoring Failures · **FIXED**

**There was no security audit trail at all** — no `LOGGING` config, and no record of who
deleted what. Deletions are irreversible here (no soft-delete), so "the customer list is
missing rows" had no answer.

Added `accounts/audit.py` and a `LOGGING` block wiring three channels to stdout:
`ims.security` (ours), `django.security` (Django's suspicious-operation channel), and `axes`
(every failed and locked-out login).

Logged now:

| Event | Where |
|---|---|
| `record_deleted` — model, pk, user, account | `AccountScopedMixin.perform_destroy` — one override covering every scoped collection |
| `password_changed` — with the count of revoked sessions | `PasswordResetConfirmView` |
| `email_verified` | `VerifyEmailView` |
| `subscription_granted_by_key` — key **id**, never the code | `RedeemKeyView` |
| failed / locked-out logins | `axes`, now given a handler |
| admin changes | Django's built-in `LogEntry`, already present |

Two details worth the words. The pk is captured **before** the delete and logged **after** it:
Django's collector sets `instance.pk = None` on the way out, so reading it afterwards records
`pk=None` — and logging beforehand would record deletions that never happened, since a PROTECT
foreign key raises and becomes a 409. `test_a09_a_failed_delete_is_not_logged_as_a_deletion`
pins that. And the trail carries identifiers only, never a credential.

**Stated plainly: this is an audit *trail*, not tamper-evident audit *storage*.** It goes to
stdout, which Heroku captures and Sentry forwards from WARNING up; anyone with dyno access can
write to it. That is the right level for a single-operator business tool and the wrong level
for a compliance obligation.

---

## A10 — Server-Side Request Forgery · **PASS (no attack surface)**

There is no outbound HTTP client anywhere in the application packages — no `requests`,
`urllib.request`, `urlopen`, `httpx` or `http.client`. SSRF needs a fetcher and there is none.
`test_a10_the_app_makes_no_outbound_http_request_from_user_input` asserts this by scanning the
source, so adding a client becomes a deliberate act reviewed against this test rather than a
quiet import.

The one URL-shaped surface is `ExternalOrLocalImageField`, which returns a stored name verbatim
when it starts with `http(s)://`. A client cannot write one: the API accepts an uploaded file
and the stored name is built by `upload_to`. Posting a URL string to the image endpoint is a
400 (`test_a10_an_image_url_cannot_be_set_through_the_api`); the absolute-URL path exists only
for `seed_data`'s CDN placeholders.

Outbound SMTP goes to a configured host, never a user-supplied one.

---

## Summary

| Category | Verdict | Action |
|---|---|---|
| A01 Broken Access Control | PASS | matrix extended to djoser endpoints |
| A02 Cryptographic Failures | PASS | **JWT signing key boot guard shipped**; localStorage risk accepted + documented |
| A03 Injection | PASS | no sinks; stale semgrep hits explained |
| A04 Insecure Design | PASS | throttle coverage asserted |
| A05 Security Misconfiguration | **2 FIXED** | CSP + Referrer-Policy added |
| A06 Vulnerable Components | PASS | 0 CVEs, now enforced by a test |
| A07 AuthN Failures | PASS | JWT invalidation verified end to end |
| A08 Integrity Failures | PASS | uploads tested adversarially |
| A09 Logging Failures | **FIXED** | audit trail added |
| A10 SSRF | PASS | no fetcher exists |

**Fixed this pass:** the `SECRET_KEY` boot guard (A02), CSP and Referrer-Policy (A05), and the
security audit trail (A09).

**Accepted risks, deliberately:** JWTs in `localStorage` (A02 — CSP mitigates, `HttpOnly`
cookies are the real fix), `'unsafe-inline'` in `style-src` (A05 — blocked on framer-motion),
access tokens outliving a password change by up to a day (A07), no intra-account roles (A01),
and the unrouted `playground` scratch view (A05 — tripwired by a test; deleting the app is the
owner's call).

**No high or medium severity finding was left unfixed.**
