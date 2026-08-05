# Product Search, Persistent Login, Brute-Force Hardening & iOS PWA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real server-side product search into the order/purchase line-item picker, make JWT login persist 30 days with proper server-side revocation on logout, add brute-force lockout + security headers, and optimize the frontend for iOS home-screen use.

**Architecture:** Backend changes are additive `settings.py`/`urls.py` config plus one new dependency (`django-axes`); no existing model, serializer, or transactional logic changes. Frontend changes replace the order/purchase product picker's "preload entire catalog" pattern with a debounced server-side search hook shared by both forms, wire logout to revoke the JWT refresh token server-side, and add iOS-specific meta tags/CSS.

**Tech Stack:** Django 6 / DRF / djoser / `rest_framework_simplejwt` / `django-axes` (new) / React 19 / Vite / Tailwind v4 / axios.

**Spec:** `docs/superpowers/specs/2026-08-05-search-sessions-hardening-pwa-design.md`

## Global Constraints

- `SIMPLE_JWT['REFRESH_TOKEN_LIFETIME'] = timedelta(days=30)`, `ROTATE_REFRESH_TOKENS = True`, `BLACKLIST_AFTER_ROTATION = True` — exact values from spec section B.
- `SESSION_COOKIE_AGE = 2592000`, `SESSION_EXPIRE_AT_BROWSER_CLOSE = False`, `SESSION_COOKIE_HTTPONLY = True`, `SESSION_COOKIE_SAMESITE = 'Lax'` — applies to `/admin/` only, not the React app (spec section B).
- Every `*_SECURE` / `SECURE_SSL_REDIRECT` / `SECURE_HSTS_*` setting is gated `not DEBUG` — this repo is local-dev-only (`DEBUG = True`) and must keep working over plain HTTP (spec sections B, C).
- `AXES_FAILURE_LIMIT = 5`, `AXES_COOLOFF_TIME = 1` (hour), `AXES_LOCKOUT_PARAMETERS = ['username', 'ip_address']` (spec section C).
- No change to `Purchase`/`Order` stock-adjustment transactional logic, no Dockerfile, no deployment prep (repo-wide `CLAUDE.md` boundaries).
- No JS test runner exists in this repo (`frontend/package.json` has no vitest/jest) — frontend tasks are verified via `npm run lint`, `npm run build`, and manual browser check, not automated tests.
- Backend uses `pipenv`; all Python commands below run via `pipenv run ...` from `/home/kader/ims`.

---

### Task 1: Product search — regression tests for existing safe search

`ProductViewSet` already uses DRF's `SearchFilter` (`icontains`/`Q`-based, injection-safe) and `FullDjangoModelPermissions` (requires `view_product` for GET). No production code changes — this task locks the existing behavior down with real tests, since `inventory/tests.py` is currently an empty stub.

**Files:**
- Modify: `inventory/tests.py`

**Interfaces:**
- Consumes: `inventory.models.Product`, `Category` (existing, `category` FK is required on `Product`); `ProductViewSet` at `/inventory/products/`.
- Produces: nothing consumed by later tasks — this task is standalone.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `inventory/tests.py` with:

