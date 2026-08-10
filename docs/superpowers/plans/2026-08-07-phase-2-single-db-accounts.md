# Phase 2: Single Database, Accounts & Subscriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `django-tenants` schema-per-tenant isolation with a single database where every row belongs to an `Account`, gated by subscription status, with self-serve signup.

**Architecture:** Data ownership moves from Postgres schema to an `account` foreign key. Reads are scoped by an explicit `AccountScopedMixin` on viewsets; writes are scoped by narrowing every relational field's queryset in the write serializers. Access requires both authentication and a live subscription, computed from `status` + `expires_at` rather than trusted from a column. Platform superadmins bypass both.

**Tech Stack:** Django 6 / DRF, Postgres, djoser + simplejwt, React 19 + Vite, Vitest.

## Global Constraints

- **Existing tenant data is discarded.** Approved. The local database is dropped and recreated.
- **Nothing in this plan touches Heroku.** No deploys, no `heroku pg:reset`, no config vars. Production remains on the old code until a separate, explicitly authorized deployment.
- `pipenv run python manage.py test` must end in `OK` before the phase is complete. Frontend: `cd frontend && npm test`, `npm run lint`, `npm run build`.
- No browser automation for verification.
- Subscription liveness is **computed**, never read from `subscription_status` alone.
- Subscribers must never be `is_staff`. `is_staff`/`is_superuser` means platform admin.
- Work continues on `feature/saas-single-db-migration`.

## File Structure

| File | Responsibility |
|---|---|
| `accounts/models.py` (create) | `Account` (subscription state), `Membership` (user → account), `get_account()` |
| `accounts/managers.py` (create) | `AccountScopedManager.for_account()` |
| `accounts/permissions.py` (create) | `HasActiveSubscription`, `IsPlatformAdmin` |
| `accounts/serializers.py` (create) | Djoser `user_create` override that provisions Account + Membership |
| `accounts/mixins.py` (create) | `AccountScopedMixin` for viewsets |
| `accounts/admin.py` (create) | Account/Membership admin for the platform owner |
| `accounts/tests.py` (create) | Provisioning, subscription gating, cross-account isolation |
| `inventory/models.py` (modify) | `account` FK on the six owned models; per-account uniqueness; media path |
| `inventory/serializers.py` (modify) | Narrow relational field querysets per account |
| `inventory/views.py` (modify) | `AccountScopedMixin` on viewsets; re-permission analytics/exports |
| `inventory/tests.py` (modify) | `TenantTestCase` → `APITestCase` + account fixtures |
| `ims/settings.py` (modify) | Remove all `django-tenants` wiring; new default permissions |
| `ims/storage.py` (modify) | `TenantS3Storage` → plain `S3Storage` |
| `ims/urls.py` (modify) | Drop `tenants/` routes |
| `tenants/` (delete) | Entire app, including its 13 tests |
| `inventory/migrations/0001–0010` (delete) | Replaced by one regenerated `0001_initial` |
| `frontend/src/pages/Signup.jsx` (create) | Self-serve registration |
| `frontend/src/pages/SubscriptionExpired.jsx` (create) | Where a 403 `subscription_expired` lands |

---

### Task 1: Tear out django-tenants

Deliverable: the app runs on a single database with no tenant routing, and the existing test suite passes unchanged in behavior. No account scoping yet — that is Task 3 onward, deliberately separated so a failure here is unambiguous.

**Files:**
- Modify: `ims/settings.py`, `ims/storage.py`, `ims/urls.py`, `inventory/tests.py`
- Delete: `tenants/`, `inventory/migrations/0001*`–`0010*`

- [ ] **Step 1: Strip tenant wiring from settings**

In `ims/settings.py`, replace the `SHARED_APPS` / `TENANT_APPS` / `INSTALLED_APPS` block with a single list:

```python
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # third-party
    'django_filters',
    'rest_framework',
    'rest_framework.authtoken',
    'rest_framework_simplejwt.token_blacklist',
    'corsheaders',
    'djoser',
    'axes',
    # local
    'accounts',
    'inventory',
    # dev
    'playground',
]

if DEBUG:
    INSTALLED_APPS.append('debug_toolbar')
```

Delete these settings entirely: `TENANT_MODEL`, `TENANT_DOMAIN_MODEL`, `DATABASE_ROUTERS`, `TENANT_BASE_DOMAIN`, `MULTITENANT_RELATIVE_MEDIA_ROOT`.

Remove `'django_tenants.middleware.main.TenantMainMiddleware'` from `MIDDLEWARE` (it must no longer be first — `corsheaders` takes that position).

- [ ] **Step 2: Switch the database engine**

```python
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': 'inventory',
        'HOST': 'localhost',
        'PORT': '5432',
        'USER': 'postgres',
        'PASSWORD': ''
    }
}

_database_url_config = dj_database_url.config()
if _database_url_config:
    DATABASES['default'] = _database_url_config
```

Note the removed `engine=` argument — `dj_database_url` now correctly defaults to the stock Postgres backend.

- [ ] **Step 3: Replace tenant storage**

Replace the whole of `ims/storage.py`:

```python
from storages.backends.s3 import S3Storage


class MediaS3Storage(S3Storage):
    """
    Media storage for S3-API-compatible object storage (AWS S3, or Cloudflare R2 via
    AWS_S3_ENDPOINT_URL).

    Per-tenant prefixing is gone with django-tenants. Uploads are namespaced per account by
    the model's own upload_to callable (see inventory.models.product_image_path) rather than
    by the storage backend, so the path is visible in the stored file name instead of being
    applied invisibly at write time.
    """
```

In `ims/settings.py`, update both storage references:

```python
STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
    },
    'staticfiles': {
        'BACKEND': 'whitenoise.storage.CompressedManifestStaticFilesStorage',
    },
}
```

