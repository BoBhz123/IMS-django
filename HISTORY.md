# HISTORY

Completed features, fixes, and design decisions. **Read this at the start of every session** to
recover project context. Newest first.

Format: one entry per shipped unit of work — what changed, and *why* if the reason isn't obvious from
the diff. Plans live in `CLAUDE.md`; this file is only for work that is done.

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