```python
from django.contrib.auth.models import Permission, User
from django.test import TestCase
from rest_framework.test import APIClient

from inventory.models import Category, Product


class ProductSearchTests(TestCase):
    def setUp(self):
        category = Category.objects.create(name="Widgets")
        Product.objects.create(
            name="Blue Widget",
            description="A widget that is blue",
            cost_price="5.00",
            default_sell_price="9.99",
            category=category,
        )
        Product.objects.create(
            name="Red Gadget",
            description="A gadget that is red",
            cost_price="3.00",
            default_sell_price="6.99",
            category=category,
        )

        self.user = User.objects.create_user(username="viewer", password="pw12345!")
        self.user.user_permissions.add(Permission.objects.get(codename="view_product"))

        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def test_search_matches_name_case_insensitively(self):
        response = self.client.get("/inventory/products/", {"search": "blue"})
        self.assertEqual(response.status_code, 200)
        names = [p["name"] for p in response.data["results"]]
        self.assertEqual(names, ["Blue Widget"])

    def test_search_matches_description(self):
        response = self.client.get("/inventory/products/", {"search": "gadget that is red"})
        self.assertEqual(response.status_code, 200)
        names = [p["name"] for p in response.data["results"]]
        self.assertEqual(names, ["Red Gadget"])

    def test_search_term_with_sql_wildcards_is_treated_literally(self):
        # icontains escapes %/_ automatically — this must not match everything.
        response = self.client.get("/inventory/products/", {"search": "%"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["results"], [])

    def test_search_requires_view_permission(self):
        unprivileged = User.objects.create_user(username="nobody", password="pw12345!")
        client = APIClient()
        client.force_authenticate(user=unprivileged)

        response = client.get("/inventory/products/", {"search": "blue"})
        self.assertEqual(response.status_code, 403)

    def test_search_requires_authentication(self):
        client = APIClient()
        response = client.get("/inventory/products/", {"search": "blue"})
        self.assertEqual(response.status_code, 401)
```

- [ ] **Step 2: Run tests to verify they pass against existing behavior**

Run: `pipenv run python manage.py test inventory.tests.ProductSearchTests -v 2`
Expected: all 5 tests PASS (this confirms existing `SearchFilter` + `FullDjangoModelPermissions` behavior already satisfies the search/authorization requirement — no production code change needed for this task).

If any test fails, stop and investigate before continuing — it means the "search is already safe and scoped" assumption from the design spec is wrong and needs a real fix, not just a test.

- [ ] **Step 3: Commit**

```bash
git add inventory/tests.py
git commit -m "test: add regression tests for product search safety and permission scoping"
```

---

### Task 2: Persistent JWT login (30-day refresh) + revocation on logout + admin session hardening

**Files:**
- Modify: `ims/settings.py:35-53` (`INSTALLED_APPS`), `:142-156` (`SIMPLE_JWT`)
- Modify: `ims/urls.py`
- Modify: `inventory/tests.py` (append)

**Interfaces:**
- Produces: `POST /auth/jwt/blacklist/` accepting `{"refresh": "<token>"}`, used by Task 4's frontend logout wiring.

- [ ] **Step 1: Add `token_blacklist` to `INSTALLED_APPS`**

In `ims/settings.py`, change:
```python
    'rest_framework.authtoken', 
    'corsheaders',
    'djoser',
```
to:
```python
    'rest_framework.authtoken', 
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'djoser',
```

- [ ] **Step 2: Extend `SIMPLE_JWT` and add session cookie hardening**

Replace:
```python
SIMPLE_JWT= {
    'AUTH_HEADER_TYPES': ('JWT',),
    'ACCESS_TOKEN_LIFETIME': timedelta(days=1)
}
```
with:
```python
SIMPLE_JWT = {
    'AUTH_HEADER_TYPES': ('JWT',),
    'ACCESS_TOKEN_LIFETIME': timedelta(days=1),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=30),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
}

# Only affects /admin/ — the React app authenticates via JWT (see SIMPLE_JWT above), not
# Django sessions. Kept here for admin-site hardening per security review.
SESSION_COOKIE_AGE = 2592000  # 30 days
SESSION_EXPIRE_AT_BROWSER_CLOSE = False
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SAMESITE = 'Lax'
CSRF_COOKIE_SECURE = not DEBUG
```

- [ ] **Step 3: Add the blacklist endpoint**

In `ims/urls.py`, add the import and route:
```python
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from rest_framework_simplejwt.views import TokenBlacklistView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('inventory/', include('inventory.urls')),
    
    # Djoser Authentication Endpoints
    path('auth/', include('djoser.urls')),
    path('auth/', include('djoser.urls.jwt')),
    path('auth/jwt/blacklist/', TokenBlacklistView.as_view(), name='jwt-blacklist'),
    path('__debug__/', include('debug_toolbar.urls')), 
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
```
Only the `TokenBlacklistView` import and the one new `path(...)` line are additions — everything else in the file is unchanged.

