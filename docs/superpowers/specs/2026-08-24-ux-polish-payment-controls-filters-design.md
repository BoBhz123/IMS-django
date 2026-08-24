# UX polish, payment controls, and filter consolidation — design

**Date:** 2026-08-24 · **Branch:** `feature/phase-a-payments-currency-simplify`

Seven pieces of frontend work, plus one small additive backend filter. They are grouped because
they all land in the same six files (`OrderForm`, `PurchaseForm`, `Orders`, `Purchases`,
`Products`, `Expenses`) and would conflict badly if sequenced apart.

## What is already true before this work starts

Verified by reading the tree, not assumed:

- **Default price pre-fill already ships.** `OrderFormBody.applyScannedProduct` sets
  `unit_price: product.default_sell_price` and `handleProductChange` does the same;
  `PurchaseFormBody` uses `product.cost_price` in both places. Requirement 3 is therefore a
  *test-coverage* task, not an implementation task. Adding a second pre-fill path would be a
  second source of truth for the same rule.
- **The whole payment model is server-side complete.** `PaymentTrackedTransaction`
  (`inventory/models.py`) carries `payment_status`, `paid_amount` and the `remaining_amount`
  property; `_settle_payment` (`inventory/serializers.py`) derives the status from the amount on
  both create and update. Requirements 5 and 6 are frontend-only.
- **`PaymentBadge` and `ProductSearchModal` already exist** and are wired into both transaction
  forms. They need extending, not creating.

## The two defects behind requirement 4

The requirement describes a "state deadlock". It is actually two independent bugs, and only the
first is what the user sees.

### Defect A — `ProductForm` crashes when quick-created

`ProductFormBody` destructures `categories: initialCategories` and immediately spreads it:

```js
const categories = useMemo(() => [...initialCategories, ...createdCategories], …)
```

`Products.jsx` passes `categories` and `suppliers`. **`OrderForm` and `PurchaseForm` pass
neither** — they render `<ProductForm open={newProductOpen} onClose={…} onSaved={…} />`. Spreading
`undefined` throws, React unmounts the tree, and the screen is left with a mounted backdrop and no
content. That reads exactly like a freeze.

The fix is not a default of `[]`: the category field is `required`, so an empty list produces a
form that can never be submitted. `ProductForm` must obtain real lookups when its caller has none.
A new `hooks/useProductLookups.js` fetches categories and suppliers, and `ProductForm` prefers the
props when given and falls back to the hook when not — so `Products.jsx` keeps its single fetch and
the quick-create path gets working data.

### Defect B — nested overlays fight over `document.body.style.overflow`

`Modal` and `SlideOver` each do this independently:

```js
document.body.style.overflow = 'hidden'
return () => { document.body.style.overflow = '' }
```

With the order form (SlideOver) → picker (Modal) → product form (SlideOver) stack the requirement
describes, closing the *inner* overlay restores page scrolling while two overlays are still open.
Unmount order is not guaranteed to be the reverse of mount order either (see the comment in
`popOverlay`), so the opposite — scroll left locked after everything closed — is also reachable.

Body-scroll ownership moves into `lib/overlayStack.js` as a reference count, alongside the
Escape-ordering registry that is already there for precisely this class of bug. `useOverlayLayer`
acquires and releases it; `Modal` and `SlideOver` stop touching `document.body` at all.

## Requirement-by-requirement design

### 1. Filter popover

New `components/ui/FilterPopover.jsx`: a "Show filters" trigger (filter icon, plus a count badge
when filters are active) that opens an anchored panel holding the page's filter controls, with a
"Clear all" action. Closes on Escape, on outside click, and on trigger re-click.

It registers through `useOverlayLayer` rather than binding its own `keydown`. That hook is the
project's existing answer to "which overlay does Escape close", and a popover that bound its own
listener would close the SlideOver behind it — the exact regression `lib/overlayStack.js` was
written to prevent.

Each page keeps its own filter state and query-param assembly unchanged; only the *placement* of
the controls moves. Orders and Purchases gain a payment-status filter (see 7).

Popover contents per page:

| Page | Filters moved into the popover |
|---|---|
| Orders | customer, year, month, payment status |
| Purchases | supplier, year, month, payment status |
| Products | search, category, supplier, min price, max price |
| Expenses | search, category, start date, end date |

The primary action button (`Add order` / `Add product` / …) and the export button stay outside the
popover. They are not filters, and burying the main call to action is a usability regression.

### 2. Apple-style polish

- `Modal` and `SlideOver` backdrops go from `backdrop-blur-sm` to `backdrop-blur-md`, with refined
  scale/slide easing on the panel.
- New `lib/buttonStyles.js` exports `btnPrimary`, `btnSecondary`, `btnGhost`, `btnIcon` as class
  strings. Strings, not components: the call sites are `<button>`, `<a>` and framer-motion
  elements, and a wrapper component would have to re-expose every prop each of those takes.