and change the S3 activation line to `STORAGES['default']['BACKEND'] = 'ims.storage.MediaS3Storage'`.

- [ ] **Step 4: Drop the tenants app and its routes**

```bash
git rm -r tenants
```

In `ims/urls.py`, delete the line `path('tenants/', include('tenants.urls')),`.

- [ ] **Step 5: Remove the tenant Pipfile dependency**

In `Pipfile`, delete the `django-tenants = "*"` line. Do **not** run `pipenv install` yet — the package must stay importable until the migrations are regenerated in Step 7. Uninstall at the end of the phase.

- [ ] **Step 6: Convert the existing tests off TenantTestCase**

In `inventory/tests.py`, replace the imports:

```python
from django.contrib.auth.models import Permission, User
from django.test import TestCase
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken
```

Then, throughout the file: every `class X(TenantTestCase)` becomes `class X(APITestCase)`, and every `self.client = TenantClient(self.tenant)` becomes `self.client = APIClient()`. Leave `JWTPersistenceAndRevocationTests` and `BruteForceLockoutTests` on plain `TestCase` — they already are.

- [ ] **Step 7: Regenerate migrations against a clean database**

This is the irreversible step. It drops the local database.

```bash
rm inventory/migrations/0001_initial.py inventory/migrations/0002_*.py inventory/migrations/0003_*.py \
   inventory/migrations/0004_*.py inventory/migrations/0005_*.py inventory/migrations/0006_*.py \
   inventory/migrations/0007_*.py inventory/migrations/0008_*.py inventory/migrations/0009_*.py \
   inventory/migrations/0010_*.py
rm -rf inventory/migrations/__pycache__

psql -h localhost -U postgres -c 'DROP DATABASE IF EXISTS inventory;'
psql -h localhost -U postgres -c 'CREATE DATABASE inventory;'
```

Migrations are regenerated in Task 3, after the `account` FK exists, so that the schema is created once with its final shape. For now only the built-in apps migrate:

```bash
pipenv run python manage.py migrate
```

Expected: applies `contenttypes`, `auth`, `admin`, `sessions`, `axes`, `token_blacklist`, `authtoken`. `inventory` has no migrations yet and is skipped.

- [ ] **Step 8: Confirm the tenant machinery is gone**

Run: `grep -rn "django_tenants\|TenantTestCase\|TenantClient\|schema_name\|MULTITENANT" --include="*.py" . | grep -v node_modules`
Expected: matches only in `inventory/management/commands/seed_data.py` (rewritten in Task 6) and this plan's own docs.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor!: remove django-tenants schema routing for a single database

Tenant data is discarded by design (approved): inventory tables lived only
inside tenant schemas, so switching to the stock Postgres backend leaves the
public schema with none of them — a reset was required either way. Migrations
are regenerated in the following commit, once the account FK exists, so the
schema is created once in its final shape."
```

---

### Task 2: The accounts app

**Files:**
- Create: `accounts/__init__.py`, `accounts/apps.py`, `accounts/models.py`, `accounts/managers.py`, `accounts/permissions.py`, `accounts/admin.py`, `accounts/tests.py`

**Interfaces:**
- Produces: `Account`, `Membership`, `get_account(user) -> Account | None`, `AccountScopedManager`, `HasActiveSubscription`, `IsPlatformAdmin`. Tasks 3–5 import these by exactly these names.

- [ ] **Step 1: Scaffold the app**

```bash
pipenv run python manage.py startapp accounts
rm accounts/views.py accounts/tests.py
```

- [ ] **Step 2: Write the failing tests**

Create `accounts/tests.py`:

```python
from datetime import timedelta

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone

from accounts.models import Account, Membership, get_account


def make_account(**kwargs):
    return Account.objects.create(name=kwargs.pop('name', 'Test Co'), **kwargs)


class SubscriptionLivenessTests(TestCase):
    """
    Liveness is computed from status AND expires_at. Nothing flips 'active' to 'past_due'
    without a scheduled job, so trusting the column alone silently grants free service.
    """

    def test_trial_with_future_expiry_is_active(self):
        account = make_account(
            subscription_status=Account.TRIAL,
            expires_at=timezone.now() + timedelta(days=1),
        )
        self.assertTrue(account.has_active_subscription)

    def test_active_with_past_expiry_is_not_active(self):
        account = make_account(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() - timedelta(days=1),
        )
        self.assertFalse(account.has_active_subscription)

    def test_active_with_no_expiry_is_active(self):
        account = make_account(subscription_status=Account.ACTIVE, expires_at=None)
        self.assertTrue(account.has_active_subscription)

    def test_canceled_is_never_active_even_with_future_expiry(self):
        account = make_account(
            subscription_status=Account.CANCELED,
            expires_at=timezone.now() + timedelta(days=30),
        )
        self.assertFalse(account.has_active_subscription)

    def test_past_due_is_not_active(self):
        account = make_account(subscription_status=Account.PAST_DUE)
        self.assertFalse(account.has_active_subscription)

    def test_new_accounts_default_to_trial(self):
        account = Account.objects.create(name='Fresh')
        self.assertEqual(account.subscription_status, Account.TRIAL)
        self.assertEqual(account.plan_type, Account.FREE_TRIAL)