- [ ] **Step 4: Run the blacklist app's migrations**

Run: `pipenv run python manage.py migrate`
Expected: output includes applying `token_blacklist.0001_initial` (and its follow-up migrations) with no errors.

- [ ] **Step 5: Write the failing test**

Append to `inventory/tests.py`:
```python
from rest_framework_simplejwt.tokens import RefreshToken


class JWTPersistenceAndRevocationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="jwtuser", password="pw12345!")
        self.client = APIClient()

    def test_refresh_token_lifetime_is_thirty_days(self):
        from datetime import timedelta
        from django.conf import settings as dj_settings

        self.assertEqual(dj_settings.SIMPLE_JWT['REFRESH_TOKEN_LIFETIME'], timedelta(days=30))

    def test_blacklisted_refresh_token_cannot_be_reused(self):
        refresh = RefreshToken.for_user(self.user)

        response = self.client.post("/auth/jwt/blacklist/", {"refresh": str(refresh)})
        self.assertEqual(response.status_code, 200)

        retry = self.client.post("/auth/jwt/refresh/", {"refresh": str(refresh)})
        self.assertEqual(retry.status_code, 401)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pipenv run python manage.py test inventory.tests.JWTPersistenceAndRevocationTests -v 2`
Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add ims/settings.py ims/urls.py inventory/tests.py
git commit -m "feat: extend JWT refresh lifetime to 30 days with rotation/blacklist, harden admin session cookies"
```

---

### Task 3: Brute-force lockout (django-axes) + security headers

**Files:**
- Modify: `Pipfile`
- Modify: `ims/settings.py` (`INSTALLED_APPS`, new `AUTHENTICATION_BACKENDS`, `MIDDLEWARE`, new `AXES_*`/`SECURE_*` settings)
- Modify: `inventory/tests.py` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing consumed by later tasks — standalone.

- [ ] **Step 1: Install django-axes**

Run: `pipenv install django-axes`
Expected: `Pipfile` gains a `django-axes = "*"` line under `[packages]` and `Pipfile.lock` updates; command exits 0.

- [ ] **Step 2: Register the app, backend, and middleware**

In `ims/settings.py`, change `INSTALLED_APPS` from:
```python
    #third_party-apps
    'django_filters',
    'rest_framework',
    'rest_framework.authtoken', 
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'djoser',
```
to:
```python
    #third_party-apps
    'django_filters',
    'rest_framework',
    'rest_framework.authtoken', 
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'djoser',
    'axes',
```

Add, directly after `INSTALLED_APPS`:
```python
AUTHENTICATION_BACKENDS = [
    'axes.backends.AxesStandaloneBackend',
    'django.contrib.auth.backends.ModelBackend',
]
```

Change `MIDDLEWARE` from:
```python
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'debug_toolbar.middleware.DebugToolbarMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
```
to:
```python
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'debug_toolbar.middleware.DebugToolbarMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'axes.middleware.AxesMiddleware',
]
```

- [ ] **Step 3: Add axes and security-header settings**

Append to `ims/settings.py` (after the `SESSION_COOKIE_*`/`CSRF_COOKIE_SECURE` block added in Task 2):
```python
AXES_FAILURE_LIMIT = 5
AXES_COOLOFF_TIME = 1  # hour
AXES_LOCKOUT_PARAMETERS = ['username', 'ip_address']

SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'
SECURE_HSTS_SECONDS = 0 if DEBUG else 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_SSL_REDIRECT = not DEBUG
```

- [ ] **Step 4: Run axes' migrations**

Run: `pipenv run python manage.py migrate`
Expected: output includes applying `axes` migrations with no errors.

- [ ] **Step 5: Write the failing test**

Append to `inventory/tests.py`:
```python
class BruteForceLockoutTests(TestCase):
    def setUp(self):
        User.objects.create_user(username="lockouttarget", password="correct-horse-battery")
        self.client = APIClient()

    def test_repeated_failed_logins_lock_out_even_correct_credentials(self):
        from django.conf import settings as dj_settings

        for _ in range(dj_settings.AXES_FAILURE_LIMIT):
            response = self.client.post(
                "/auth/jwt/create/",
                {"username": "lockouttarget", "password": "wrong-password"},
            )
            self.assertNotEqual(response.status_code, 200)

        # One more attempt, this time with the CORRECT password — axes should still block it.
        locked_out = self.client.post(
            "/auth/jwt/create/",
            {"username": "lockouttarget", "password": "correct-horse-battery"},
        )
        self.assertNotEqual(locked_out.status_code, 200)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pipenv run python manage.py test inventory.tests.BruteForceLockoutTests -v 2`
Expected: PASS. If it fails with the correct-password attempt returning 200, re-check `AUTHENTICATION_BACKENDS` ordering (`AxesStandaloneBackend` must be first) and that `AxesMiddleware` is present and last in `MIDDLEWARE`.

- [ ] **Step 7: Run the full backend test suite**

Run: `pipenv run python manage.py test`
Expected: all tests across `inventory.tests` PASS (Tasks 1–3 combined), no errors from other existing (non-test-covered) app code failing to boot under the new settings.

- [ ] **Step 8: Commit**

```bash
git add Pipfile Pipfile.lock ims/settings.py inventory/tests.py
git commit -m "feat: add django-axes brute-force lockout on login and OWASP security headers"
```

---

### Task 4: Frontend — revoke refresh token on logout

**Files:**
- Modify: `frontend/src/context/AuthContext.jsx`

**Interfaces:**
- Consumes: `POST /auth/jwt/blacklist/` from Task 2; `api` and `tokenStore` already exported by `frontend/src/lib/api.js` (`tokenStore.getRefresh()`, `tokenStore.clear()`).
- Produces: `logout()` returned by `useAuth()` is now `async` — existing callers (`Dock.jsx`, `WindowChrome.jsx`) call it as `onClick={logout}`, which works unchanged for an async function (React does not await onClick handlers).

- [ ] **Step 1: Update `logout()` to blacklist the refresh token**

In `frontend/src/context/AuthContext.jsx`, change:
```javascript
  function logout() {
    tokenStore.clear()
    setUser(null)
    setStatus('anonymous')
  }
```
to:
```javascript
  async function logout() {
    const refresh = tokenStore.getRefresh()
    tokenStore.clear()
    setUser(null)
    setStatus('anonymous')

    if (refresh) {
      try {
        await api.post('/auth/jwt/blacklist/', { refresh })
      } catch {
        // Token may already be expired/rotated — logout has already cleared local state either way.
      }
    }
  }
```
(Local state is cleared *before* the network call so the UI logs the user out immediately even if the blacklist request fails or is slow — the blacklist call is best-effort server-side cleanup, not a gate on logout completing client-side.)

- [ ] **Step 2: Manual verification**

Run: `cd frontend && npm run dev` (leave running), then in a browser: log in, open devtools Application tab → Local Storage, note the `ims.refresh` value, click sign out (logout button in the Dock or `WindowChrome`), and confirm:
1. The app immediately returns to the login screen.
2. A `POST` to `/auth/jwt/blacklist/` appears in the Network tab returning `200`.
3. `localStorage` no longer has `ims.access`/`ims.refresh`.

Stop the dev server after confirming (`Ctrl+C`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/context/AuthContext.jsx
git commit -m "feat: revoke JWT refresh token server-side on logout"
```

---

### Task 5: Frontend — server-side product search in order/purchase picker

**Files:**
- Create: `frontend/src/hooks/useProductSearch.js`
- Modify: `frontend/src/components/forms/ProductPicker.jsx`
- Modify: `frontend/src/components/forms/OrderForm.jsx`
- Modify: `frontend/src/components/forms/PurchaseForm.jsx`

