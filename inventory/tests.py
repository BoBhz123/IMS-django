from django.contrib.auth.models import Permission, User
from django.test import TestCase
from django_tenants.test.cases import TenantTestCase
from django_tenants.test.client import TenantClient
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import (
    Category, Customer, Order, OrderItem, Product, ProductImage,
    Purchase, PurchaseItem, Supplier,
)


class ProductSearchTests(TenantTestCase):
    """
    `inventory` is a TENANT_APPS model (see ims/settings.py) — its tables only exist
    inside a tenant's own PostgreSQL schema, not in `public`. So this uses
    TenantTestCase/TenantClient rather than a plain TestCase/APIClient, which would
    hit a schema with no `inventory_product` table at all.
    """

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

        self.client = TenantClient(self.tenant)
        self.auth_header = f"JWT {RefreshToken.for_user(self.user).access_token}"

    def test_search_matches_name_case_insensitively(self):
        response = self.client.get(
            "/inventory/products/", {"search": "blue"}, HTTP_AUTHORIZATION=self.auth_header
        )
        self.assertEqual(response.status_code, 200)
        names = [p["name"] for p in response.json()["results"]]
        self.assertEqual(names, ["Blue Widget"])

    def test_search_matches_description(self):
        response = self.client.get(
            "/inventory/products/",
            {"search": "gadget that is red"},
            HTTP_AUTHORIZATION=self.auth_header,
        )
        self.assertEqual(response.status_code, 200)
        names = [p["name"] for p in response.json()["results"]]
        self.assertEqual(names, ["Red Gadget"])

    def test_search_term_with_sql_wildcards_is_treated_literally(self):
        # icontains escapes %/_ automatically — this must not match everything.
        response = self.client.get(
            "/inventory/products/", {"search": "%"}, HTTP_AUTHORIZATION=self.auth_header
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"], [])

    def test_search_requires_view_permission(self):
        unprivileged = User.objects.create_user(username="nobody", password="pw12345!")
        auth_header = f"JWT {RefreshToken.for_user(unprivileged).access_token}"

        response = self.client.get(
            "/inventory/products/", {"search": "blue"}, HTTP_AUTHORIZATION=auth_header
        )
        self.assertEqual(response.status_code, 403)

    def test_search_requires_authentication(self):
        response = self.client.get("/inventory/products/", {"search": "blue"})
        self.assertEqual(response.status_code, 401)


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


class ExternalImageURLTests(TenantTestCase):
    """
    ProductImage.image uses ExternalOrLocalImageField (see inventory/fields.py):
    FileSystemStorage.url() percent-encodes ':', '?', '&', '=' in the stored name,
    which corrupts an absolute URL if routed through the normal storage.url() path
    (e.g. "https://x/y?a=b" -> ".../https%3A/x/y%3Fa%3Db"). These tests guard against
    that regressing.
    """

    def setUp(self):
        category = Category.objects.create(name="Widgets")
        self.product = Product.objects.create(
            name="Widget",
            description="",
            cost_price="1.00",
            default_sell_price="2.00",
            category=category,
        )

    def test_external_url_is_returned_unmodified(self):
        url = "https://placehold.co/400x400/007aff/ffffff.webp?text=WM&font=roboto"
        image = ProductImage.objects.create(product=self.product, image=url)
        image.refresh_from_db()
        self.assertEqual(image.image.url, url)

    def test_locally_stored_file_still_uses_storage_url(self):
        from django.core.files.base import ContentFile

        image = ProductImage.objects.create(
            product=self.product, image=ContentFile(b"fake-bytes", name="upload.png")
        )
        image.refresh_from_db()
        self.assertTrue(image.image.url.startswith("/media/"))
        self.assertNotIn("%3A", image.image.url)


class TransactionListPerformanceTests(TenantTestCase):
    """
    Guards the fixes for the /orders/ and /purchases/ list endpoints, which previously
    returned every row a tenant had (unpaginated, with all nested line items) and ran a
    Sum-over-items annotation — a JOIN plus GROUP BY across the whole table — on every
    request, including the ones that never sorted by that total.
    """

    ORDER_COUNT = 25

    def setUp(self):
        category = Category.objects.create(name="Widgets")
        self.product = Product.objects.create(
            name="Widget",
            description="",
            cost_price="4.00",
            default_sell_price="10.00",
            category=category,
        )
        customer = Customer.objects.create(name="Acme")

        for _ in range(self.ORDER_COUNT):
            order = Order.objects.create(customer=customer)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=2,
                unit_price="10.00", unit_multiplier=3,
            )

        supplier = Supplier.objects.create(name="Supplier Co")
        for _ in range(self.ORDER_COUNT):
            purchase = Purchase.objects.create(supplier=supplier)
            PurchaseItem.objects.create(
                purchase_order=purchase, product=self.product, quantity=2,
                unit_price="4.00", unit_multiplier=3,
            )

        self.user = User.objects.create_superuser(username="boss", password="pw12345!")
        self.client = TenantClient(self.tenant)
        self.auth_header = f"JWT {RefreshToken.for_user(self.user).access_token}"

    def get(self, path, params=None):
        return self.client.get(path, params or {}, HTTP_AUTHORIZATION=self.auth_header)

    def test_orders_list_is_paginated(self):
        body = self.get("/inventory/orders/").json()
        self.assertEqual(body["count"], self.ORDER_COUNT)
        self.assertEqual(len(body["results"]), 10)
        self.assertIsNotNone(body["next"])

    def test_purchases_list_is_paginated(self):
        body = self.get("/inventory/purchases/").json()
        self.assertEqual(body["count"], self.ORDER_COUNT)
        self.assertEqual(len(body["results"]), 10)

    def test_page_size_query_param_is_honoured_and_capped(self):
        self.assertEqual(len(self.get("/inventory/orders/", {"page_size": 8}).json()["results"]), 8)
        # max_page_size=100 stops a client asking for the whole table back.
        capped = self.get("/inventory/orders/", {"page_size": 5000}).json()
        self.assertEqual(len(capped["results"]), self.ORDER_COUNT)

    def test_default_ordering_is_newest_first(self):
        placed = [row["placed_at"] for row in self.get("/inventory/orders/").json()["results"]]
        self.assertEqual(placed, sorted(placed, reverse=True))

    def test_total_annotation_is_skipped_unless_sorting_by_it(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as plain:
            self.get("/inventory/orders/", {"ordering": "-placed_at"})
        with CaptureQueriesContext(connection) as annotated:
            self.get("/inventory/orders/", {"ordering": "-annotated_total"})

        self.assertFalse(
            any("GROUP BY" in q["sql"] for q in plain.captured_queries),
            "the items JOIN + GROUP BY should not run when sorting by placed_at",
        )
        self.assertTrue(
            any("GROUP BY" in q["sql"] for q in annotated.captured_queries),
            "sorting by total still needs the annotation",
        )

    def test_sorting_by_total_uses_the_same_formula_the_ui_displays(self):
        # quantity(2) * unit_multiplier(3) * unit_price(10) — the multiplier is part of the
        # line total everywhere else (item serializers, CSV exports, analytics), so the
        # "Total" column and sorting by it must agree.
        rows = self.get("/inventory/orders/", {"ordering": "-annotated_total"}).json()["results"]
        displayed = sum(
            i["quantity"] * i["unit_multiplier"] * i["unit_price"] for i in rows[0]["items"]
        )
        self.assertEqual(displayed, 60)

    def test_list_query_count_does_not_grow_with_row_count(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as before:
            self.get("/inventory/orders/")

        customer = Customer.objects.get(name="Acme")
        for _ in range(40):
            order = Order.objects.create(customer=customer)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=1,
                unit_price="10.00", unit_multiplier=1,
            )

        with CaptureQueriesContext(connection) as after:
            self.get("/inventory/orders/")

        self.assertEqual(len(before.captured_queries), len(after.captured_queries))


class OrdersCSVExportQueryCountTests(TenantTestCase):
    """
    The export rendered `item.order.total_profit` per row. select_related builds a distinct
    Order instance for each OrderItem, so that property's `order.items.all()` was never
    cached — one extra query per CSV line.
    """

    def setUp(self):
        category = Category.objects.create(name="Widgets")
        self.product = Product.objects.create(
            name="Widget", description="", cost_price="4.00",
            default_sell_price="10.00", category=category,
        )
        self.customer = Customer.objects.create(name="Acme")
        self.user = User.objects.create_superuser(username="boss", password="pw12345!")
        self.client = TenantClient(self.tenant)
        self.auth_header = f"JWT {RefreshToken.for_user(self.user).access_token}"

    def make_orders(self, count):
        for _ in range(count):
            order = Order.objects.create(customer=self.customer)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=2,
                unit_price="10.00", unit_multiplier=3,
            )

    def export(self):
        return self.client.get("/inventory/orders/export/csv/", HTTP_AUTHORIZATION=self.auth_header)

    def test_query_count_is_constant_regardless_of_row_count(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self.make_orders(5)
        with CaptureQueriesContext(connection) as small:
            self.assertEqual(self.export().status_code, 200)

        self.make_orders(45)
        with CaptureQueriesContext(connection) as large:
            self.assertEqual(self.export().status_code, 200)

        self.assertEqual(len(small.captured_queries), len(large.captured_queries))

    def test_exported_profit_matches_the_model_property(self):
        self.make_orders(3)
        rows = self.export().content.decode().strip().splitlines()[1:]
        expected = f"${Order.objects.first().total_profit:.2f}"
        for row in rows:
            self.assertEqual(row.split(",")[-1], expected)


class AnalyticsPayloadTests(TenantTestCase):
    def setUp(self):
        category = Category.objects.create(name="Widgets")
        for i in range(3):
            Product.objects.create(
                name=f"Widget {i}", description="", cost_price="1.00",
                default_sell_price="2.00", category=category,
            )
        self.user = User.objects.create_superuser(username="boss", password="pw12345!")
        self.client = TenantClient(self.tenant)
        self.auth_header = f"JWT {RefreshToken.for_user(self.user).access_token}"

    def test_products_count_is_served_with_analytics(self):
        # Lets the dashboard's catalog-size tile drop its separate /products/ request.
        body = self.client.get(
            "/inventory/analytics/", HTTP_AUTHORIZATION=self.auth_header
        ).json()
        self.assertEqual(body["products_count"], 3)

    def test_grouped_series_has_one_row_per_period_not_per_order(self):
        customer = Customer.objects.create(name="Acme")
        product = Product.objects.first()
        for _ in range(6):
            order = Order.objects.create(customer=customer)
            OrderItem.objects.create(
                order=order, product=product, quantity=1,
                unit_price="2.00", unit_multiplier=1,
            )

        body = self.client.get(
            "/inventory/analytics/", {"group_by": "month"}, HTTP_AUTHORIZATION=self.auth_header
        ).json()
        # All six orders land in the current month -> exactly one series row.
        self.assertEqual(len(body["series"]), 1)
        self.assertEqual(body["series"][0]["total_revenue"], 12)
