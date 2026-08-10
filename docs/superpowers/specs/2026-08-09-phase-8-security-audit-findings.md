# Phase 8 — Security audit findings (baseline)

**Scanned:** 2026-08-10, branch `phase-3-expenses` at `9c30cd5`
**Scope:** `inventory/`, `accounts/`, `ims/` (Python) and `frontend/src/` (JS/JSX). Excludes
`node_modules/`, `frontend/dist/`, `.claude/`.

This is the **baseline**: written before any code was changed, so the report is a record of what the
scanners actually said rather than a description of an already-fixed codebase. Fixes and their
regression tests land in later commits and are cross-referenced from each finding.

## Tooling

| Tool | Version | Invocation | Result |
|---|---|---|---|
| `pip-audit` | 2.10.1 | `pip-audit --progress-spinner off` | 3 CVEs, all in tooling — see F-02 |
| `bandit` | 1.9.4 | `bandit -r inventory accounts ims` | 93 findings, all LOW — see F-04, F-05 |
| `npm audit` | npm 12.0.1 | `npm audit --json` | 0 vulnerabilities — see F-03 |
| `semgrep` | 1.172.0 | 5 registry rulesets, 256 rules over 186 files | 5 findings — see F-01 |
| `manage.py check --deploy` | Django 6.0.8 | `DJANGO_DEBUG=False` | 1 warning — see F-06 |

**Deviation from the plan:** the plan specifies `semgrep --config=auto`. Semgrep refuses `auto` when
metrics are disabled (`Cannot create auto config when metrics are off`), and `auto` would have sent
scan telemetry about this project to semgrep.dev. Explicit rulesets were used instead —
`p/python`, `p/django`, `p/javascript`, `p/react`, `p/secrets` — which cover the same ground for this
stack deterministically and send nothing. Rule *downloads* still contact the registry; no source code
leaves the machine either way.

**Also verified:** installing the tooling did not relock the project. `Pipfile` and `Pipfile.lock` are
unchanged, and Django is still 6.0.8 with DRF 3.17.2 — the drive-by-upgrade trap recorded in the
Working Log did not fire.

---

## F-01 — CSV formula injection in 4 of the 5 export paths · **MEDIUM** · fix

**Where:** `inventory/views.py:413`, `:431`, `:490`, `:504`; `inventory/admin.py:117`, `:146`
**Found by:** semgrep `python.django.security.audit.csv-writer-injection` (5 hits; the admin actions
were found by follow-up reading, not by the scanner)

A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula when the CSV is opened in
Excel, LibreOffice or Google Sheets. Every export writes user-controlled text — product names,
customer and supplier names, barcodes — straight into the file.

`inventory/views.py:290` already defines `_csv_safe`, and it is **only applied to the three cells of
the products export**. The orders export, the purchases export and both admin actions do not use it.
This is the exact failure mode `CLAUDE.md` warns about — "a formula fix usually needs both" — and the
root cause is placement: `_csv_safe` sits in `views.py`, so `admin.py` cannot reach it, while the
shared `csv_format.py` that exists precisely for this holds only `money()` and `iso()`.

**Why it is not merely self-inflicted.** For a single-user account the attacker and the victim are
the same person. Two paths cross a real boundary:

1. `Membership` allows several users per account, so an employee can poison a name the owner exports.
2. **The admin actions are opened by the platform superadmin**, and their rows span *every* account.
   Any subscriber can name a customer `=HYPERLINK("http://attacker","Click")`, wait for the platform
   owner to export, and attack them. That is subscriber → platform escalation.

**Proposed action:** move the escaping into `csv_format.py` beside `money()`/`iso()` and apply it to
every user-controlled text cell in all four exporters.

**Trap to avoid while fixing:** the escape list contains `-`, and `money()` returns `-5.00` for a
negative line profit. Applying the text escape to money cells would emit `'-5.00`, turning the
numeric columns back into text and undoing the export redesign that made them summable. The escape
must apply to text cells only — never to `money()` or `iso()` output, which this code generates
itself and which is never user input.

---

## F-02 — `pip-audit` CVEs belong to the scanner, not the app · **INFO** · no action

