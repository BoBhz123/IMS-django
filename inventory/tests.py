import tempfile
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.db.models import Sum
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import (
    LINE_COGS, Category, Customer, Expense, ExpenseCategory, Order, OrderItem,
    Product, ProductImage, Purchase, PurchaseItem, Supplier, items_cogs,
)
from inventory.reporting import DateWindow


class AccountFixtureMixin:
    """
    Builds an account, an owner, and an authenticated APIClient for it. Every scoping test
    needs a *second* account to prove isolation, so make_account_user returns a full set.
    """

    def make_account_user(self, username, account_name=None):
        from accounts.models import Account, Membership

        account = Account.objects.create(
            name=account_name or f'{username} Co',
            # Scoping tests are about which rows you can see, not about onboarding. The
            # model default is pending_verification, which 403s every request.
            subscription_status=Account.ACTIVE,
        )
        user = User.objects.create_user(username=username, password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        return account, user, client, header


class ProductSearchTests(AccountFixtureMixin, APITestCase):
    """Search behaviour of /inventory/products/: matching, escaping, and access control."""

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("viewer")

        category = Category.objects.create(name="Widgets", account=self.account)
        Product.objects.create(
            name="Blue Widget",
            description="A widget that is blue",
            cost_price="5.00",
            default_sell_price="9.99",
            category=category,
            account=self.account,
        )
        Product.objects.create(
            name="Red Gadget",
            description="A gadget that is red",
            cost_price="3.00",
            default_sell_price="6.99",
            category=category,
            account=self.account,
        )

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

    def test_search_requires_an_account(self):
        # Was a per-model view_product check. Model permissions are retired: the gate is now
        # HasActiveSubscription, and a user with no membership has no live subscription.
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


class ExternalImageURLTests(AccountFixtureMixin, APITestCase):
    """
    ProductImage.image uses ExternalOrLocalImageField (see inventory/fields.py):
    FileSystemStorage.url() percent-encodes ':', '?', '&', '=' in the stored name,
    which corrupts an absolute URL if routed through the normal storage.url() path
    (e.g. "https://x/y?a=b" -> ".../https%3A/x/y%3Fa%3Db"). These tests guard against
    that regressing.
    """

    @classmethod
    def setUpClass(cls):
        # test_locally_stored_file_still_uses_storage_url writes a real file. Without a
        # throwaway MEDIA_ROOT it lands in the repo's tracked media/ directory and gets
        # committed as a stray artifact.
        super().setUpClass()
        cls._media_dir = tempfile.TemporaryDirectory()
        cls._media_override = override_settings(MEDIA_ROOT=cls._media_dir.name)
        cls._media_override.enable()

    @classmethod
    def tearDownClass(cls):
        cls._media_override.disable()
        cls._media_dir.cleanup()
        super().tearDownClass()

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("imgowner")
        category = Category.objects.create(name="Widgets", account=self.account)
        self.product = Product.objects.create(
            name="Widget",
            description="",
            cost_price="1.00",
            default_sell_price="2.00",
            category=category,
            account=self.account,
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


class TransactionListPerformanceTests(AccountFixtureMixin, APITestCase):
    """
    Guards the fixes for the /orders/ and /purchases/ list endpoints, which previously
    returned every row a tenant had (unpaginated, with all nested line items) and ran a
    Sum-over-items annotation — a JOIN plus GROUP BY across the whole table — on every
    request, including the ones that never sorted by that total.
    """

    ORDER_COUNT = 25

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("boss")

        category = Category.objects.create(name="Widgets", account=self.account)
        self.product = Product.objects.create(
            name="Widget",
            description="",
            cost_price="4.00",
            default_sell_price="10.00",
            category=category,
            account=self.account,
        )
        customer = Customer.objects.create(name="Acme", account=self.account)

        for _ in range(self.ORDER_COUNT):
            order = Order.objects.create(customer=customer, account=self.account)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=2,
                unit_price="10.00", unit_multiplier=3,
            )

        supplier = Supplier.objects.create(name="Supplier Co", account=self.account)
        for _ in range(self.ORDER_COUNT):
            purchase = Purchase.objects.create(supplier=supplier, account=self.account)
            PurchaseItem.objects.create(
                purchase_order=purchase, product=self.product, quantity=2,
                unit_price="4.00", unit_multiplier=3,
            )

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
            order = Order.objects.create(customer=customer, account=self.account)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=1,
                unit_price="10.00", unit_multiplier=1,
            )

        with CaptureQueriesContext(connection) as after:
            self.get("/inventory/orders/")

        self.assertEqual(len(before.captured_queries), len(after.captured_queries))


