# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Django REST Framework API for an inventory/order management system (IMS), tracking products,
suppliers, customers, purchases (stock in) and orders (stock out). Prices are stored in USD but each
`Purchase`/`Order` also stores an `exchange_rate` (defaults to 89000, i.e. LBP) for record-keeping —
this is a Lebanon-focused business tool doing informal dual-currency bookkeeping, not live FX conversion.

## Commands

```bash
pipenv install          # install deps (see "Pipfile is out of date" gotcha below)
pipenv shell             # activate the virtualenv

python manage.py runserver
python manage.py makemigrations inventory
python manage.py migrate
python manage.py createsuperuser
python manage.py test                    # whole suite
python manage.py test inventory.tests    # single app (currently empty — see below)
```

There is no lint/format config (no ruff/flake8/black config files) and no CI in this repo.

**No real tests exist yet** — `inventory/tests.py` and `playground/tests.py` are both just the
Django-generated stub (`# Create your tests here.`). Don't assume test coverage for existing behavior.

**Pipfile is out of date**: `djoser` and `djangorestframework-simplejwt` are used in
`ims/settings.py` (`INSTALLED_APPS`, `REST_FRAMEWORK`, `SIMPLE_JWT`) and are installed in the active
env, but are *not* listed in `Pipfile`/`Pipfile.lock`. A fresh `pipenv install` from the Pipfile alone
will not pull them in — if you touch dependency management, add them explicitly
(`pipenv install djoser djangorestframework-simplejwt`) rather than assuming the lockfile is complete.

**Local dev settings are hardcoded** in `ims/settings.py`: MySQL creds (`root`/`MyPassword`,
DB `inventory`), a plaintext `SECRET_KEY`, `DEBUG = True`, `CORS_ALLOW_ALL_ORIGINS = True`. This is a
dev-only configuration, not something to "fix" incidentally — flag it if asked about deployment, but
don't rewrite it as a drive-by change.

## Architecture

Three Django apps under a single `ims` project:

- **`ims/`** — project config: `settings.py`, root `urls.py`, wsgi/asgi.
- **`inventory/`** — the actual product: models, DRF serializers/views/filters, admin. This is where
  almost all work happens.
- **`playground/`** — scratch/dev-only app (`say_hello` view rendering `hello.html`), not part of the
  real API surface. Don't extend it as if it were production code.

### Request flow

`inventory/urls.py` wires a DRF `DefaultRouter` (products, categories, purchases, orders, suppliers,
customers) plus a `NestedDefaultRouter` for `products/{id}/images/` (via `drf-nested-routers`), plus
three plain `APIView`s: `analytics/`, `orders/export/csv/`, `purchases/export/csv/`.

Auth is JWT (`djoser` + `rest_framework_simplejwt`), mounted at `/auth/`. The default permission class
is `inventory.permissions.FullDjangoModelPermissions`, which extends DRF's `DjangoModelPermissions` to
*also* require the Django `view_<model>` permission for GET (stock `DjangoModelPermissions` doesn't
gate reads). This means every model needs explicit permissions assigned via Django auth
groups/users — a user with no permissions gets 403 even on list/retrieve endpoints.

### Read/write serializer split

`Purchase`/`Order` each have two serializers (`PurchaseSerializer` vs `CreatePurchaseSerializer`,
`OrderSerializer` vs `CreateOrderSerializer`), selected in the viewset's `get_serializer_class()` based
on HTTP method. The `Create*` variants accept nested `items` and, inside `@transaction.atomic`
`create()`, both create the child `PurchaseItem`/`OrderItem` rows (via `bulk_create`) **and** mutate
`Product.stock_quantity`: purchases increment it, orders decrement it (`quantity * unit_multiplier`).
Any change to purchase/order creation needs to preserve this stock side-effect and its atomicity.

`total_price` on `Purchase`/`Order` is a Python `@property` (sums `items.all()` in memory) used by
serializers, but list views (`PurchaseViewSet`/`OrderViewSet`) instead `.annotate(annotated_total=...)`
via `Sum(F(...))` at the DB level so that `ordering_fields` can sort on it. Keep both in sync if the
pricing formula (`quantity * unit_price`, sometimes also `* unit_multiplier`) changes — it's
duplicated across models, serializers, admin CSV exports, and `AnalyticsView`/CSV export views in
`views.py`, not centralized in one place.

### Filtering/search/pagination

Standard DRF pattern repeated per viewset in `inventory/views.py`: `DjangoFilterBackend` (using
`FilterSet` subclasses in `inventory/filters.py`) + `SearchFilter` + `OrderingFilter`, with
`DefaultPagination` (`inventory/pagination.py`, page size 10) applied where set.

### Reporting/export endpoints

`AnalyticsView`, `ExportOrdersCSVView`, `ExportPurchasesCSVView` in `inventory/views.py` are all
admin-only (`IsAdminUser`) and support the same ad-hoc `?year=`/`?month=` (and for CSV exports,
`?date=`/`?order_id=`/`?purchase_id=`) query-param filtering, applied manually rather than through a
`FilterSet`. The Django admin (`inventory/admin.py`) has its own, separate CSV-export admin actions
(`export_orders_to_csv`/`export_purchases_to_csv`) and its own totals annotation — these are not shared
code with the API export views, so a formula/format fix usually needs to happen in both places.

### Media

`ProductImage` uses `ImageField(upload_to='inventory/images')` validated by
`inventory/validators.py::validate_file_size` (2MB cap). Served from `MEDIA_ROOT`/`media/` only when
`DEBUG=True` (see `ims/urls.py`).



## Frontend Development & Workflow Rules

**Git Workflow**: Create and switch to a new Git branch for all frontend development. Do not work directly on the main branch.
**Token Efficiency**: Maximize token efficiency and keep responses concise. When updating existing code, provide only the modified functions or search/replace blocks rather than rewriting entire files.

### Frontend Architecture & Design
- **Tech Stack**: React via Vite, Tailwind CSS, and modern functional components/hooks.
- **Apple/macOS Aesthetic**: The UI must look premium, modern, and native to macOS. Utilize glassmorphism (`backdrop-blur`), subtle drop shadows, clean rounded corners (`rounded-xl`), and minimalist typography (e.g., San Francisco or Inter).
- **Responsiveness**: The application must scale flawlessly across both mobile phones and laptop screens using Tailwind responsive breakpoints.
- **Animations & Dashboards**: Use libraries like `framer-motion` for smooth UI transitions and `recharts` (or similar) for interactive, animated statistics and diagrams on the main dashboard.

### Features & Boundaries
- **Required UI Tools**: Build a comprehensive dashboard, spreadsheet-like data views for inventory, printable invoices, and detailed views for orders, purchases, and products (ensuring product images are properly fetched and rendered).
- **Backend Boundaries**: You are encouraged to add useful frontend features and sorting logic, but **do not** alter the core transactional logic of the backend (e.g., how orders and purchases automatically adjust stock quantities).
- **Seed Data**: Before building the full UI, write a Python script or Django management command to populate the database with fake products, suppliers, customers, and transactions to facilitate UI/Chart testing.
- **No Deployment Yet**: Do NOT create Dockerfiles or prepare the application for publishing. Remain strictly in local development mode until explicitly authorized by the user.