**Interfaces:**
- Produces: `useProductSearch(query, enabled)` → `{ products: Array<Product>, status: 'idle'|'loading'|'ready'|'error' }`, matching the shape of the existing `useAllProducts` hook.
- Produces: `<ProductPicker value={string} onChange={(productId: string, product: object) => void} />` — `onChange` now receives the full selected product object as its second argument (previously only `productId`), so callers no longer need their own preloaded product list to look up price fields.
- Consumes (`OrderForm`/`PurchaseForm`): `ProductPicker`'s new two-argument `onChange`.

- [ ] **Step 1: Create the debounced search hook**

Create `frontend/src/hooks/useProductSearch.js`:
```javascript
import { useEffect, useState } from 'react'
import axios from 'axios'
import { api } from '@/lib/api'

/**
 * Debounced product search for line-item pickers (order/purchase forms).
 * Empty query returns the first page of the default-ordered catalog.
 */
export function useProductSearch(query, enabled = true) {
  const [products, setProducts] = useState([])
  const [status, setStatus] = useState(enabled ? 'loading' : 'idle')

  useEffect(() => {
    if (!enabled) return

    const controller = new AbortController()
    const timeout = setTimeout(async () => {
      setStatus('loading')
      try {
        const { data } = await api.get('/inventory/products/', {
          params: query ? { search: query } : {},
          signal: controller.signal,
        })
        setProducts(data.results)
        setStatus('ready')
      } catch (error) {
        if (!axios.isCancel(error)) setStatus('error')
      }
    }, 350)

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
  }, [query, enabled])

  return { products, status }
}
```

- [ ] **Step 2: Rewrite `ProductPicker` to own its search state**

Replace the full contents of `frontend/src/components/forms/ProductPicker.jsx`:
```jsx
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Search } from 'lucide-react'
import { ProductThumbnail } from '@/components/ui/ProductThumbnail'
import { useProductSearch } from '@/hooks/useProductSearch'

/** Native <select> can't render option thumbnails across browsers, so this is a small custom listbox instead. */
export function ProductPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState(null)
  const rootRef = useRef(null)
  const { products, status } = useProductSearch(query, open)

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function handleSelect(product) {
    setSelectedProduct(product)
    onChange(String(product.id), product)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-left text-[13px] text-text-primary focus:outline-none"
      >
        <ProductThumbnail image={selectedProduct?.images?.[0]?.image} name={selectedProduct?.name} size="xs" />
        <span className={`min-w-0 flex-1 truncate ${selectedProduct ? 'text-text-primary' : 'text-text-tertiary'}`}>
          {selectedProduct ? selectedProduct.name : 'Select product'}
        </span>
        <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-glass-border bg-glass-strong backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
          <div className="flex items-center gap-1.5 border-b border-hairline px-2 py-1.5">
            <Search size={13} className="shrink-0 text-text-tertiary" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products…"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {status === 'loading' && (
              <div className="flex justify-center py-3">
                <Loader2 size={14} className="animate-spin text-text-tertiary" />
              </div>
            )}
            {status !== 'loading' && products.length === 0 && (
              <p className="px-2 py-3 text-center text-[12px] text-text-secondary">No products found.</p>
            )}
            {status !== 'loading' &&
              products.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => handleSelect(product)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-canvas-2 ${
                    String(product.id) === String(value) ? 'bg-accent-blue/10 text-accent-blue' : 'text-text-primary'
                  }`}
                >
                  <ProductThumbnail image={product.images?.[0]?.image} name={product.name} size="xs" />
                  <span className="min-w-0 flex-1 truncate">{product.name}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Update `OrderForm.jsx` to drop the preloaded catalog**

In `frontend/src/components/forms/OrderForm.jsx`, remove the now-unused import and hook call:
```javascript
import { useAllProducts } from '@/hooks/useAllProducts'
```
(delete this line), and:
```javascript
  const { products } = useAllProducts(open)
```
(delete this line).