class OrdersCSVExportQueryCountTests(AccountFixtureMixin, APITestCase):
    """
    The export rendered `item.order.total_profit` per row. select_related builds a distinct
    Order instance for each OrderItem, so that property's `order.items.all()` was never
    cached — one extra query per CSV line.
    """

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("boss")
        category = Category.objects.create(name="Widgets", account=self.account)
        self.product = Product.objects.create(
            name="Widget", description="", cost_price="4.00",
            default_sell_price="10.00", category=category, account=self.account,
        )
        self.customer = Customer.objects.create(name="Acme", account=self.account)

    def make_orders(self, count):
        for _ in range(count):
            order = Order.objects.create(customer=self.customer, account=self.account)
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


class AnalyticsPayloadTests(AccountFixtureMixin, APITestCase):
    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("boss")
        category = Category.objects.create(name="Widgets", account=self.account)
        for i in range(3):
            Product.objects.create(
                name=f"Widget {i}", description="", cost_price="1.00",
                default_sell_price="2.00", category=category, account=self.account,
            )

    def test_products_count_is_served_with_analytics(self):
        # Lets the dashboard's catalog-size tile drop its separate /products/ request.
        body = self.client.get(
            "/inventory/analytics/", HTTP_AUTHORIZATION=self.auth_header
        ).json()
        self.assertEqual(body["products_count"], 3)

    def test_grouped_series_has_one_row_per_period_not_per_order(self):
        customer = Customer.objects.create(name="Acme", account=self.account)
        product = Product.objects.first()
        for _ in range(6):
            order = Order.objects.create(customer=customer, account=self.account)
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


class LineTotalConsistencyTests(AccountFixtureMixin, APITestCase):
    """
    total_price on Order/Purchase used to omit unit_multiplier while the item serializers,
    analytics, CSV exports and the frontend all included it. Everything now routes through
    inventory.models.LINE_TOTAL / items_total; these pin the surfaces together.
    """

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("boss")
        category = Category.objects.create(name="Widgets", account=self.account)
        self.product = Product.objects.create(
            name="Widget", description="", cost_price="4.00",
            default_sell_price="10.00", category=category, account=self.account,
        )
        # 2 units x multiplier 3 x $10 = $60. With the multiplier dropped it would read $20.
        self.order = Order.objects.create(
            customer=Customer.objects.create(name="Acme", account=self.account),
            account=self.account,
        )
        OrderItem.objects.create(
            order=self.order, product=self.product, quantity=2,
            unit_price="10.00", unit_multiplier=3,
        )
        self.purchase = Purchase.objects.create(
            supplier=Supplier.objects.create(name="Supplier Co", account=self.account),
            account=self.account,
        )
        PurchaseItem.objects.create(
            purchase_order=self.purchase, product=self.product, quantity=2,
            unit_price="4.00", unit_multiplier=3,
        )

    def test_order_total_price_includes_unit_multiplier(self):
        self.assertEqual(self.order.total_price, 60)

    def test_purchase_total_price_includes_unit_multiplier(self):
        self.assertEqual(self.purchase.total_price, 24)

    def test_order_total_price_matches_the_sum_of_item_line_totals(self):
        body = self.client.get(
            "/inventory/orders/", HTTP_AUTHORIZATION=self.auth_header
        ).json()["results"][0]
        line_sum = sum(
            i["quantity"] * i["unit_multiplier"] * i["unit_price"] for i in body["items"]
        )
        self.assertEqual(body["total_price"], line_sum)

    def test_purchase_total_price_matches_its_items_total_price_fields(self):
        body = self.client.get(
            "/inventory/purchases/", HTTP_AUTHORIZATION=self.auth_header
        ).json()["results"][0]
        # PurchaseItemSerializer already exposed a multiplier-aware per-item total_price;
        # the parent must now agree with the sum of them.
        self.assertEqual(body["total_price"], sum(i["total_price"] for i in body["items"]))

    def test_total_price_agrees_with_analytics_revenue_and_cost(self):
        analytics = self.client.get(
            "/inventory/analytics/", HTTP_AUTHORIZATION=self.auth_header
        ).json()
        self.assertEqual(analytics["total_revenue"], f"${self.order.total_price:,.2f}")
        self.assertEqual(analytics["total_costs"], f"${self.purchase.total_price:,.2f}")

    def test_sorting_annotation_agrees_with_the_total_price_field(self):
        body = self.client.get(
            "/inventory/orders/", {"ordering": "-annotated_total"},
            HTTP_AUTHORIZATION=self.auth_header,
        ).json()["results"][0]
        self.assertEqual(body["total_price"], self.order.total_price)

    def test_admin_csv_export_totals_match_total_price(self):
        from inventory.admin import export_orders_to_csv, export_purchases_to_csv

        orders_csv = export_orders_to_csv(None, None, Order.objects.all())
        self.assertIn(f"${self.order.total_price:.2f}", orders_csv.content.decode())

        purchases_csv = export_purchases_to_csv(None, None, Purchase.objects.all())
        self.assertIn(f"${self.purchase.total_price:.2f}", purchases_csv.content.decode())