```
mcp 1.23.3  PYSEC-2026-3482 / PYSEC-2026-3483 / PYSEC-2026-3481
```

`mcp` is not a project dependency. It appears in the virtualenv because **semgrep pins
`mcp==1.23.3`** — it arrived with the tooling installed for this phase. Confirmed two ways: `mcp`
appears in neither `Pipfile` nor `Pipfile.lock`, and re-running `pip-audit` against only the
project's declared dependencies reports **"No known vulnerabilities found"**.

Recording it so a future scan does not rediscover it as an application problem. It goes away if the
audit tooling is uninstalled.

---

## F-03 — `npm audit` is clean; the Working Log entry is stale · **INFO** · docs fix

`npm audit` reports **0 vulnerabilities at every severity**. The Working Log in `CLAUDE.md` says:

> `react-router-dom` has 2 open high-severity advisories (`npm audit`). `npm audit fix --force`
> downgrades to 7.11.0, a breaking change — left alone deliberately.

That is no longer true. The installed version is **7.18.2** and it is not subject to any current
advisory; the issue was resolved upstream rather than by anything done here. The note should be
removed, not carried forward — a stale "known vulnerability" note costs a re-investigation every time
someone reads it.

---

## F-04 — bandit B105/B106 "hardcoded password" (≈78 hits) · **LOW** · accepted, no action

Every hit is one of:

- **Test fixtures** — `pw12345!`, `brandNewPw!2026`, `victimPw123!` in `accounts/tests.py` and
  `inventory/tests.py`. Test passwords for throwaway users in an ephemeral test database.
- **False positives on non-password constants** — the string `'password_reset'` (an
  `EmailVerification.purpose` value, `accounts/models.py:127`), the throttle rates `'10/hour'` and
  `'30/hour'` (`ims/settings.py:251-252`), the djoser serializer path on the line after
  `user_create_password_retype`, and the validation message *"The two passwords do not match."*
  Bandit flags these because the assigned name or neighbouring key contains "password".

One is worth stating rather than dismissing: `ims/settings.py:161` sets `'PASSWORD': ''` in the
`DATABASES` default. That is the **local-dev** Postgres block, and it is overwritten wholesale by
`dj_database_url` when `DATABASE_URL` is set, which it always is on Heroku. It is not a credential
and there is no credential in the repository.

No suppression comments were added. Silencing 78 warnings would need `# nosec` on 78 lines, which is
more noise in the source than the warnings are in a report nobody runs weekly.

---

## F-05 — bandit B311 `random` in `seed_data.py` (15 hits) · **LOW** · accepted, no action

All fifteen are in `inventory/management/commands/seed_data.py`, a development-only management
command that fabricates demo products, prices and dates. Nothing it generates is a secret.

**Verified rather than assumed** — the claim worth checking is not "is this file fine" but "does any
security-relevant code use `random`". It does not:

- `grep` for `import random` outside tests matches **only** `seed_data.py`.
- `accounts/verification.py` (OTP codes) uses `secrets.randbelow`.
- `accounts/billing/keys.py` (discount keys) uses `secrets.choice`.

---

## F-06 — `SECRET_KEY` and `DEBUG` fail *open* when unset · **MEDIUM** · needs a decision

**Where:** `ims/settings.py:52` and `:60`

```python
SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'django-insecure-(#!tfz4=…')
DEBUG = os.environ.get('DJANGO_DEBUG', 'True')… not in ('false', '0', 'no')
```

Both default to the *unsafe* value. Deployed without `DJANGO_SECRET_KEY`, the app runs on a key
committed to this repository — and since `SIMPLE_JWT` has no separate `SIGNING_KEY`, that key signs
every JWT, so anyone reading the source can mint a token for any user. Confirmed with
`manage.py check --deploy`, which reports `security.W009` with the variable unset and `DEBUG=False`.

Everything else in `check --deploy` passes: HSTS, SSL redirect, secure and HTTP-only cookies, and
`X_FRAME_OPTIONS` are all correctly configured by earlier hardening. W009 is the only warning.