Change:
```javascript
  function handleProductChange(index, productId) {
    const product = products.find((p) => String(p.id) === productId)
    updateItem(index, {
      product: productId,
      unit_price: product ? product.default_sell_price : 0,
    })
  }
```
to:
```javascript
  function handleProductChange(index, productId, product) {
    updateItem(index, {
      product: productId,
      unit_price: product ? product.default_sell_price : 0,
    })
  }
```

Change the `ProductPicker` usage:
```jsx
                <ProductPicker
                  products={products}
                  value={item.product}
                  onChange={(productId) => handleProductChange(index, productId)}
                />
```
to:
```jsx
                <ProductPicker
                  value={item.product}
                  onChange={(productId, product) => handleProductChange(index, productId, product)}
                />
```

- [ ] **Step 4: Apply the same change to `PurchaseForm.jsx`**

In `frontend/src/components/forms/PurchaseForm.jsx`, remove:
```javascript
import { useAllProducts } from '@/hooks/useAllProducts'
```
and:
```javascript
  const { products } = useAllProducts(open)
```

Change:
```javascript
  function handleProductChange(index, productId) {
    const product = products.find((p) => String(p.id) === productId)
    updateItem(index, {
      product: productId,
      unit_price: product ? product.cost_price : 0,
    })
  }
```
to:
```javascript
  function handleProductChange(index, productId, product) {
    updateItem(index, {
      product: productId,
      unit_price: product ? product.cost_price : 0,
    })
  }
```

Change the `ProductPicker` usage the same way as Step 3:
```jsx
                <ProductPicker
                  products={products}
                  value={item.product}
                  onChange={(productId) => handleProductChange(index, productId)}
                />
```
to:
```jsx
                <ProductPicker
                  value={item.product}
                  onChange={(productId, product) => handleProductChange(index, productId, product)}
                />
```

Note: `frontend/src/hooks/useAllProducts.js` stays — `frontend/src/components/transactions/TransactionDetail.jsx` still imports and uses it (unrelated to this task; do not remove the hook file).

- [ ] **Step 5: Lint and build**

Run: `cd frontend && npm run lint`
Expected: no errors (existing warnings, if any, unrelated to these files, are acceptable — do not fix unrelated lint debt as part of this task).

Run: `cd frontend && npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 6: Manual verification**

Run: `cd frontend && npm run dev` (with the Django dev server also running: `pipenv run python manage.py runserver` in another terminal). In the browser:
1. Open Orders → "Add order", click the product picker on a line item — confirm a search box appears above the product list.
2. Type part of an existing product's name — confirm the list narrows to matching products (network tab shows `GET /inventory/products/?search=...`).
3. Select a product — confirm the picker closes, shows the selected product's name/thumbnail, and `Unit price` auto-fills.
4. Repeat steps 1–3 on Purchases → "Add purchase", confirming `Unit cost` auto-fills from `cost_price` instead.

Stop both dev servers after confirming.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useProductSearch.js frontend/src/components/forms/ProductPicker.jsx frontend/src/components/forms/OrderForm.jsx frontend/src/components/forms/PurchaseForm.jsx
git commit -m "feat: add server-side search to the order/purchase product picker"
```

---

### Task 6: iOS PWA meta tags, safe-area layout, and touch UX

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/layout/AppShell.jsx`
- Modify: `frontend/src/components/layout/Dock.jsx`
- Modify: `frontend/src/components/layout/WindowChrome.jsx`

**Interfaces:** None — purely additive markup/CSS, no data flow changes.

- [ ] **Step 1: Add iOS meta tags to `frontend/index.html`**

Change:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#F5F5F7" media="(prefers-color-scheme: light)" />
```
to:
```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="theme-color" content="#F5F5F7" media="(prefers-color-scheme: light)" />
```

- [ ] **Step 2: Add safe-area and touch-UX rules to `frontend/src/index.css`**

