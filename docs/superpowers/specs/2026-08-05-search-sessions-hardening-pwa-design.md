# Product search, persistent login, brute-force hardening, iOS PWA

Date: 2026-08-05
Branch: `feature/frontend-dashboard` (continues existing frontend work; no new branch per user's earlier direction to continue here)

## Context

Four mostly-independent asks bundled into one request. Investigation of the current codebase
surfaced one architectural fact that reshapes half the request: **this app authenticates via JWT
(djoser + `rest_framework_simplejwt`), with tokens kept in `localStorage`** (`frontend/src/lib/api.js`).
Django's session framework (`SessionMiddleware`) is installed but only backs `/admin/` — the React
app never receives or uses a Django session cookie. So "make users stay logged in" has to be solved
in JWT terms (refresh token lifetime), not via `SESSION_COOKIE_*` settings, which would be a no-op
for the actual login flow. This was confirmed with the user via clarifying questions; decisions below
reflect their answers.

## A. Product search (order & purchase forms)

**Backend:** No change needed. `ProductViewSet` (`inventory/views.py`) already uses DRF's
`SearchFilter` with `search_fields = ['name', 'description']`, which builds `icontains`/`Q`-based
queries — already injection-safe. Authorization is already enforced by
`FullDjangoModelPermissions` (`inventory/permissions.py`), which requires the `view_product`
Django permission for GET. This schema has no per-user product ownership (single shared catalog), so
there is no additional row-level scoping to add — "authorized to view" == has `view_product`.

**Frontend:** `frontend/src/hooks/useAllProducts.js` currently pages through the *entire* product
catalog on every form open and hands the full array to `ProductPicker.jsx`, which is a custom
dropdown listbox (shared by both `OrderForm.jsx` and `PurchaseForm.jsx`) with no filtering UI today.

Changes:
1. New hook `frontend/src/hooks/useProductSearch.js`: debounced (300ms) fetch against
   `GET /inventory/products/?search=<term>&page_size=<n>`. Empty query returns the first page
   (default ordering) rather than nothing, so the picker isn't empty on open.
2. `ProductPicker.jsx`: add a search `<input>` pinned to the top of the popover (above the list),
   wired to the new hook. Replaces the reliance on receiving a pre-loaded full `products` array —
   the picker now owns its own fetch/search state instead of a parent-supplied static list.
3. `OrderForm.jsx` / `PurchaseForm.jsx`: since both already consume `ProductPicker` identically,
   stop passing the full `products` list from `useAllProducts`; `ProductPicker` becomes
   self-contained. `useAllProducts` stays if still used elsewhere (check before removing), otherwise
   delete it as dead code.
4. Preserve current behavior: selecting a product still fills `unit_price` from
   `product.default_sell_price` on change — this logic moves from the parent (`handleProductChange`
   using the preloaded array) to reading the selected product object emitted by `ProductPicker`
   itself (it already fetched it), so no duplicate lookup/fetch is needed.

## B. Persistent login ("remember device") — JWT-based

`ims/settings.py`, `SIMPLE_JWT`:
```python
SIMPLE_JWT = {
    'AUTH_HEADER_TYPES': ('JWT',),
    'ACCESS_TOKEN_LIFETIME': timedelta(days=1),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
}
```
- Add `rest_framework_simplejwt.token_blacklist` to `INSTALLED_APPS`; run
  `makemigrations`/`migrate` for its tables.
- `ims/urls.py`: djoser's `djoser.urls.jwt` already exposes `/auth/jwt/refresh/`; add
  `/auth/jwt/verify/` is already included too. Add simplejwt's blacklist endpoint:
  `path('auth/jwt/blacklist/', TokenBlacklistView.as_view())` (or via djoser if it exposes one —
  confirm during implementation; fall back to importing `rest_framework_simplejwt.views.TokenBlacklistView`
  directly).
- **Logout, frontend** (`AuthContext.jsx` `logout()` / wherever it's called from): before clearing
  `tokenStore`, `POST /auth/jwt/blacklist/` with the current refresh token, so a captured/leaked
  refresh token can't be replayed after the user explicitly logs out. This is the JWT-world
  equivalent of the request's "flush the session from the backend on logout" ask — there is no
  server-side Django session for the API login to flush.
- Net effect: a user who logs in stays authenticated for up to 30 days of activity (each refresh
  both extends and rotates the token), across browser restarts, until they explicitly log out or the
  refresh token is unused for 30 days.

**Django session hardening (applies to `/admin/` only, not the React app):**
```python
SESSION_COOKIE_AGE = 2592000  # 30 days
SESSION_EXPIRE_AT_BROWSER_CLOSE = False
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SECURE = not DEBUG
```
`SECURE = not DEBUG` rather than hardcoded `True`, per user's answer — hardcoding `True` would
silently break `/admin/` login over the plain-HTTP local dev server.

## C. Brute-force protection & security headers

- Add `django-axes` to `Pipfile`/`Pipfile.lock` (`pipenv install django-axes`).
- `INSTALLED_APPS`: add `'axes'`.
- `AUTHENTICATION_BACKENDS`: 
  ```python
  AUTHENTICATION_BACKENDS = [
      'axes.backends.AxesStandaloneBackend',
      'django.contrib.auth.backends.ModelBackend',
  ]
  ```
- `MIDDLEWARE`: append `'axes.middleware.AxesMiddleware'` as the **last** entry (axes requirement).
- Settings: `AXES_FAILURE_LIMIT = 5`, `AXES_COOLOFF_TIME = 1` (hour), `AXES_LOCKOUT_PARAMETERS =
  ['username', 'ip_address']` (lock the combination, not the whole IP, so one user's failures don't
  lock out others behind a shared IP/NAT).
- Run `migrate` for axes' tables.
- **Known limitation, flagged to user:** axes hooks into Django's `authenticate()` call itself, so
  there's no supported built-in way to protect only `/auth/jwt/create/` while excluding `/admin/` —
  enabling it protects both by construction (per user's answer, this is accepted: "API JWT login
  only" is the *intent*, but technically both get covered since admin login is rarely used in
  practice, this is a documented tradeoff, not a bug to fix).

**Headers**, `ims/settings.py`:
```python
SECURE_CONTENT_TYPE_NOSNIFF = True  # verify not already default via SecurityMiddleware
X_FRAME_OPTIONS = 'DENY'
SECURE_HSTS_SECONDS = 0 if DEBUG else 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_SSL_REDIRECT = not DEBUG
```
All production-only flags gated on `DEBUG` for the same reason as B — this repo is explicitly
local-dev-only right now (`CLAUDE.md`: "No Deployment Yet"), so nothing here should break
`runserver` over HTTP.

## D. iOS PWA optimization

`frontend/index.html` `<head>`: add
```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```
and update the existing viewport meta to include `viewport-fit=cover`:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```
(An `apple-touch-icon` link is standard alongside these but wasn't explicitly requested — add a
minimal one only if a suitable source image is available; otherwise skip rather than invent an icon.)

`frontend/src/index.css`: add safe-area padding using `env(safe-area-inset-*)` on the root app
container (whichever top-level layout wrapper currently sets viewport-height/padding — confirm
exact selector during implementation, likely in `WindowChrome.jsx`'s root or a `.app-shell` class),
plus global rules:
```css
input, select, textarea { font-size: 16px; } /* prevents iOS Safari auto-zoom on focus */
button, a, input, select { -webkit-tap-highlight-color: transparent; }
```
and a `min-height: 44px; min-width: 44px` touch-target rule applied to interactive controls that are
currently smaller (icon-only buttons) — scoped to a utility class rather than a blanket selector, to
avoid resizing already-correct elements like the `ProductPicker` popover rows.

## E. Verification

- `python manage.py test` — add real tests (currently `inventory/tests.py` is an empty stub) for:
  search endpoint behavior (returns matches, permission-gated), axes lockout after N failed JWT
  logins, refresh token blacklist-on-logout actually rejects reuse.
- `npm run lint`, `npm run build` in `frontend/`.
- Manual check: `/admin/` login still works locally over HTTP after the `SESSION_COOKIE_SECURE = not
  DEBUG` / axes changes.

## Out of scope

- No change to order/purchase stock-adjustment transactional logic (per `CLAUDE.md` boundary).
- No Dockerfile / deployment prep (per `CLAUDE.md` — local dev only).
- No migration of frontend token storage to httpOnly cookies (user chose the smaller refresh-token-
  lifetime approach over this larger rework).