class OrderStockValidationTests(AccountFixtureMixin, APITestCase):
    """
    Orders must never drive stock negative. Three things make this less trivial than it
    looks: stock is consumed as quantity * unit_multiplier, one order may list the same
    product on several lines, and two concurrent orders can both pass a naive check.
    """

    def setUp(self):
        self.account, self.user, self.client, self.auth_header = self.make_account_user("boss")
        category = Category.objects.create(name="Widgets", account=self.account)
        self.product = Product.objects.create(
            name="Widget", description="", cost_price="4.00",
            default_sell_price="10.00", category=category, stock_quantity=10,
            account=self.account,
        )

    def post_order(self, items):
        return self.client.post(
            "/inventory/orders/",
            {"exchange_rate": 89000, "items": items},
            content_type="application/json",
            HTTP_AUTHORIZATION=self.auth_header,
        )

    def line(self, quantity, multiplier=1, product=None):
        return {
            "product": (product or self.product).id,
            "quantity": quantity,
            "unit_multiplier": multiplier,
            "unit_price": "10.00",
        }

    def stock(self):
        self.product.refresh_from_db()
        return self.product.stock_quantity

    def test_order_exceeding_stock_is_rejected(self):
        response = self.post_order([self.line(11)])
        self.assertEqual(response.status_code, 400)
        self.assertIn("items", response.json())
        self.assertIn("Insufficient stock", str(response.json()["items"]))

    def test_rejected_order_leaves_stock_and_orders_untouched(self):
        self.post_order([self.line(11)])
        self.assertEqual(self.stock(), 10)
        self.assertEqual(Order.objects.count(), 0)

    def test_order_equal_to_available_stock_is_accepted(self):
        response = self.post_order([self.line(10)])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 0)

    def test_unit_multiplier_counts_against_stock(self):
        # 4 * 3 = 12 units against 10 in stock. Validating bare quantity (4) would pass
        # this and then deduct 12, leaving -2.
        response = self.post_order([self.line(4, multiplier=3)])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.stock(), 10)

    def test_duplicate_lines_for_one_product_are_summed(self):
        # 6 + 6 = 12 against 10. Each line alone fits; together they do not.
        response = self.post_order([self.line(6), self.line(6)])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.stock(), 10)

    def test_duplicate_lines_deduct_every_line(self):
        # Regression: DRF builds a separate Product instance per item, so the old
        # `product.stock_quantity -= n; product.save()` loop wrote stale copies — the
        # second save overwrote the first and only one line's units came off.
        response = self.post_order([self.line(3), self.line(3)])
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 4)

    def test_out_of_stock_product_is_rejected(self):
        self.product.stock_quantity = 0
        self.product.save()
        response = self.post_order([self.line(1)])
        self.assertEqual(response.status_code, 400)

    def test_error_message_names_the_product_and_both_numbers(self):
        message = str(self.post_order([self.line(11)]).json()["items"])
        self.assertIn("Widget", message)
        self.assertIn("11", message)
        self.assertIn("10", message)

    def test_purchase_duplicate_lines_add_every_line(self):
        # Same stale-instance bug on the increment side.
        supplier = Supplier.objects.create(name="Supplier Co", account=self.account)
        response = self.client.post(
            "/inventory/purchases/",
            {
                "supplier": supplier.id,
                "exchange_rate": 89000,
                "items": [
                    {"product": self.product.id, "quantity": 3,
                     "unit_multiplier": 1, "unit_price": "4.00"},
                    {"product": self.product.id, "quantity": 3,
                     "unit_multiplier": 1, "unit_price": "4.00"},
                ],
            },
            content_type="application/json",
            HTTP_AUTHORIZATION=self.auth_header,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.stock(), 16)


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