- Applied to the files this task already touches. Explicitly **not** a whole-SPA restyle — Dashboard,
  Settings, Subscription, Login and Signup are out of scope, and dragging them in would put a large
  untested diff next to the behavioural changes.

The print stylesheet must not regress. `Modal`'s backdrop carries a deliberate set of `print:`
overrides and a comment forbidding `display: none`, because the invoice's printable content is
nested inside it.

### 3. Default price pre-fill

Already implemented (see above). This requirement is discharged by adding tests that pin it on
both forms, on both the picker path and the barcode-scan path, so a future refactor cannot
silently reintroduce the `0`.

### 4. Fluid product selection

- **No static blank row.** `items` starts `[]` on both forms — the `[emptyItem()]` seed goes. The
  items area renders an empty-state prompt instead, and the remove button loses its
  `items.length > 1` guard, which existed only to stop the user deleting the seeded row.
- `+ Add product` opens the picker; selecting appends or increments through the existing
  `applyScannedProduct` and **closes the picker**.
- `+ New product` mounts `ProductForm` above the picker; a successful save adds the product at its
  default price and closes both.
- Plus defects A and B above.

**Deliberate reversal:** `ProductSearchModal` currently stays open on select, with a comment
arguing that adding three items should be three taps. The owner chose close-on-select on
2026-08-24 after being shown that trade-off. The comment must be updated, not left contradicting
the code.

`applyScannedProduct` keeps its "take the first blank line, else append" branch even though the
UI no longer creates blank lines. Editing an existing transaction can still hydrate one, and
removing the branch would make a scan append a duplicate line beside it.

### 5. Payment controls on both forms

A segmented control — `Fully paid` / `Partially paid` / `Unpaid` — using the existing
`components/ui/SegmentedControl.jsx`. Choosing `Partially paid` reveals a `paid_amount`
`CurrencyInput` and a live remaining-balance line.

Wire format follows the server contract already documented in `CLAUDE.md`:

- `PAID` and `UNPAID` are sent as `payment_status` alone. The server's `_settle_payment` maps them
  to the full total and zero respectively. Sending a client-computed amount instead would let a
  stale total in the browser overwrite the server's.
- `PARTIALLY_PAID` is sent with `paid_amount`. The server refuses it without one, by design.

Pure logic goes to `lib/payment.js` — `remainingFor(total, status, paidAmount)` and
`paymentPayload(status, paidAmount)` — testable without rendering. Editing hydrates the control
from the saved `payment_status` / `paid_amount`.

The form does **not** derive or display a status of its own beyond the user's selection. The status
is the server's to compute; mirroring that derivation in the browser is how the two drift.

### 6. Payment badges in list views

`PaymentBadge` gains optional `remaining` and `formatAmount` props so a partial payment renders as
`Partial ($48.00 due)`. It keeps its existing icon-plus-label construction, because colour alone is
not a signal the most common form of colour blindness can read.

Added as a `Payment` column on the Orders and Purchases tables, and to both mobile card layouts.

Also fixed here: `Orders.jsx::openInvoice` builds its `invoiceOrder` object without
`payment_status`, `paid_amount` or `remaining_amount`, then passes all three to `<Invoice>`. Every
invoice therefore prints as unpaid with a zero balance regardless of what was actually paid.

### 7. Backend — payment status filter

`payment_status: ['exact']` added to `OrderFilter` and `PurchaseFilter` in `inventory/filters.py`.
No model change, no migration. A Django test asserts the filter narrows results and stays
account-scoped.

## Testing

- **New Vitest unit tests:** `lib/payment.js` (remaining balance across all three states, payload
  shape for each, overpayment clamped to zero), `lib/overlayStack.js` (scroll refcount acquires and
  releases correctly across nested and out-of-order unmounts).
- **New Vitest component tests:** picker closes on select; quick-create mounts `ProductForm` and
  does not throw with no `categories` prop; a created product lands on the transaction at its
  default price; payment segmented control shows and hides the amount input and computes the
  remaining balance; `PaymentBadge` renders the due amount for a partial.
- **New Django test:** the `payment_status` filter on both endpoints.
- **Regression:** the existing 358 Vitest tests and 652 Django tests must still pass. Several
  existing form tests assert against the seeded blank row and will need updating — those updates
  are expected and are part of this work, not a licence to loosen an assertion that catches a real
  break.

## Out of scope

Per-line or per-order discounts, customer/supplier balances, a whole-SPA visual restyle, and the
pre-existing `pip-audit` failure for `sqlparse` 0.5.5 (fixing it means a lockfile relock, which
`CLAUDE.md` forbids as drive-by work — it is its own decision).
