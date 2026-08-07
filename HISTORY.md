# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

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