class CostSnapshotTests(AccountFixtureMixin, TestCase):
    """
    Profit must be reproducible. Before this, OrderItem.profit read product.cost_price
    live, so raising a product's cost silently restated every past month.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('snap')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=100, account=self.account,
        )

    def place_order(self, quantity=2, unit_price='10.00', unit_multiplier=1):
        response = self.client.post(
            '/inventory/orders/',
            {
                'items': [{
                    'product': self.product.id,
                    'quantity': quantity,
                    'unit_price': unit_price,
                    'unit_multiplier': unit_multiplier,
                }],
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        return Order.objects.get(pk=response.data['id'])

    def test_the_cost_at_sale_time_is_recorded_on_the_line(self):
        order = self.place_order()
        self.assertEqual(order.items.first().unit_cost_price, Decimal('4.00'))

    def test_changing_the_product_cost_does_not_move_historical_profit(self):
        order = self.place_order(quantity=2)
        before = order.total_profit

        self.product.cost_price = Decimal('9.00')
        self.product.save()

        order.refresh_from_db()
        self.assertEqual(order.total_profit, before)
        self.assertEqual(before, Decimal('12.00'))  # (10 - 4) * 2 * 1

    def test_a_later_order_records_the_new_cost(self):
        self.place_order()
        self.product.cost_price = Decimal('9.00')
        self.product.save()
        later = self.place_order()
        self.assertEqual(later.items.first().unit_cost_price, Decimal('9.00'))

    def test_profit_accounts_for_the_unit_multiplier(self):
        order = self.place_order(quantity=3, unit_price='10.00', unit_multiplier=6)
        self.assertEqual(order.total_profit, Decimal('108.00'))  # (10 - 4) * 3 * 6

    def test_rows_created_outside_the_serializer_still_get_a_cost(self):
        # The admin inline and seed_data build OrderItems directly. save() fills the
        # snapshot so those paths cannot silently record a zero cost.
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        item = OrderItem.objects.create(
            order=order, product=self.product, quantity=1, unit_price=Decimal('10.00'),
        )
        self.assertEqual(item.unit_cost_price, Decimal('4.00'))

    def test_an_explicit_cost_is_not_overwritten_by_save(self):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        item = OrderItem.objects.create(
            order=order, product=self.product, quantity=1,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('1.50'),
        )
        self.assertEqual(item.unit_cost_price, Decimal('1.50'))

    def test_the_aggregate_matches_the_python_property(self):
        # LINE_COGS and items_cogs are duplicated expressions; a test pins them together
        # because the analytics view uses one and the serializers use the other.
        order = self.place_order(quantity=3, unit_multiplier=6)
        aggregated = (
            Order.objects.filter(pk=order.pk).aggregate(total=Sum(LINE_COGS))['total']
        )
        self.assertEqual(aggregated, items_cogs(order.items.all()))
        self.assertEqual(aggregated, Decimal('72.00'))  # 4 * 3 * 6

    def test_the_csv_export_reports_the_snapshot_cost(self):
        self.place_order()
        self.product.cost_price = Decimal('9.00')
        self.product.save()

        response = self.client.get(
            '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        body = response.content.decode()
        self.assertIn('4.00', body)
        self.assertNotIn('9.00', body)


class DateWindowTests(AccountFixtureMixin, TestCase):
    """
    One window object, applied to every queryset a report touches. Orders filtered by a
    window that expenses escaped would misstate net profit with no error anywhere — which
    is the whole reason this is a shared object and not four copies of five if-statements.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('win')
        self.category = Category.objects.create(name='Widgets', account=self.account)

    def make_order(self, when):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def test_no_parameters_filters_nothing(self):
        self.make_order(timezone.now() - timedelta(days=900))
        window = DateWindow.from_query_params({})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_year_and_month(self):
        self.make_order(datetime(2026, 3, 4, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 5, 4, 12, 0, tzinfo=dt_timezone.utc))

        window = DateWindow.from_query_params({'year': '2026', 'month': '3'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_start_and_end_dates_are_inclusive(self):
        self.make_order(datetime(2026, 3, 1, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 3, 31, 12, 0, tzinfo=dt_timezone.utc))
        self.make_order(datetime(2026, 4, 1, 12, 0, tzinfo=dt_timezone.utc))

        window = DateWindow.from_query_params(
            {'start_date': '2026-03-01', 'end_date': '2026-03-31'}
        )
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 2)

    def test_period_last_month(self):
        self.make_order(timezone.now() - timedelta(days=5))
        self.make_order(timezone.now() - timedelta(days=200))

        window = DateWindow.from_query_params({'period': 'last_month'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_an_unrecognised_period_filters_nothing(self):
        # 'all_time' is deliberately absent from PERIOD_WINDOW_DAYS and means "no filter".
        self.make_order(timezone.now() - timedelta(days=900))
        window = DateWindow.from_query_params({'period': 'all_time'})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_blank_parameters_are_ignored(self):
        # The SPA sends ?year=&month= when its selects are cleared. Treating '' as a value
        # would filter on the empty string and raise.
        self.make_order(timezone.now())
        window = DateWindow.from_query_params({'year': '', 'month': '', 'period': ''})
        self.assertEqual(window.apply(Order.objects.all(), 'placed_at').count(), 1)

    def test_the_same_window_applies_across_a_relation(self):
        order = self.make_order(datetime(2026, 3, 4, 12, 0, tzinfo=dt_timezone.utc))
        product = Product.objects.create(
            name='W', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=5, account=self.account,
        )
        OrderItem.objects.create(
            order=order, product=product, quantity=1, unit_price=Decimal('2.00'),
        )

        window = DateWindow.from_query_params({'year': '2026', 'month': '3'})
        self.assertEqual(
            window.apply(OrderItem.objects.all(), 'order__placed_at').count(), 1,
        )
        window = DateWindow.from_query_params({'year': '2026', 'month': '4'})
        self.assertEqual(
            window.apply(OrderItem.objects.all(), 'order__placed_at').count(), 0,
        )


class ExpenseModelTests(AccountFixtureMixin, TestCase):
    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('exp')

    def test_spent_at_defaults_to_now_but_is_writable(self):
        # default=timezone.now, never auto_now_add. A receipt entered Friday for a Tuesday
        # spend has to land in Tuesday's month or that month's net profit is wrong.
        backdated = timezone.now() - timedelta(days=45)
        expense = Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal('500.00'),
            category=ExpenseCategory.RENT, spent_at=backdated,
        )
        self.assertEqual(expense.spent_at, backdated)

    def test_created_at_records_when_it_was_entered_not_when_it_was_spent(self):
        backdated = timezone.now() - timedelta(days=45)
        expense = Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal('500.00'),
            spent_at=backdated,
        )
        self.assertGreater(expense.created_at, backdated)

    def test_category_defaults_to_other(self):
        expense = Expense.objects.create(
            account=self.account, description='Something', amount=Decimal('1.00'),
        )
        self.assertEqual(expense.category, ExpenseCategory.OTHER)

    def test_a_negative_amount_is_rejected(self):
        expense = Expense(
            account=self.account, description='Refund', amount=Decimal('-5.00'),
        )
        with self.assertRaises(ValidationError):
            expense.full_clean()

    def test_an_unknown_category_is_rejected(self):
        expense = Expense(
            account=self.account, description='X', amount=Decimal('1.00'),
            category='helicopters',
        )
        with self.assertRaises(ValidationError):
            expense.full_clean()

    def test_newest_first_by_spend_date(self):
        older = Expense.objects.create(
            account=self.account, description='Older', amount=Decimal('1.00'),
            spent_at=timezone.now() - timedelta(days=10),
        )
        newer = Expense.objects.create(
            account=self.account, description='Newer', amount=Decimal('1.00'),
            spent_at=timezone.now(),
        )
        self.assertEqual(list(Expense.objects.all()), [newer, older])


class ExpenseAPITests(AccountFixtureMixin, TestCase):
    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('e1')
        self.other_account, _, self.other_client, self.other_header = self.make_account_user('e2')
        self.url = '/inventory/expenses/'

    def make_expense(self, account=None, **overrides):
        fields = {
            'account': account or self.account,
            'description': 'Office rent',
            'amount': Decimal('500.00'),
            'category': ExpenseCategory.RENT,
        }
        fields.update(overrides)
        return Expense.objects.create(**fields)

    def test_create_stamps_the_callers_account(self):
        response = self.client.post(
            self.url,
            {'description': 'Rent', 'amount': '500.00', 'category': 'rent'},
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Expense.objects.get().account, self.account)

    def test_the_client_cannot_choose_another_account(self):
        self.client.post(
            self.url,
            {
                'description': 'Rent', 'amount': '500.00', 'category': 'rent',
                'account': self.other_account.id,
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(Expense.objects.get().account, self.account)

    def test_list_shows_only_the_callers_expenses(self):
        self.make_expense()
        self.make_expense(account=self.other_account, description='Theirs')

        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['description'], 'Office rent')

    def test_another_account_cannot_read_one_by_id(self):
        expense = self.make_expense()
        response = self.other_client.get(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.other_header,
        )
        self.assertEqual(response.status_code, 404)

    def test_another_account_cannot_delete_one(self):
        expense = self.make_expense()
        response = self.other_client.delete(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.other_header,
        )
        self.assertEqual(response.status_code, 404)
        self.assertTrue(Expense.objects.filter(pk=expense.pk).exists())

    def test_update_and_delete_work_for_the_owner(self):
        expense = self.make_expense()
        patched = self.client.patch(
            f'{self.url}{expense.id}/', {'amount': '600.00'},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(patched.status_code, 200)
        expense.refresh_from_db()
        self.assertEqual(expense.amount, Decimal('600.00'))

        deleted = self.client.delete(
            f'{self.url}{expense.id}/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(deleted.status_code, 204)

    def test_a_backdated_spend_date_is_accepted(self):
        backdated = (timezone.now() - timedelta(days=45)).isoformat()
        response = self.client.post(
            self.url,
            {
                'description': 'Late receipt', 'amount': '80.00',
                'category': 'transport', 'spent_at': backdated,
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertLess(Expense.objects.get().spent_at, timezone.now() - timedelta(days=40))

    def test_the_response_carries_a_human_readable_category(self):
        self.make_expense(category=ExpenseCategory.TAXES_FEES)
        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.data['results'][0]['category_display'], 'Taxes & Fees')

    def test_filtering_by_category(self):
        self.make_expense(category=ExpenseCategory.RENT)
        self.make_expense(category=ExpenseCategory.SOFTWARE, description='Hosting')

        response = self.client.get(
            self.url, {'category': 'software'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)

    def test_filtering_by_spend_date_range(self):
        self.make_expense(spent_at=timezone.now() - timedelta(days=40))
        self.make_expense(spent_at=timezone.now() - timedelta(days=2), description='Recent')

        cutoff = (timezone.now() - timedelta(days=10)).date().isoformat()
        response = self.client.get(
            self.url, {'spent_after': cutoff}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['description'], 'Recent')

    def test_search_matches_the_description(self):
        self.make_expense(description='Generator diesel')
        self.make_expense(description='Office rent')

        response = self.client.get(
            self.url, {'search': 'diesel'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)

    def test_ordering_by_amount(self):
        self.make_expense(amount=Decimal('10.00'))
        self.make_expense(amount=Decimal('900.00'), description='Big')

        response = self.client.get(
            self.url, {'ordering': '-amount'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['results'][0]['description'], 'Big')

    def test_anonymous_callers_are_rejected(self):
        self.assertEqual(APIClient().get(self.url).status_code, 401)
