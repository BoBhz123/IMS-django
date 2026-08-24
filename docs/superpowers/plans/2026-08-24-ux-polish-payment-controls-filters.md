# Implementation plan — UX polish, payment controls, filter consolidation

**Spec:** `docs/superpowers/specs/2026-08-24-ux-polish-payment-controls-filters-design.md`
**Branch:** `feature/phase-a-payments-currency-simplify`

Ordered so each step leaves the suite green. Foundations first (they have no dependents), then the
defect fixes, then the features that build on them, then the pages.

Baseline before starting: Vitest 358/358 pass; Django 651/652 pass, the one failure being the
pre-existing `pip-audit` / `sqlparse` advisory, which is out of scope.

---

## Step 1 — Body-scroll refcount in `overlayStack`

**Files:** `frontend/src/lib/overlayStack.js`, `frontend/src/hooks/useOverlayLayer.js`,
`frontend/src/components/ui/Modal.jsx`, `frontend/src/components/ui/SlideOver.jsx`,
`frontend/src/lib/overlayStack.test.js`

Add `acquireScrollLock()` / `releaseScrollLock()` to `overlayStack.js`, refcounted, setting
`document.body.style.overflow = 'hidden'` on 0→1 and restoring the *previously saved* value on
1→0. Save the original value on first acquire rather than assuming `''`.

`useOverlayLayer` acquires on open and releases on cleanup. `Modal` and `SlideOver` drop their own
`document.body.style.overflow` lines; their Escape listeners stay.

Extend `resetOverlayStack()` to zero the count, or every later test leaks a locked body.

Tests: nested acquire/release keeps the lock until the last release; out-of-order release still
balances; the original inline style is restored, not blanked.

---

## Step 2 — `lib/payment.js`

**Files:** `frontend/src/lib/payment.js` (new), `frontend/src/lib/payment.test.js` (new)

```
PAYMENT_STATUS = { PAID, PARTIALLY_PAID, UNPAID }
remainingFor(total, status, paidAmount) -> number, clamped at 0
paidFor(total, status, paidAmount)      -> number actually settled
paymentPayload(status, paidAmount)      -> { payment_status } | { payment_status, paid_amount }
```

`remainingFor` clamps at zero to match the server's `remaining_amount` property — overpayment is
routine cash rounding here and must not render as a refund owed.

`paymentPayload` omits `paid_amount` for PAID and UNPAID: the server derives both from the total it
computed itself, and sending a browser-side figure lets a stale total win.

Tests: all three states, overpayment clamp, zero total, payload shape per state.

---

## Step 3 — `lib/buttonStyles.js`

**Files:** `frontend/src/lib/buttonStyles.js` (new)

Export `btnPrimary`, `btnSecondary`, `btnGhost`, `btnIcon` class strings — `rounded-xl`,
consistent hover/active/disabled and focus-visible rings. No test; it is data, and pinning class
strings to a test only makes them harder to tune.

---

## Step 4 — `useProductLookups` + `ProductForm` prop fix  *(defect A)*

**Files:** `frontend/src/hooks/useProductLookups.js` (new),
`frontend/src/components/forms/ProductForm.jsx`,
`frontend/src/components/forms/ProductForm.test.jsx`

Hook fetches `/inventory/categories/` and `/inventory/suppliers/` when enabled, aborting on
unmount. `ProductFormBody` uses the props when supplied, the hook when not — so `Products.jsx` is
unaffected and the quick-create path gets real, selectable categories.

Test: rendering `ProductForm` with no `categories`/`suppliers` prop does not throw and populates
the category select from the fetch.

---

## Step 5 — `PaymentBadge` due amount

**Files:** `frontend/src/components/ui/PaymentBadge.jsx`,
`frontend/src/components/ui/PaymentBadge.test.jsx` (new)

Optional `remaining` + `formatAmount`. When both are present and the status is `PARTIALLY_PAID`,
render `Partial ($48.00 due)`; otherwise the plain label. Keep the icon per state.

---

## Step 6 — `FilterPopover`

**Files:** `frontend/src/components/ui/FilterPopover.jsx` (new),
`frontend/src/components/ui/FilterPopover.test.jsx` (new)

Trigger button ("Show filters", filter icon, active-count badge) + anchored panel. Props:
`activeCount`, `onClear`, `children`. Escape via `useOverlayLayer().isTop()`; outside click via a
`pointerdown` listener bound only while open; re-clicking the trigger toggles.

Tests: panel hidden until clicked; count badge renders; Escape closes; outside click closes;
`onClear` fires.

---

## Step 7 — Payment controls on `OrderForm` and `PurchaseForm`

**Files:** `frontend/src/components/forms/OrderForm.jsx`,
`frontend/src/components/forms/PurchaseForm.jsx`, plus their existing test files

Segmented control above the total, defaulting to `PAID` for a new transaction and hydrating from
`order.payment_status` / `purchase.payment_status` on edit. The `paid_amount` `CurrencyInput` and
the remaining-balance line render only for `PARTIALLY_PAID`.

Submit spreads `paymentPayload(...)` into the existing payload. Block submit when the state is
`PARTIALLY_PAID` and the amount is empty or not a positive number — the server 400s on it, and a
client-side check keeps the message next to the field.

---

## Step 8 — Fluid product selection  *(requirement 4, remainder)*

**Files:** both transaction forms, `frontend/src/components/forms/ProductSearchModal.jsx`,
plus their test files

- `items` starts `[]`; delete the `emptyItem()` seed from `useState`. Keep the `emptyItem()`
  helper — `applyScannedProduct` still spreads it to build a line.
- Empty-state prompt in the items area.
- Remove button loses its `items.length > 1` guard.
- `ProductSearchModal.onSelect` closes the modal; update the "stays open on purpose" comment to
  record the 2026-08-24 reversal.
- Quick-create: pass through, and on save add the product and close the picker too.
- Existing tests that assert a seeded blank row get updated.

---

## Step 9 — Backend `payment_status` filter

**Files:** `inventory/filters.py`, `inventory/tests.py`

Add `'payment_status': ['exact']` to `OrderFilter.Meta.fields` and `PurchaseFilter.Meta.fields`.
Test: filtering returns only matching rows, and only the caller's account's rows.

---

## Step 10 — Pages: popovers, badges, polish

**Files:** `frontend/src/pages/Orders.jsx`, `Purchases.jsx`, `Products.jsx`, `Expenses.jsx`

Per the spec's table: move filters into `FilterPopover`, keep the primary and export buttons
outside. Orders/Purchases gain the payment-status filter and a `Payment` column (table + mobile
cards) using `PaymentBadge`. Apply `buttonStyles`.

Fix `Orders.jsx::openInvoice` to carry `payment_status`, `paid_amount` and `remaining_amount` onto
`invoiceOrder`.

---

## Step 11 — Overlay polish

**Files:** `Modal.jsx`, `SlideOver.jsx`

`backdrop-blur-md`, refined easing. Verify the `print:` overrides on `Modal`'s backdrop are intact
and `Invoice.test.jsx` still passes.

---

## Step 12 — Full verification

```bash
pipenv run python manage.py test
cd frontend && npm run test -- --run
cd frontend && npm run lint
cd frontend && npm run build
```

All four must pass, except the known `sqlparse` `pip-audit` failure, which must be reported as
pre-existing and unchanged rather than worked around.