class GetAccountTests(TestCase):
    def test_returns_the_members_account(self):
        account = make_account()
        user = User.objects.create_user(username='member', password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        self.assertEqual(get_account(user), account)

    def test_returns_none_for_a_user_with_no_membership(self):
        user = User.objects.create_user(username='loner', password='pw12345!')
        self.assertIsNone(get_account(user))

    def test_returns_none_for_anonymous(self):
        from django.contrib.auth.models import AnonymousUser
        self.assertIsNone(get_account(AnonymousUser()))
```

- [ ] **Step 3: Run to verify failure**

Run: `pipenv run python manage.py test accounts -v 2`
Expected: FAIL — `ModuleNotFoundError: No module named 'accounts.models'` members, or `ImportError: cannot import name 'get_account'`.

- [ ] **Step 4: Write the models**

Create `accounts/models.py`:

```python
from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class Account(models.Model):
    """
    A subscribing business. Replaces what used to be a Postgres schema under
    django-tenants: every row of business data belongs to exactly one Account.
    """

    TRIAL = 'trial'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    CANCELED = 'canceled'
    SUBSCRIPTION_STATUS_CHOICES = [
        (TRIAL, 'Trial'),
        (ACTIVE, 'Active'),
        (PAST_DUE, 'Past due'),
        (CANCELED, 'Canceled'),
    ]

    MONTHLY = 'monthly'
    ONE_TIME = 'one_time'
    FREE_TRIAL = 'free_trial'
    PLAN_TYPE_CHOICES = [
        (MONTHLY, 'Monthly'),
        (ONE_TIME, 'One time'),
        (FREE_TRIAL, 'Free trial'),
    ]

    # Statuses that represent a paying-or-trialling customer. past_due and canceled are
    # absent on purpose: both mean "stop serving".
    LIVE_STATUSES = (TRIAL, ACTIVE)

    name = models.CharField(max_length=255)
    subscription_status = models.CharField(
        max_length=20, choices=SUBSCRIPTION_STATUS_CHOICES, default=TRIAL, db_index=True,
    )
    plan_type = models.CharField(
        max_length=20, choices=PLAN_TYPE_CHOICES, default=FREE_TRIAL,
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name

    @property
    def has_active_subscription(self):
        """
        Computed, never read from subscription_status alone.

        No scheduled job flips 'active' to 'past_due' when expires_at passes, so the column
        goes stale the moment a subscription lapses. Deriving liveness here means the
        permission class, the admin, and any future billing webhook cannot disagree.
        """
        if self.subscription_status not in self.LIVE_STATUSES:
            return False
        return self.expires_at is None or self.expires_at > timezone.now()


class Membership(models.Model):
    """
    Links a user to their account.

    A OneToOneField today because one account has one login. It exists as its own model
    rather than an `owner` field on Account so that supporting staff logins later is a
    field swap (OneToOne -> ForeignKey) plus a data migration, not a restructuring of every
    scoped query in the app.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='membership')
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='memberships')
    is_owner = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.user.username} → {self.account.name}'


def get_account(user):
    """
    The account whose data this user may see, or None.

    None for anonymous users, for platform superadmins (who have no membership and are not
    scoped), and for any user whose provisioning failed. Callers must treat None as
    "no business data", never as "all business data".
    """
    if not user or not user.is_authenticated:
        return None
    membership = getattr(user, 'membership', None)
    return membership.account if membership else None
```

- [ ] **Step 5: Write the manager**

Create `accounts/managers.py`:

```python
from django.db import models


class AccountScopedQuerySet(models.QuerySet):
    def for_account(self, account):
        """
        Narrow to one account's rows. A None account yields nothing — the safe reading of
        "this user has no account", and never "show everything".
        """
        if account is None:
            return self.none()
        return self.filter(account=account)


class AccountScopedManager(models.Manager.from_queryset(AccountScopedQuerySet)):
    """
    Default manager for account-owned models.

    Deliberately does NOT auto-filter. An auto-filtering manager needs the request in
    thread-local state, which is absent in management commands, the shell, and background
    jobs — so it silently returns unfiltered data in exactly the places a bulk mistake does
    the most damage. Scoping is applied explicitly by AccountScopedMixin (views) and by
    .for_account() (everywhere else).
    """
```

- [ ] **Step 6: Write the permissions**

Create `accounts/permissions.py`:

```python
from rest_framework.permissions import BasePermission

from .models import get_account


class HasActiveSubscription(BasePermission):
    """
    Requires a live subscription. Platform superadmins bypass it.

    The 403 body carries a machine-readable code so the frontend can route to a subscribe
    screen instead of showing a generic "you don't have permission" toast.
    """

    message = {
        'detail': 'Your subscription has expired. Renew it to continue using the app.',
        'code': 'subscription_expired',
    }

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        account = get_account(user)
        return account is not None and account.has_active_subscription


class IsPlatformAdmin(BasePermission):
    """Platform-owner operations: every account's data, billing controls, global stats."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_superuser)
```

- [ ] **Step 7: Write the admin**

Create `accounts/admin.py`:

```python
from django.contrib import admin

from .models import Account, Membership


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0
    autocomplete_fields = ['user']


@admin.register(Account)
class AccountAdmin(admin.ModelAdmin):
    list_display = ['name', 'subscription_status', 'plan_type', 'expires_at', 'is_live', 'created_at']
    list_filter = ['subscription_status', 'plan_type']
    search_fields = ['name']
    inlines = [MembershipInline]

    @admin.display(boolean=True, description='Subscription live')
    def is_live(self, account):
        # Shows the computed answer, not the stored status — an 'active' row whose
        # expires_at has passed reads as not live here, which is what enforcement does.
        return account.has_active_subscription


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ['user', 'account', 'is_owner', 'created_at']
    list_filter = ['is_owner']
    search_fields = ['user__username', 'account__name']
    autocomplete_fields = ['user', 'account']
```

`MembershipAdmin.autocomplete_fields` requires `search_fields` on the referenced admins. Add to `django.contrib.auth.admin.UserAdmin` by registering nothing extra — Django's built-in `UserAdmin` already defines `search_fields`, and `AccountAdmin` defines its own above.

- [ ] **Step 8: Make and apply the migration, then run the tests**

```bash
pipenv run python manage.py makemigrations accounts
pipenv run python manage.py migrate
pipenv run python manage.py test accounts -v 2
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Commit**

```bash
git add accounts ims/settings.py
git commit -m "feat: Account and Membership models with computed subscription liveness

Account replaces the Postgres schema as the unit of data ownership. Liveness is
derived from status AND expires_at because nothing flips the column when a
subscription lapses."
```

---

### Task 3: Account ownership on inventory models

**Files:**
- Modify: `inventory/models.py`
- Create: `inventory/migrations/0001_initial.py` (generated)

**Interfaces:**
- Produces: `account` FK on `Supplier`, `Category`, `Product`, `Customer`, `Purchase`, `Order`; `product_image_path` callable; per-account `UniqueConstraint`s named `uniq_<model>_account_name`.

- [ ] **Step 1: Add the account FK and per-account uniqueness**

In `inventory/models.py`, add the imports:

```python
from accounts.managers import AccountScopedManager
from accounts.models import Account
```

Add this helper near the top, beside `LINE_TOTAL`:

```python
def product_image_path(instance, filename):
    """
    Namespaces uploads per account, replacing the per-schema isolation
    MULTITENANT_RELATIVE_MEDIA_ROOT used to provide. Applied here rather than in the storage
    backend so the account is visible in the stored path instead of being injected
    invisibly at write time.
    """
    return f'inventory/images/{instance.product.account_id}/{filename}'
```

For **each** of `Supplier`, `Category`, `Product`, `Customer`, `Purchase`, `Order`:

1. Add the field, first in the class body:
   ```python
   account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='<plural>')
   ```
   using related names `suppliers`, `categories`, `products`, `customers`, `purchases`, `orders`.
2. Add `objects = AccountScopedManager()`.

For the four models with a `name`, remove `unique=True` from the `name` field and add a constraint to `Meta`. `Supplier`, `Category` and `Customer` have no `Meta` today — add one:

```python
    class Meta:
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_supplier_account_name'),
        ]
```

and correspondingly `uniq_category_account_name`, `uniq_customer_account_name`. For `Product`, keep the existing `ordering` and `indexes` and append:

```python
        constraints = [
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_product_account_name'),
        ]
```

Global uniqueness must go: it means the first account to create "Coca Cola" permanently blocks every other account from using that name.

- [ ] **Step 2: Point ProductImage at the account-aware path**

```python
class ProductImage(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='images')
    image = ExternalOrLocalImageField(upload_to=product_image_path, validators=[validate_file_size])
```

`ProductImage`, `OrderItem` and `PurchaseItem` get **no** `account` field — they are reached through their parent (`product__account`, `order__account`, `purchase_order__account`). A second copy of the owner on the child row is a consistency bug waiting to happen.

- [ ] **Step 3: Generate the migration**

```bash
pipenv run python manage.py makemigrations inventory
pipenv run python manage.py migrate
```

Expected: creates `inventory/migrations/0001_initial.py` with the account FK and constraints built in, and applies cleanly to the empty database. Because the database was dropped in Task 1 there is no data to backfill and no nullable-then-tighten dance.

- [ ] **Step 4: Verify the schema**

Run: `pipenv run python manage.py makemigrations --check --dry-run`
Expected: `No changes detected`.

- [ ] **Step 5: Commit**

```bash
git add inventory/models.py inventory/migrations
git commit -m "feat: every inventory model belongs to an Account

Name uniqueness becomes per-account: globally unique names meant the first
account to create a product name blocked it for everyone else. Uploads are
namespaced per account via upload_to, replacing per-schema media isolation."
```

---

### Task 4: Account scoping on reads and writes

**Files:**
- Create: `accounts/mixins.py`
- Modify: `inventory/views.py`, `inventory/serializers.py`, `inventory/tests.py`

**Interfaces:**
- Consumes: `get_account`, `AccountScopedManager` from Task 2; `account` FK from Task 3.
- Produces: `AccountScopedMixin` (sets `self.account`, filters `get_queryset`, stamps `perform_create`), and an `AccountFixtureMixin` test helper providing `self.account`, `self.user`, `self.client`, `self.auth_header`, and `make_account_user(username)`.

- [ ] **Step 1: Write the failing isolation tests**

Append to `inventory/tests.py`:

```python
class AccountFixtureMixin:
    """
    Builds an account, an owner, and an authenticated APIClient for it. Every scoping test
    needs a *second* account to prove isolation, so make_account_user returns a full set.
    """

    def make_account_user(self, username, account_name=None):
        from accounts.models import Account, Membership

        account = Account.objects.create(name=account_name or f'{username} Co')
        user = User.objects.create_user(username=username, password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        return account, user, client, header


class CrossAccountIsolationTests(AccountFixtureMixin, APITestCase):
    def setUp(self):
        self.account_a, self.user_a, self.client_a, self.header_a = self.make_account_user('alice')
        self.account_b, self.user_b, self.client_b, self.header_b = self.make_account_user('bob')

        self.category_a = Category.objects.create(name='Widgets', account=self.account_a)
        self.product_a = Product.objects.create(
            name='Alice Widget', description='', cost_price='4.00',
            default_sell_price='10.00', category=self.category_a,
            stock_quantity=50, account=self.account_a,
        )
        self.customer_a = Customer.objects.create(name='Acme', account=self.account_a)

        self.category_b = Category.objects.create(name='Widgets', account=self.account_b)
        self.product_b = Product.objects.create(
            name='Bob Widget', description='', cost_price='4.00',
            default_sell_price='10.00', category=self.category_b,
            stock_quantity=50, account=self.account_b,
        )

    def test_list_returns_only_the_callers_products(self):
        body = self.client_b.get('/inventory/products/', HTTP_AUTHORIZATION=self.header_b).json()
        names = [p['name'] for p in body['results']]
        self.assertEqual(names, ['Bob Widget'])

    def test_retrieving_another_accounts_product_is_404(self):
        response = self.client_b.get(
            f'/inventory/products/{self.product_a.id}/', HTTP_AUTHORIZATION=self.header_b
        )
        self.assertEqual(response.status_code, 404)

    def test_cannot_delete_another_accounts_product(self):
        response = self.client_b.delete(
            f'/inventory/products/{self.product_a.id}/', HTTP_AUTHORIZATION=self.header_b
        )
        self.assertEqual(response.status_code, 404)
        self.assertTrue(Product.objects.filter(id=self.product_a.id).exists())

    def test_creating_a_product_stamps_the_callers_account(self):
        response = self.client_b.post(
            '/inventory/products/',
            {
                'name': 'New Thing', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category_b.id,
                'stock_quantity': 5,
            },
            format='json', HTTP_AUTHORIZATION=self.header_b,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Product.objects.get(name='New Thing').account, self.account_b)

    def test_cannot_create_a_product_in_another_accounts_category(self):
        # The FK-injection vector: scoping get_queryset protects reads only.
        response = self.client_b.post(
            '/inventory/products/',
            {
                'name': 'Injected', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category_a.id,
                'stock_quantity': 5,
            },
            format='json', HTTP_AUTHORIZATION=self.header_b,
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Product.objects.filter(name='Injected').exists())

    def test_cannot_order_another_accounts_product(self):
        response = self.client_b.post(
            '/inventory/orders/',
            {
                'exchange_rate': 89000,
                'items': [{
                    'product': self.product_a.id, 'quantity': 1,
                    'unit_multiplier': 1, 'unit_price': '10.00',
                }],
            },
            format='json', HTTP_AUTHORIZATION=self.header_b,
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Order.objects.count(), 0)

    def test_cannot_attach_another_accounts_customer_to_an_order(self):
        response = self.client_b.post(
            '/inventory/orders/',
            {
                'customer': self.customer_a.id,
                'exchange_rate': 89000,
                'items': [{
                    'product': self.product_b.id, 'quantity': 1,
                    'unit_multiplier': 1, 'unit_price': '10.00',
                }],
            },
            format='json', HTTP_AUTHORIZATION=self.header_b,
        )
        self.assertEqual(response.status_code, 400)

    def test_two_accounts_may_use_the_same_product_name(self):
        # Previously impossible: name was globally unique.
        response = self.client_b.post(
            '/inventory/products/',
            {
                'name': 'Alice Widget', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category_b.id,
                'stock_quantity': 5,
            },
            format='json', HTTP_AUTHORIZATION=self.header_b,
        )
        self.assertEqual(response.status_code, 201)

    def test_analytics_covers_only_the_callers_account(self):
        order = Order.objects.create(account=self.account_a, customer=self.customer_a)
        OrderItem.objects.create(
            order=order, product=self.product_a, quantity=2,
            unit_price='10.00', unit_multiplier=1,
        )
        body = self.client_b.get('/inventory/analytics/', HTTP_AUTHORIZATION=self.header_b).json()
        self.assertEqual(body['total_revenue'], '$0.00')

    def test_orders_csv_export_covers_only_the_callers_account(self):
        order = Order.objects.create(account=self.account_a, customer=self.customer_a)
        OrderItem.objects.create(
            order=order, product=self.product_a, quantity=2,
            unit_price='10.00', unit_multiplier=1,
        )
        response = self.client_b.get(
            '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header_b
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('Alice Widget', response.content.decode())
```

- [ ] **Step 2: Run to verify failure**

Run: `pipenv run python manage.py test inventory.tests.CrossAccountIsolationTests -v 2`
Expected: FAIL — listing returns both accounts' products, and the FK-injection posts return 201.

- [ ] **Step 3: Write the viewset mixin**

Create `accounts/mixins.py`:

```python
from .models import get_account


class AccountScopedMixin:
    """
    Restricts a viewset to the requesting user's account.

    Explicit rather than magic: an auto-filtering manager or thread-local middleware would
    have to reach for global request state, which is absent in management commands, the
    shell, and background jobs — the places where an unfiltered queryset does the most
    damage. Here the scoping is visible in the class that needs it.

    `account_lookup` is the query path from this viewset's model to the Account, for models
    that reach it through a parent (e.g. ProductImage -> 'product__account').
    """

    account_lookup = 'account'

    @property
    def account(self):
        return get_account(self.request.user)

    def get_queryset(self):
        return super().get_queryset().filter(**{self.account_lookup: self.account})

    def perform_create(self, serializer):
        serializer.save(account=self.account)
```

Note: `get_account` returns None for a user with no membership, and `filter(account=None)` yields nothing — the safe direction. Superusers reach these endpoints only if they also hold a membership; platform-wide access is via Django Admin, not the API.

- [ ] **Step 4: Add a serializer mixin that narrows relational fields**

In `inventory/serializers.py`, add near the top:

```python
class AccountScopedSerializerMixin:
    """
    Narrows every relational field's queryset to the requesting account.

    Scoping get_queryset protects reads. Without this, a caller can still POST a payload
    referencing another account's row by id and DRF will resolve it happily — the write
    path is where cross-account data actually leaks.
    """

    #: field name -> model, for fields whose queryset must be account-scoped.
    account_scoped_fields = {}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        account = self.context.get('account')
        for field_name, model in self.account_scoped_fields.items():
            field = self.fields.get(field_name)
            if field is None:
                continue
            field.queryset = (
                model.objects.for_account(account) if account else model.objects.none()
            )
```

Apply it to the write serializers:

```python
class ProductSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'category': Category, 'supplier': Supplier}
```

```python
class CreateOrderSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'customer': Customer}
```

```python
class CreatePurchaseSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'supplier': Supplier}
```

```python
class CreateOrderItemSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'product': Product}
```

```python
class CreatePurchaseItemSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'product': Product}
```

Nested item serializers do not receive the parent's context automatically for this purpose — DRF passes context down through `bind`, so `self.context` resolves correctly for nested fields. Confirm with the `test_cannot_order_another_accounts_product` test.

- [ ] **Step 5: Supply the account in serializer context**

Add to `AccountScopedMixin` in `accounts/mixins.py`:

```python
    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['account'] = self.account
        return context
```

`ProductImageViewSet` already overrides `get_serializer_context`; make its override call `super()` so the account is preserved:

```python
    def get_serializer_context(self):
        return {**super().get_serializer_context(), 'product_id': self.kwargs['product_pk']}
```

- [ ] **Step 6: Apply the mixins to the viewsets**

In `inventory/views.py`, import and apply:

```python
from accounts.mixins import AccountScopedMixin
```

- `ProductViewSet`, `CategoryViewSet`, `CustomerViewSet`, `SupplierViewSet`, `PurchaseViewSet`, `OrderViewSet` → add `AccountScopedMixin` as the **first** base class.
- `ProductImageViewSet` → add `AccountScopedMixin` with `account_lookup = 'product__account'`, and drop `account` from `perform_create` since it has no such field:
  ```python
  class ProductImageViewSet(AccountScopedMixin, ModelViewSet):
      account_lookup = 'product__account'

      def perform_create(self, serializer):
          serializer.save()
  ```
- `PurchaseViewSet` and `OrderViewSet` sit alongside `_TotalAnnotationMixin`; order is `class OrderViewSet(AccountScopedMixin, _TotalAnnotationMixin, ModelViewSet)` so scoping applies before the annotation.

- [ ] **Step 7: Scope analytics and the CSV exports**

In `AnalyticsView.get`, replace the three unscoped base querysets:

```python
        account = get_account(request.user)
        purchases = Purchase.objects.for_account(account)
        orders = Order.objects.for_account(account)
        products = OrderItem.objects.filter(order__account=account) if account else OrderItem.objects.none()
```

and the catalog count:

```python
            "products_count": Product.objects.for_account(account).count(),
```

In `ExportOrdersCSVView.get`, replace the base queryset:

```python
        account = get_account(request.user)
        items = OrderItem.objects.select_related('order', 'order__customer', 'product').filter(
            order__account=account
        ) if account else OrderItem.objects.none()
```

Do the same for `ExportPurchasesCSVView` (`purchase_order__account`) and `ExportProductsCSVView` (`Product.objects.for_account(account)`). Add `from accounts.models import get_account` to the imports.

- [ ] **Step 8: Update the pre-existing tests to create accounts**

Every existing test class in `inventory/tests.py` that creates inventory rows must now supply an account. Convert each to use `AccountFixtureMixin`: in `setUp`, replace the user/client construction with

```python
        self.account, self.user, self.client, self.auth_header = self.make_account_user('boss')
```

and add `account=self.account` to every `Category.objects.create`, `Product.objects.create`, `Customer.objects.create`, `Supplier.objects.create`, `Order.objects.create`, and `Purchase.objects.create` call.

`ProductSearchTests` grants only `view_product` via `Permission`; with model permissions retired in Task 5 that grant becomes inert. Leave the line for now — Task 5 removes it.

- [ ] **Step 9: Run the tests**

```bash
pipenv run python manage.py test inventory accounts -v 1
```
Expected: PASS. `CrossAccountIsolationTests` contributes 10.

- [ ] **Step 10: Commit**

```bash
git add accounts inventory
git commit -m "feat: scope every inventory read and write to the caller's account

get_queryset scoping alone protects reads; the write serializers narrow every
relational field's queryset too, closing the FK-injection path where a caller
posts another account's row id."
```

---

### Task 5: Subscription enforcement and re-permissioned reporting

**Files:**
- Modify: `ims/settings.py`, `inventory/views.py`, `inventory/permissions.py` (delete), `inventory/tests.py`, `accounts/tests.py`

- [ ] **Step 1: Write the failing tests**

Append to `accounts/tests.py`:

```python
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import Category, Product


class SubscriptionEnforcementTests(TestCase):
    def build(self, **account_kwargs):
        account = Account.objects.create(name='Gated Co', **account_kwargs)
        user = User.objects.create_user(username=f'u{account.id}', password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        category = Category.objects.create(name='Widgets', account=account)
        Product.objects.create(
            name='Widget', description='', cost_price='1.00', default_sell_price='2.00',
            category=category, stock_quantity=1, account=account,
        )
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        return account, client, header

    def test_trial_account_may_use_the_api(self):
        _, client, header = self.build(subscription_status=Account.TRIAL)
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)

    def test_expired_account_is_blocked(self):
        _, client, header = self.build(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() - timedelta(days=1),
        )
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 403)

    def test_blocked_response_carries_a_machine_readable_code(self):
        _, client, header = self.build(subscription_status=Account.CANCELED)
        body = client.get('/inventory/products/', HTTP_AUTHORIZATION=header).json()
        self.assertEqual(body['detail']['code'], 'subscription_expired')

    def test_anonymous_requests_are_rejected(self):
        self.assertEqual(APIClient().get('/inventory/products/').status_code, 401)

    def test_user_without_a_membership_gets_no_data(self):
        user = User.objects.create_user(username='orphan', password='pw12345!')
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        self.assertEqual(client.get('/inventory/products/', HTTP_AUTHORIZATION=header).status_code, 403)

    def test_subscriber_can_read_analytics_without_being_staff(self):
        _, client, header = self.build()
        response = client.get('/inventory/analytics/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)

    def test_subscriber_can_export_csv_without_being_staff(self):
        _, client, header = self.build()
        response = client.get('/inventory/orders/export/csv/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)
```

- [ ] **Step 2: Run to verify failure**

Run: `pipenv run python manage.py test accounts.tests.SubscriptionEnforcementTests -v 2`
Expected: FAIL — expired accounts get 200, and the analytics/CSV calls get 403 (still `IsAdminUser`).

- [ ] **Step 3: Swap the default permission classes**

In `ims/settings.py`:

```python
REST_FRAMEWORK = {
    'COERCE_DECIMAL_TO_STRING': False,
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # Per-model Django permissions were a proxy for "may this person use the app" in a
    # single-tenant install. In SaaS the real gates are account scoping (which row can you
    # see) and subscription status (may you see anything at all). Per-model roles come back
    # when accounts get staff members with different capabilities.
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
        'accounts.permissions.HasActiveSubscription',
    ),
}
```

- [ ] **Step 4: Re-permission the reporting endpoints**

In `inventory/views.py`, delete `permission_classes = [IsAdminUser]` from `AnalyticsView`, `ExportOrdersCSVView`, `ExportPurchasesCSVView` and `ExportProductsCSVView` so they inherit the new default, and remove the now-unused `IsAdminUser` import.

These were admin-only, and the frontend Dashboard calls `/inventory/analytics/` on every load — meaning subscribers had to be `is_staff`. Under the new role model `is_staff` grants Django Admin across every account, so this had to change with the ownership model, not after it.

- [ ] **Step 5: Delete the retired permission class**

```bash
git rm inventory/permissions.py
```

Remove the `Permission` import and the `self.user.user_permissions.add(...)` line from `ProductSearchTests` in `inventory/tests.py`.

- [ ] **Step 6: Run the whole suite**

```bash
pipenv run python manage.py test
```
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: gate the API on an active subscription, not Django model permissions

Analytics and the CSV exports move off IsAdminUser: the dashboard calls
analytics on every load, so admin-only would have forced every subscriber to be
is_staff — which now means platform admin over every account."
```

---

### Task 6: Signup provisioning

**Files:**
- Create: `accounts/serializers.py`
- Modify: `ims/settings.py`, `accounts/tests.py`

- [ ] **Step 1: Write the failing tests**

Append to `accounts/tests.py`:

```python
class SignupProvisioningTests(TestCase):
    def signup(self, **payload):
        return APIClient().post('/auth/users/', {
            'username': payload.get('username', 'newbiz'),
            'password': payload.get('password', 'sTr0ng-pw-2026'),
            **({'business_name': payload['business_name']} if 'business_name' in payload else {}),
        }, format='json')

    def test_signup_creates_an_account_and_an_owner_membership(self):
        response = self.signup(business_name='Corner Shop')
        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username='newbiz')
        self.assertEqual(user.membership.account.name, 'Corner Shop')
        self.assertTrue(user.membership.is_owner)

    def test_account_name_defaults_to_the_username(self):
        self.signup()
        self.assertEqual(User.objects.get(username='newbiz').membership.account.name, 'newbiz')

    def test_new_accounts_start_on_a_fourteen_day_trial(self):
        self.signup()
        account = User.objects.get(username='newbiz').membership.account
        self.assertEqual(account.subscription_status, Account.TRIAL)
        self.assertEqual(account.plan_type, Account.FREE_TRIAL)
        self.assertIsNotNone(account.expires_at)
        self.assertAlmostEqual(
            (account.expires_at - timezone.now()).days, 13, delta=1,
        )

    def test_new_users_are_never_staff(self):
        self.signup()
        user = User.objects.get(username='newbiz')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_a_new_signup_can_immediately_use_the_api(self):
        self.signup()
        client = APIClient()
        token = client.post(
            '/auth/jwt/create/',
            {'username': 'newbiz', 'password': 'sTr0ng-pw-2026'}, format='json',
        ).json()['access']
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=f'JWT {token}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['count'], 0)

    def test_createsuperuser_provisions_no_account(self):
        # Platform admins are not subscribers and must not own a workspace.
        admin = User.objects.create_superuser(username='platform', password='pw12345!')
        self.assertIsNone(get_account(admin))
```

- [ ] **Step 2: Run to verify failure**

Run: `pipenv run python manage.py test accounts.tests.SignupProvisioningTests -v 2`
Expected: FAIL — `User has no membership`.

- [ ] **Step 3: Write the provisioning serializer**

Create `accounts/serializers.py`:

```python
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from djoser.serializers import UserCreateSerializer
from rest_framework import serializers

from .models import Account, Membership

TRIAL_DAYS = 14


class UserCreateWithAccountSerializer(UserCreateSerializer):
    """
    Registration provisions the user's isolated workspace in the same transaction that
    creates the user — a half-provisioned user (no account) can authenticate but sees
    nothing and cannot be repaired without admin intervention.

    Deliberately a serializer override rather than a post_save signal on User: a signal
    would also fire for createsuperuser, giving platform admins a workspace they should not
    have. Provisioning belongs to the registration endpoint, not to user creation generally.
    """

    business_name = serializers.CharField(
        required=False, allow_blank=True, write_only=True, max_length=255,
    )

    class Meta(UserCreateSerializer.Meta):
        fields = tuple(UserCreateSerializer.Meta.fields) + ('business_name',)

    @transaction.atomic
    def create(self, validated_data):
        business_name = (validated_data.pop('business_name', '') or '').strip()
        user = super().create(validated_data)

        account = Account.objects.create(
            name=business_name or user.username,
            subscription_status=Account.TRIAL,
            plan_type=Account.FREE_TRIAL,
            expires_at=timezone.now() + timedelta(days=TRIAL_DAYS),
        )
        Membership.objects.create(user=user, account=account, is_owner=True)
        return user
```

- [ ] **Step 4: Point djoser at it**

Add to `ims/settings.py`:

```python
DJOSER = {
    'SERIALIZERS': {
        'user_create': 'accounts.serializers.UserCreateWithAccountSerializer',
        'user_create_password_retype': 'accounts.serializers.UserCreateWithAccountSerializer',
    },
}
```

- [ ] **Step 5: Run the tests**

Run: `pipenv run python manage.py test accounts -v 1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add accounts ims/settings.py
git commit -m "feat: registration provisions an Account and owner Membership

Serializer override rather than a post_save signal so createsuperuser does not
provision a workspace — platform admins are not subscribers."
```

---

### Task 7: Seed command and frontend

**Files:**
- Modify: `inventory/management/commands/seed_data.py`, `frontend/src/context/AuthContext.jsx`, `frontend/src/lib/api.js`, `frontend/src/App.jsx`
- Create: `frontend/src/pages/Signup.jsx`, `frontend/src/pages/SubscriptionExpired.jsx`

- [ ] **Step 1: Rewrite the seed command for accounts**

In `inventory/management/commands/seed_data.py`:
- Delete `from django_tenants.utils import tenant_context` and `from tenants.models import Domain, Tenant`.
- Add `from accounts.models import Account, Membership`.
- Replace tenant creation with account creation: for each demo business, `Account.objects.get_or_create(name=...)` plus a `User` and owner `Membership`, then create all inventory rows with `account=account`.
- Remove every `with tenant_context(tenant):` block, keeping its body at one less level of indentation.

Verify: `pipenv run python manage.py seed_data` runs without error and the created products carry an account.

- [ ] **Step 2: Add register() to AuthContext**

In `frontend/src/context/AuthContext.jsx`, add inside `AuthProvider` and to the context value:

```js
  async function register(username, password, businessName) {
    await api.post('/auth/users/', {
      username,
      password,
      business_name: businessName,
    })
    await login(username, password)
  }
```

- [ ] **Step 3: Route subscription failures to their own screen**

In `frontend/src/lib/api.js`, inside `messageFor`, replace the 403 branch:

```js
  if (status === 403) {
    if (body?.detail?.code === 'subscription_expired') return body.detail.detail
    return "You don't have permission to do that."
  }
```

and in the response interceptor, before the generic handling, add:

```js
    // A lapsed subscription is a billing state, not a failed request — send the app to the
    // subscribe screen instead of toasting an error on every call the dashboard makes.
    if (response?.status === 403 && response.data?.detail?.code === 'subscription_expired') {
      if (window.location.pathname !== '/subscription') {
        window.location.assign('/subscription')
      }
      throw error
    }
```

- [ ] **Step 4: Build the Signup page**

Create `frontend/src/pages/Signup.jsx`, mirroring `Login.jsx`'s `GlassCard` + `AmbientBackground` layout with three fields (business name, username, password), calling `register()` from `useAuth()`, showing inline field errors from the 400 body (`username`, `password` arrays), and linking back to `/login`. Add a "Create an account" link to `Login.jsx` pointing at `/signup`.

- [ ] **Step 5: Build the SubscriptionExpired page**

Create `frontend/src/pages/SubscriptionExpired.jsx`: a `GlassCard` explaining the subscription has lapsed, with a sign-out button (`logout()` from `useAuth()`). No payment button — there is no gateway this phase; the copy says to get in touch to renew.

- [ ] **Step 6: Register the routes**

In `frontend/src/App.jsx`, add outside `ProtectedRoute`:

```jsx
        <Route path="/signup" element={<Signup />} />
        <Route path="/subscription" element={<SubscriptionExpired />} />
```

- [ ] **Step 7: Verify the frontend**

```bash
cd frontend && npm test && npm run lint && npm run build
```
Expected: tests pass, no new lint errors, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: self-serve signup, subscription screen, account-aware seed data"
```

---

### Task 8: Close out the phase

- [ ] **Step 1: Remove the tenant dependency for real**

```bash
pipenv uninstall django-tenants
```

Verify the app still boots: `pipenv run python manage.py check`.

- [ ] **Step 2: Mandatory full test run**

```bash
pipenv run python manage.py test
```
Expected: ends in `OK`.

- [ ] **Step 3: Record in HISTORY.md and CLAUDE.md**

Add a `## 2026-08-07 — Phase 2: single database, accounts, subscriptions` entry to `HISTORY.md` covering: tenant teardown, Account/Membership, scoping on reads and writes, subscription gating, re-permissioned reporting endpoints, signup provisioning. Update the CLAUDE.md plan status to `Phase 2 complete. Phase 3 next.` and remove the now-stale `tenants/ (removed in Phase 2)` note's future tense.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: record Phase 2 completion"
```

---

## Self-Review

**Spec coverage.** Design section "Phase 2" requirements map as: models (Task 2), roles (Tasks 2 + 5), scoping (Task 4), permissions guard (Tasks 4 + 5), provisioning (Task 6), settings/teardown (Task 1), uniqueness (Task 3), frontend (Task 7). Media namespacing is Task 3 Step 2. The design's note that `is_staff` must not leak to subscribers is asserted by `test_new_users_are_never_staff`.

**Placeholders.** Task 7 Steps 4–5 describe two presentational pages by their content and props rather than quoting full JSX — deliberate, since they follow `Login.jsx`'s existing structure directly and the design constrains them to a card, some fields, and a link. Every step with behavior worth getting wrong carries complete code.

**Type consistency.** `get_account(user)` is defined in Task 2 and consumed in Tasks 4, 5, 6. `AccountScopedManager.for_account(account)` is defined in Task 2 and used in Tasks 4 and 5. `account_lookup` is introduced with `AccountScopedMixin` and overridden once, on `ProductImageViewSet`. `Account.TRIAL` / `FREE_TRIAL` / `LIVE_STATUSES` constants are defined in Task 2 and used in Tasks 5 and 6. The 403 body shape `{'detail': {'detail': ..., 'code': 'subscription_expired'}}` produced in Task 2 is what Task 5's test asserts and Task 7 Step 3 reads.

**Known risk.** DRF renders a dict `message` on `BasePermission` as `{'detail': {...}}`, nesting the code one level deeper than a flat `{'detail': ..., 'code': ...}`. The test in Task 5 Step 1 asserts the nested shape and the frontend in Task 7 Step 3 reads the same path; if DRF flattens it instead, fix the frontend and the test together rather than only one.