**This is a deployment-configuration risk, not a code defect** — production may well have both set,
and `CLAUDE.md` records that Heroku sets `DJANGO_DEBUG=False` explicitly. What is unknown from here
is whether `DJANGO_SECRET_KEY` is set on Heroku.

**Proposed action, and why it is not being taken unilaterally:** the obvious hardening is to refuse
to boot when `DEBUG` is False and `SECRET_KEY` is still the committed default. That converts a silent
insecurity into a loud failure — but if the live deployment is *currently* running on the default
key, shipping that check takes production down on the next release. Rotating `SECRET_KEY` also
invalidates every session and JWT immediately, which `ims/settings.py:48-51` already warns about at
length. **Owner decision required:** confirm whether `DJANGO_SECRET_KEY` is set on Heroku before the
boot guard is added.

---

## F-08 — Nested product-image route was unscoped · **HIGH** · fixed

**Where:** `inventory/views.py:26` (`ProductImageViewSet`)
**Found by:** the Task 8.2 isolation matrix. **No scanner found this** — not semgrep, not bandit.
It needed a test that actually crossed the tenant boundary.

```python
account_lookup = 'product__account'          # declared…

def get_queryset(self):
    return ProductImage.objects.filter(product_id=self.kwargs['product_pk'])   # …never reached
```

The override replaced `AccountScopedMixin.get_queryset()` instead of chaining through it, so the
only filter applied was the product id **taken from the URL**. Product ids are sequential integers.
Any authenticated subscriber could therefore walk `/inventory/products/<n>/images/` across the whole
platform and, for every other account's products:

- **list** their images (confirmed: HTTP 200 with rows, not 404),
- **attach** an image to another account's product (confirmed: the POST succeeded),
- and, by the same queryset, retrieve and **delete** individual images.

This is the exact failure mode `CLAUDE.md` warns about — "scoping is two independent halves" — with a
third half this codebase had not written down: a viewset that *overrides* `get_queryset` silently
opts out of the mixin, and the declared `account_lookup` gives a false impression of coverage while
doing nothing.

**Severity HIGH** rather than MEDIUM: cross-tenant read *and* write, reachable by any subscriber with
no special knowledge beyond an incrementing integer.

**Fixed** in the same commit as its regression tests — `get_queryset` now chains through `super()`,
and `perform_create` resolves the parent product through the account-scoped queryset, 404ing on a
foreign one. Tests:
`TenantIsolationMatrixTests.test_another_accounts_product_images_are_not_listable` and
`…test_an_image_cannot_be_attached_to_another_accounts_product`.

---

## F-07 — `CORS_ALLOW_ALL_ORIGINS = True` · **MEDIUM** · fixed in Task 8.3

**Where:** `ims/settings.py`

Known and previously documented as a deliberate dev-only setting. Task 8.3 makes it
`CORS_ALLOW_ALL_ORIGINS = DEBUG` with an environment-driven allowlist. Recorded here so the baseline
is complete, not because it was a discovery.

---

## Summary

| ID | Severity | Status |
|---|---|---|
| F-01 CSV formula injection | MEDIUM | fix in this phase |
| F-02 `mcp` CVEs (tooling) | INFO | no action |
| F-03 stale `react-router-dom` note | INFO | docs fix |
| F-04 bandit hardcoded-password | LOW | accepted |
| F-05 bandit `random` in seeder | LOW | accepted |
| F-06 `SECRET_KEY`/`DEBUG` fail open | MEDIUM | **owner decision** |
| F-07 CORS wide open | MEDIUM | fix in Task 8.3 |
| F-08 nested image route unscoped | **HIGH** | fixed |

**Two real code defects** (F-08, F-01), one **deployment question for the owner** (F-06), one planned
hardening (F-07), one documentation correction (F-03). Everything else is noise from the scanners.

**The most serious finding came from a test, not a scanner.** F-08 is cross-tenant read and write,
and semgrep, bandit and pip-audit were all silent on it — an authorization bug looks like ordinary
ORM code. The scanners earned their place on F-01, which reading had missed for four phases; the
matrix earned its place on F-08. Neither would have found the other.