Add, after the existing `body { ... }` rule block:
```css
input,
select,
textarea {
  font-size: 16px; /* iOS Safari auto-zooms focused inputs below 16px */
}

button,
a,
input,
select {
  -webkit-tap-highlight-color: transparent;
}

.touch-target {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.safe-area-top {
  padding-top: env(safe-area-inset-top);
}

.safe-area-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}
```

- [ ] **Step 3: Apply safe-area padding to the app shell**

In `frontend/src/components/layout/AppShell.jsx`, change:
```jsx
    <div className="relative min-h-screen overflow-hidden bg-canvas print:hidden">
```
to:
```jsx
    <div className="safe-area-top relative min-h-screen overflow-hidden bg-canvas print:hidden">
```

- [ ] **Step 4: Apply safe-area padding to the mobile tab bar**

In `frontend/src/components/layout/Dock.jsx`, in `MobileTabBar`, change:
```jsx
    <nav
      className="fixed inset-x-3 bottom-3 z-20 flex items-center justify-between rounded-2xl border border-glass-border bg-glass-strong px-2 py-2 backdrop-blur-2xl [box-shadow:var(--shadow-dock)] sm:hidden"
      aria-label="Primary"
    >
```
to:
```jsx
    <nav
      className="safe-area-bottom fixed inset-x-3 bottom-3 z-20 flex items-center justify-between rounded-2xl border border-glass-border bg-glass-strong px-2 py-2 backdrop-blur-2xl [box-shadow:var(--shadow-dock)] sm:hidden"
      aria-label="Primary"
    >
```

- [ ] **Step 5: Bump the mobile header's icon buttons to a 44×44 touch target**

In `frontend/src/components/layout/WindowChrome.jsx`, the three `sm:hidden` icon buttons are currently `h-8 w-8` (32px, below the 44px minimum). Change all three occurrences of:
```
className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
```
to:
```
className="touch-target flex items-center justify-center rounded-lg text-text-secondary hover:bg-canvas-2 hover:text-text-primary"
```
(This applies to the currency toggle, theme toggle, and sign-out buttons — all three have this identical class string.)

- [ ] **Step 6: Lint and build**

Run: `cd frontend && npm run lint`
Expected: no errors.

Run: `cd frontend && npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 7: Manual verification**

Run: `cd frontend && npm run dev`. In Chrome devtools, toggle device toolbar to an iPhone with a notch (e.g. iPhone 14 Pro) and confirm:
1. No layout content is clipped under the simulated notch/status bar.
2. The mobile tab bar has visible clearance above the home indicator area.
3. Tapping a form `<input>` does not trigger an auto-zoom (verify by checking computed font-size ≥ 16px in devtools on any text input).
4. The three mobile header icon buttons in `WindowChrome` are visually ≥44×44px.

Stop the dev server after confirming.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/src/index.css frontend/src/components/layout/AppShell.jsx frontend/src/components/layout/Dock.jsx frontend/src/components/layout/WindowChrome.jsx
git commit -m "feat: add iOS PWA meta tags, safe-area insets, and touch-target sizing"
```

---

### Task 7: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full backend test suite**

Run: `pipenv run python manage.py test`
Expected: all tests pass (no failures/errors), including everything added in Tasks 1–3.

- [ ] **Step 2: Run frontend lint and build**

Run: `cd frontend && npm run lint && npm run build`
Expected: both succeed with no errors.

- [ ] **Step 3: Confirm `/admin/` still works locally over plain HTTP**

Run: `pipenv run python manage.py runserver`, visit `http://localhost:8000/admin/` in a browser, and log in with an existing superuser.
Expected: login succeeds — confirms `SESSION_COOKIE_SECURE = not DEBUG` and the new `axes` backend didn't break local admin auth. Stop the server after confirming.

- [ ] **Step 4: Final status check**

Run: `git status --short`
Expected: clean (everything committed across Tasks 1–6); if anything is uncommitted, review and commit it.
