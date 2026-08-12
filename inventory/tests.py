import csv
import io
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile
from django.forms.models import model_to_dict
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.test import Client, TestCase, override_settings
from rest_framework.throttling import ScopedRateThrottle
from django.utils import timezone
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import (
    LINE_COGS, Category, Customer, Expense, ExpenseCategory, Order, OrderItem,
    Product, ProductImage, Purchase, PurchaseItem, Supplier, items_cogs,
)
from inventory.reporting import DateWindow
from accounts.models import Account, EmailVerification
from accounts import verification as verification_module

# Smallest valid GIF — enough for an ImageField to accept without shipping a fixture file.
_ONE_PIXEL_GIF = (
    b'GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!'
    b'\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00'
    b'\x02\x02D\x01\x00;'
)


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
        # Columns are addressed by name and the trailing TOTALS row is excluded: this used to
        # read row.split(',')[-1], which silently meant "whichever column happens to be last".
        # These orders have a single line each, so the line's profit is the order's profit —
        # which is the only case where Line Profit and Order.total_profit must agree.
        self.make_orders(3)
        rows = list(csv.reader(io.StringIO(self.export().content.decode())))
        header, body = rows[0], [row for row in rows[1:] if row and row[0] != 'TOTALS']

        expected = f"{Order.objects.first().total_profit:.2f}"  # bare number, no '$'
        self.assertEqual(len(body), 3)
        for row in body:
            self.assertEqual(row[header.index('Line Profit (USD)')], expected)


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
        # Phase 3 changed this contract twice over: money comes back as a raw number rather
        # than a "$1,234.00" string (the SPA parsed those straight back out again), and the
        # purchases figure is inventory_outlays — cash flow, deliberately named so it cannot
        # be misread as the new total_cogs sitting beside it.
        analytics = self.client.get(
            "/inventory/analytics/", HTTP_AUTHORIZATION=self.auth_header
        ).json()
        self.assertEqual(Decimal(str(analytics["total_revenue"])), self.order.total_price)
        self.assertEqual(
            Decimal(str(analytics["inventory_outlays"])), self.purchase.total_price,
        )

    def test_sorting_annotation_agrees_with_the_total_price_field(self):
        body = self.client.get(
            "/inventory/orders/", {"ordering": "-annotated_total"},
            HTTP_AUTHORIZATION=self.auth_header,
        ).json()["results"][0]
        self.assertEqual(body["total_price"], self.order.total_price)

    def test_admin_csv_export_totals_match_total_price(self):
        from inventory.admin import export_orders_to_csv, export_purchases_to_csv

        # Money is written bare so spreadsheets treat it as a number, hence no '$' here.
        orders_csv = export_orders_to_csv(None, None, Order.objects.all())
        self.assertIn(f"{self.order.total_price:.2f}", orders_csv.content.decode())

        purchases_csv = export_purchases_to_csv(None, None, Purchase.objects.all())
        self.assertIn(f"{self.purchase.total_price:.2f}", purchases_csv.content.decode())


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
        self.assertEqual(Decimal(str(body['total_revenue'])), Decimal('0'))

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


class AnalyticsFinancialsTests(AccountFixtureMixin, TestCase):
    """
    Two ledgers that must not be mixed: gross/net profit is margin, inventory_outlays is
    cash. Folding stock spend into profit makes margin swing with restocking timing.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('fin')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=100, account=self.account,
        )

    def analytics(self, **params):
        response = self.client.get(
            '/inventory/analytics/', params, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        return response.data

    def sell(self, quantity=10, unit_price='10.00', when=None):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.product, quantity=quantity,
            unit_price=Decimal(unit_price), unit_cost_price=Decimal('4.00'),
        )
        if when:
            Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def spend(self, amount='100.00', when=None):
        return Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal(amount),
            category=ExpenseCategory.RENT, spent_at=when or timezone.now(),
        )

    def test_gross_profit_is_revenue_minus_cogs(self):
        self.sell(quantity=10)
        data = self.analytics()
        self.assertEqual(Decimal(str(data['total_revenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(data['total_cogs'])), Decimal('40.00'))
        self.assertEqual(Decimal(str(data['gross_profit'])), Decimal('60.00'))

    def test_net_profit_is_gross_profit_minus_expenses(self):
        self.sell(quantity=10)
        self.spend('25.00')
        data = self.analytics()
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('25.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('35.00'))

    def test_inventory_purchases_do_not_touch_profit(self):
        self.sell(quantity=10)
        purchase = Purchase.objects.create(
            account=self.account, supplier=Supplier.objects.create(
                name='S', account=self.account,
            ), exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.product, quantity=50,
            unit_price=Decimal('4.00'),
        )
        data = self.analytics()
        self.assertEqual(Decimal(str(data['inventory_outlays'])), Decimal('200.00'))
        self.assertEqual(Decimal(str(data['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('60.00'))

    def test_everything_is_zero_with_no_data(self):
        data = self.analytics()
        for key in ('total_revenue', 'total_cogs', 'gross_profit', 'total_expenses',
                    'net_profit', 'inventory_outlays'):
            self.assertEqual(Decimal(str(data[key])), Decimal('0'))

    def test_the_same_window_reaches_orders_and_expenses(self):
        # The failure this guards against: a window that filters orders but not expenses,
        # which silently reports last month's sales against a year of overhead.
        old = timezone.now() - timedelta(days=200)
        self.sell(quantity=10, when=old)
        self.spend('25.00', when=old)
        self.sell(quantity=5)
        self.spend('10.00')

        data = self.analytics(period='last_month')
        self.assertEqual(Decimal(str(data['total_revenue'])), Decimal('50.00'))
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(data['net_profit'])), Decimal('20.00'))

    def test_a_backdated_expense_lands_in_the_month_it_was_spent(self):
        march = datetime(2026, 3, 15, 12, 0, tzinfo=dt_timezone.utc)
        self.spend('75.00', when=march)
        self.spend('10.00')

        data = self.analytics(year='2026', month='3')
        self.assertEqual(Decimal(str(data['total_expenses'])), Decimal('75.00'))

    def test_expenses_are_account_scoped(self):
        other_account, _, _, _ = self.make_account_user('fin2')
        Expense.objects.create(
            account=other_account, description='Theirs', amount=Decimal('999.00'),
        )
        self.assertEqual(Decimal(str(self.analytics()['total_expenses'])), Decimal('0'))

    def test_money_comes_back_as_numbers_not_formatted_strings(self):
        # The dashboard re-formats these for the LBP toggle. A "$1,234.00" string forces it
        # to parse the value back out first.
        self.sell(quantity=1)
        data = self.analytics()
        self.assertNotIsInstance(data['total_revenue'], str)

    def test_the_series_carries_expenses_per_period(self):
        self.sell(quantity=10)
        self.spend('25.00')
        data = self.analytics(group_by='month')
        self.assertTrue(data['series'])
        self.assertIn('total_expenses', data['series'][0])


class ProductBarcodeTests(AccountFixtureMixin, TestCase):
    """
    An optional barcode, searchable through the same ?search= the products list already uses,
    and unique per account: one code identifies one product.

    Phase 4 originally left the field non-unique so a shop could reuse a code across loose
    goods. That was reversed at the owner's direction — every product carries its own
    barcode — so the constraint is `(account, barcode)`, never a global one: two shops both
    stocking the same real-world item must both be able to record its EAN.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('bc')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.url = '/inventory/products/'

    def make_product(self, name='Blue Widget', account=None, **overrides):
        fields = {
            'name': name,
            'description': 'A widget',
            'cost_price': '5.00',
            'default_sell_price': '9.99',
            'category': self.category,
            'account': account or self.account,
        }
        fields.update(overrides)
        return Product.objects.create(**fields)

    def test_a_product_needs_no_barcode(self):
        product = self.make_product()
        self.assertIsNone(product.barcode)

    def test_a_blank_barcode_is_stored_as_null_not_an_empty_string(self):
        # Otherwise '' and NULL both mean "no barcode" and every lookup has to test for two
        # things — and a future unique constraint would collide on the second '' row.
        product = self.make_product(barcode='')
        product.refresh_from_db()
        self.assertIsNone(product.barcode)

    def test_surrounding_whitespace_is_stripped(self):
        # Scanners and copy-paste both append stray whitespace; ' 5901234' would then never
        # match a search for '5901234'.
        product = self.make_product(barcode='  5901234123457  ')
        product.refresh_from_db()
        self.assertEqual(product.barcode, '5901234123457')

    def test_search_finds_a_product_by_its_full_barcode(self):
        self.make_product(barcode='5901234123457')
        self.make_product(name='Red Gadget', barcode='4006381333931')

        response = self.client.get(
            self.url, {'search': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Blue Widget')

    def test_search_still_matches_name_and_description(self):
        self.make_product(barcode='5901234123457')
        for term in ('Blue', 'widget'):
            response = self.client.get(
                self.url, {'search': term}, HTTP_AUTHORIZATION=self.header,
            )
            self.assertEqual(response.data['count'], 1, term)

    def test_a_barcode_search_does_not_reach_another_account(self):
        other_account, _, _, _ = self.make_account_user('bc2')
        other_category = Category.objects.create(name='Theirs', account=other_account)
        self.make_product(
            name='Theirs', account=other_account, category=other_category,
            barcode='5901234123457',
        )

        response = self.client.get(
            self.url, {'search': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 0)

    def test_the_barcode_is_returned_by_the_api(self):
        self.make_product(barcode='5901234123457')
        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.data['results'][0]['barcode'], '5901234123457')

    def test_a_barcode_can_be_set_through_the_api(self):
        response = self.client.post(
            self.url,
            {
                'name': 'Scanned', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category.id,
                'barcode': '4006381333931',
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(Product.objects.get(name='Scanned').barcode, '4006381333931')

    def test_a_barcode_can_be_cleared_through_the_api(self):
        product = self.make_product(barcode='5901234123457')
        response = self.client.patch(
            f'{self.url}{product.id}/', {'barcode': ''},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200, response.data)
        product.refresh_from_db()
        self.assertIsNone(product.barcode)

    def test_two_products_in_one_account_cannot_share_a_barcode(self):
        self.make_product(barcode='5901234123457')
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.make_product(name='Loose goods', barcode='5901234123457')

    def test_two_accounts_may_use_the_same_barcode(self):
        # The constraint is per account, deliberately. An EAN identifies a real-world product,
        # so the first shop to record one must not block every other shop from recording it.
        other_account, _, _, _ = self.make_account_user('bc3')
        other_category = Category.objects.create(name='Theirs', account=other_account)

        self.make_product(barcode='5901234123457')
        self.make_product(
            name='Theirs', account=other_account, category=other_category,
            barcode='5901234123457',
        )
        self.assertEqual(Product.objects.filter(barcode='5901234123457').count(), 2)

    def test_any_number_of_products_may_have_no_barcode(self):
        # The barcode is optional, and NULLs do not collide in a unique index. This is why
        # save() normalizes '' to NULL: two empty strings *would* collide, and the second
        # product entered without a code would be rejected for no reason a user could see.
        for name in ('One', 'Two', 'Three'):
            self.make_product(name=name)
        self.assertEqual(Product.objects.filter(barcode__isnull=True).count(), 3)

    def test_the_api_rejects_a_duplicate_barcode_with_400_not_500(self):
        # Reusing a code is an everyday mistake — scanning the wrong box, or entering a
        # product twice — so it has to come back as a field error, not an uncaught
        # IntegrityError. DRF cannot generate this validator itself: `account` is stamped in
        # perform_create and is not a serializer field, so it sees `barcode` as unconstrained.
        self.make_product(barcode='5901234123457')
        response = self.client.post(
            self.url,
            {
                'name': 'Duplicate', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category.id,
                'barcode': '5901234123457',
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('barcode', response.data)
        self.assertEqual(Product.objects.filter(name='Duplicate').count(), 0)

    def test_a_duplicate_that_differs_only_in_whitespace_is_rejected(self):
        # save() strips before storing, so the check has to strip before comparing or a
        # trailing space walks straight past the serializer and into an IntegrityError.
        self.make_product(barcode='5901234123457')
        response = self.client.post(
            self.url,
            {
                'name': 'Padded', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category.id,
                'barcode': '  5901234123457 ',
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)

    def test_another_accounts_barcode_is_not_a_clash(self):
        other_account, _, _, _ = self.make_account_user('bc4')
        other_category = Category.objects.create(name='Theirs', account=other_account)
        self.make_product(
            name='Theirs', account=other_account, category=other_category,
            barcode='5901234123457',
        )

        response = self.client.post(
            self.url,
            {
                'name': 'Mine', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.category.id,
                'barcode': '5901234123457',
            },
            format='json',
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)

    def test_a_product_can_be_saved_holding_the_barcode_it_already_has(self):
        # Editing the price of a product must not fail because its own barcode "already
        # exists" — the clash check has to exclude the row being updated.
        product = self.make_product(barcode='5901234123457')
        response = self.client.patch(
            f'{self.url}{product.id}/',
            {'default_sell_price': '11.00', 'barcode': '5901234123457'},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_moving_a_barcode_onto_another_product_is_rejected(self):
        self.make_product(barcode='5901234123457')
        other = self.make_product(name='Red Gadget', barcode='4006381333931')

        response = self.client.patch(
            f'{self.url}{other.id}/', {'barcode': '5901234123457'},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        other.refresh_from_db()
        self.assertEqual(other.barcode, '4006381333931')

    def test_several_products_can_be_cleared_of_their_barcodes(self):
        # Clearing sends '', which save() turns into NULL. If it stored '' instead, the
        # second product cleared would collide with the first.
        first = self.make_product(barcode='5901234123457')
        second = self.make_product(name='Red Gadget', barcode='4006381333931')
        for product in (first, second):
            response = self.client.patch(
                f'{self.url}{product.id}/', {'barcode': ''},
                format='json', HTTP_AUTHORIZATION=self.header,
            )
            self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(Product.objects.filter(barcode__isnull=True).count(), 2)


class CSVExportTotalsTests(AccountFixtureMixin, TestCase):
    """
    The line-item exports: numeric money, a barcode, physical units, and a TOTALS footer.

    Money is written bare — no '$', no thousands separators — because a spreadsheet reads
    "$1,234.00" as text and silently refuses to sum the column. That is the whole point of
    an export, so it is asserted here rather than left to inspection.
    """

    MONEY_CELL = re.compile(r'^-?\d+\.\d{2}$')

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('csv')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.supplier = Supplier.objects.create(name='Acme', account=self.account)
        self.widget = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=500, account=self.account,
            barcode='5901234123457',
        )
        self.gadget = Product.objects.create(
            name='Gadget', description='', cost_price='2.00', default_sell_price='5.00',
            category=self.category, stock_quantity=500, account=self.account,
        )  # deliberately no barcode

    def rows(self, url, params=None):
        response = self.client.get(url, params or {}, HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.status_code, 200)
        return list(csv.reader(io.StringIO(response.content.decode())))

    def make_multi_line_order(self):
        """One order, two lines — the shape that exposed the repeated-profit bug."""
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.widget, quantity=2, unit_multiplier=3,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
        )  # 6 units, line total 60.00, line profit 36.00
        OrderItem.objects.create(
            order=order, product=self.gadget, quantity=4, unit_multiplier=2,
            unit_price=Decimal('5.00'), unit_cost_price=Decimal('2.00'),
        )  # 8 units, line total 40.00, line profit 24.00
        return order

    def make_purchase(self):
        purchase = Purchase.objects.create(
            account=self.account, supplier=self.supplier, exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.widget, quantity=5, unit_multiplier=2,
            unit_price=Decimal('4.00'),
        )  # 10 units, 40.00
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.gadget, quantity=3, unit_multiplier=1,
            unit_price=Decimal('2.00'),
        )  # 3 units, 6.00
        return purchase

    # --- money is numeric -------------------------------------------------------------

    def test_order_money_cells_carry_no_currency_symbol_or_separators(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body = rows[0], rows[1:-1]
        for column in ('Sell Price (USD)', 'Cost Price (USD)',
                       'Line Total (USD)', 'Line Profit (USD)'):
            for row in body:
                cell = row[header.index(column)]
                self.assertRegex(cell, self.MONEY_CELL, f'{column} -> {cell!r}')

    def test_the_totals_row_is_numeric_too(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, totals = rows[0], rows[-1]
        for column in ('Line Total (USD)', 'Line Profit (USD)'):
            self.assertRegex(totals[header.index(column)], self.MONEY_CELL)

    def test_a_large_total_is_not_written_with_thousands_separators(self):
        # 1,234.00 would split across two CSV cells and shift every column after it.
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.widget, quantity=1000, unit_multiplier=2,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
        )
        rows = self.rows('/inventory/orders/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[header.index('Line Total (USD)')], '20000.00')
        self.assertEqual(len(totals), len(header))

    def test_purchase_money_cells_are_numeric(self):
        self.make_purchase()
        rows = self.rows('/inventory/purchases/export/csv/')
        header, body = rows[0], rows[1:-1]
        for column in ('Unit Cost Price (USD)', 'Line Total (USD)'):
            for row in body:
                self.assertRegex(row[header.index(column)], self.MONEY_CELL)

    # --- barcode ----------------------------------------------------------------------

    def test_the_barcode_column_follows_the_product_name(self):
        self.make_multi_line_order()
        header = self.rows('/inventory/orders/export/csv/')[0]
        self.assertEqual(header.index('Barcode'), header.index('Product Name') + 1)

    def test_the_barcode_is_exported_and_is_blank_when_absent(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body = rows[0], rows[1:-1]
        by_product = {
            row[header.index('Product Name')]: row[header.index('Barcode')] for row in body
        }
        self.assertEqual(by_product['Widget'], '5901234123457')
        self.assertEqual(by_product['Gadget'], '')

    def test_the_purchases_export_carries_the_barcode_too(self):
        self.make_purchase()
        rows = self.rows('/inventory/purchases/export/csv/')
        header, body = rows[0], rows[1:-1]
        self.assertEqual(header.index('Barcode'), header.index('Product Name') + 1)
        self.assertIn('5901234123457', [row[header.index('Barcode')] for row in body])

    # --- total units ------------------------------------------------------------------

    def test_total_units_is_quantity_times_multiplier(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body = rows[0], rows[1:-1]
        units = {
            row[header.index('Product Name')]: row[header.index('Total Units')]
            for row in body
        }
        self.assertEqual(units['Widget'], '6')   # 2 * 3
        self.assertEqual(units['Gadget'], '8')   # 4 * 2

    def test_total_units_is_summed_in_the_totals_row(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[header.index('Total Units')], '14')

    def test_purchase_total_units(self):
        self.make_purchase()
        rows = self.rows('/inventory/purchases/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[header.index('Total Units')], '13')  # 10 + 3

    # --- the repeating profit column is gone ------------------------------------------

    def test_the_repeating_order_profit_column_is_gone(self):
        # It repeated the whole order's profit on every line, so any BI tool that summed the
        # column multiplied each order's profit by its line count. Line Profit replaces it.
        self.make_multi_line_order()
        header = self.rows('/inventory/orders/export/csv/')[0]
        self.assertNotIn('Total Profit (USD)', header)
        self.assertIn('Line Profit (USD)', header)

    def test_line_profit_is_per_line_not_per_order(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body = rows[0], rows[1:-1]
        profits = {
            row[header.index('Product Name')]: row[header.index('Line Profit (USD)')]
            for row in body
        }
        self.assertEqual(profits['Widget'], '36.00')
        self.assertEqual(profits['Gadget'], '24.00')

    def test_the_line_profit_column_sums_to_the_totals_row(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body, totals = rows[0], rows[1:-1], rows[-1]
        column = header.index('Line Profit (USD)')
        summed = sum(Decimal(row[column]) for row in body)
        self.assertEqual(f'{summed:.2f}', totals[column])

    # --- ISO timestamps ---------------------------------------------------------------

    def test_the_date_is_iso_8601(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        header, body = rows[0], rows[1:-1]
        cell = body[0][header.index('Date Placed')]
        self.assertRegex(cell, r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$')
        # Parseable by anything that claims ISO 8601 support, which is the point.
        datetime.fromisoformat(cell)

    def test_the_purchase_date_is_iso_8601(self):
        self.make_purchase()
        rows = self.rows('/inventory/purchases/export/csv/')
        header, body = rows[0], rows[1:-1]
        datetime.fromisoformat(body[0][header.index('Date Placed')])

    # --- totals behaviour (carried over from Phase 5) ---------------------------------

    def test_the_orders_export_ends_in_a_totals_row(self):
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/')
        self.assertEqual(rows[-1][0], 'TOTALS')

    def test_totals_span_more_than_one_order(self):
        self.make_multi_line_order()
        second = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=second, product=self.widget, quantity=1, unit_multiplier=1,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
        )  # 1 unit, line total 10.00, line profit 6.00

        rows = self.rows('/inventory/orders/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[header.index('Line Total (USD)')], '110.00')
        self.assertEqual(totals[header.index('Line Profit (USD)')], '66.00')
        self.assertEqual(totals[header.index('Total Units')], '15')

    def test_an_empty_orders_export_still_totals_zero(self):
        rows = self.rows('/inventory/orders/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[0], 'TOTALS')
        self.assertEqual(totals[header.index('Line Total (USD)')], '0.00')
        self.assertEqual(totals[header.index('Line Profit (USD)')], '0.00')
        self.assertEqual(totals[header.index('Total Units')], '0')

    def test_the_totals_row_respects_the_same_filters_as_the_rows(self):
        # A totals row computed over an unfiltered queryset would disagree with the rows
        # printed above it, which is worse than having no total at all.
        self.make_multi_line_order()
        rows = self.rows('/inventory/orders/export/csv/', {'year': '1999'})
        header, totals = rows[0], rows[-1]
        self.assertEqual(len(rows), 2)  # header + totals, no data rows
        self.assertEqual(totals[header.index('Line Total (USD)')], '0.00')

    def test_the_purchases_export_ends_in_a_totals_row(self):
        self.make_purchase()
        rows = self.rows('/inventory/purchases/export/csv/')
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[0], 'TOTALS')
        self.assertEqual(totals[header.index('Line Total (USD)')], '46.00')

    def test_every_row_has_the_same_width_as_the_header(self):
        # Cheap guard against a hand-built TOTALS row drifting out of step with the columns.
        self.make_multi_line_order()
        for url in ('/inventory/orders/export/csv/', '/inventory/purchases/export/csv/'):
            self.make_purchase()
            rows = self.rows(url)
            widths = {len(row) for row in rows}
            self.assertEqual(widths, {len(rows[0])}, url)

    def test_the_totals_row_adds_no_queries(self):
        # The export's constant-query-count guarantee predates this row and must survive it:
        # totals are accumulated in the loop that already walks the items, not re-queried.
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self.make_multi_line_order()
        with CaptureQueriesContext(connection) as small:
            self.rows('/inventory/orders/export/csv/')
        for _ in range(10):
            self.make_multi_line_order()
        with CaptureQueriesContext(connection) as large:
            self.rows('/inventory/orders/export/csv/')

        self.assertEqual(len(large.captured_queries), len(small.captured_queries))


class AdminCSVExportTotalsTests(AccountFixtureMixin, TestCase):
    """
    The admin actions are separate implementations with near-identical names. One row per
    order, so no product, barcode or unit columns — but the same numeric money and ISO dates.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('acsv')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.supplier = Supplier.objects.create(name='Acme', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=500, account=self.account,
        )

    def rows(self, response):
        return list(csv.reader(io.StringIO(response.content.decode())))

    def make_orders(self, count=2):
        for _ in range(count):
            order = Order.objects.create(account=self.account, exchange_rate=89000)
            OrderItem.objects.create(
                order=order, product=self.product, quantity=2, unit_multiplier=3,
                unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
            )  # 60.00 each

    def make_purchase(self):
        purchase = Purchase.objects.create(
            account=self.account, supplier=self.supplier, exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.product, quantity=5, unit_multiplier=2,
            unit_price=Decimal('4.00'),
        )  # 40.00

    def test_the_admin_orders_action_totals_its_value_column_numerically(self):
        from inventory.admin import export_orders_to_csv

        self.make_orders()
        rows = self.rows(export_orders_to_csv(None, None, Order.objects.all()))
        header, body, totals = rows[0], rows[1:-1], rows[-1]
        column = header.index('Total Value (USD)')
        self.assertEqual(totals[0], 'TOTALS')
        self.assertEqual(totals[column], '120.00')
        for row in body:
            self.assertEqual(row[column], '60.00')

    def test_the_admin_orders_action_writes_iso_dates(self):
        from inventory.admin import export_orders_to_csv

        self.make_orders(1)
        rows = self.rows(export_orders_to_csv(None, None, Order.objects.all()))
        header, body = rows[0], rows[1:-1]
        datetime.fromisoformat(body[0][header.index('Date Placed')])

    def test_the_admin_purchases_action_totals_its_cost_column_numerically(self):
        from inventory.admin import export_purchases_to_csv

        self.make_purchase()
        rows = self.rows(export_purchases_to_csv(None, None, Purchase.objects.all()))
        header, totals = rows[0], rows[-1]
        self.assertEqual(totals[0], 'TOTALS')
        self.assertEqual(totals[header.index('Total Cost (USD)')], '40.00')

    def test_the_admin_purchases_action_writes_iso_dates(self):
        from inventory.admin import export_purchases_to_csv

        self.make_purchase()
        rows = self.rows(export_purchases_to_csv(None, None, Purchase.objects.all()))
        header, body = rows[0], rows[1:-1]
        datetime.fromisoformat(body[0][header.index('Date Placed')])


class AnalyticsSeriesProfitTests(AccountFixtureMixin, TestCase):
    """
    Per-period profit. The summary payload has carried gross/net profit since Phase 3, but the
    series did not — which is why the profit tiles shipped without sparklines rather than
    drawing revenue-minus-purchases and calling it profit.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('ser')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=self.category, stock_quantity=1000, account=self.account,
        )

    def series(self, **params):
        response = self.client.get(
            '/inventory/analytics/', {'group_by': 'month', **params},
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        return response.data['series']

    def sell(self, quantity=10, when=None):
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=order, product=self.product, quantity=quantity, unit_multiplier=1,
            unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
        )
        if when:
            Order.objects.filter(pk=order.pk).update(placed_at=when)
        return order

    def spend(self, amount='25.00', when=None):
        return Expense.objects.create(
            account=self.account, description='Rent', amount=Decimal(amount),
            category=ExpenseCategory.RENT, spent_at=when or timezone.now(),
        )

    def test_a_period_carries_cogs_gross_and_net(self):
        self.sell(quantity=10)      # revenue 100.00, cogs 40.00
        self.spend('25.00')
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('100.00'))
        self.assertEqual(Decimal(str(row['total_cogs'])), Decimal('40.00'))
        self.assertEqual(Decimal(str(row['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(row['total_expenses'])), Decimal('25.00'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('35.00'))

    def test_the_existing_keys_are_unchanged(self):
        # total_costs is the purchases line the chart already draws. Renaming it here would
        # blank the cost series in the carousel with no error anywhere.
        self.sell()
        row = self.series()[-1]
        for key in ('period', 'total_revenue', 'total_costs', 'total_expenses'):
            self.assertIn(key, row)

    def test_inventory_purchases_stay_out_of_per_period_profit(self):
        self.sell(quantity=10)
        purchase = Purchase.objects.create(
            account=self.account,
            supplier=Supplier.objects.create(name='S', account=self.account),
            exchange_rate=89000,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.product, quantity=50,
            unit_price=Decimal('4.00'),
        )
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_costs'])), Decimal('200.00'))
        self.assertEqual(Decimal(str(row['gross_profit'])), Decimal('60.00'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('60.00'))

    def test_a_period_with_expenses_but_no_sales_reports_a_loss(self):
        # Net profit must be allowed to go negative; clamping it at zero would hide the month
        # a shop paid rent and sold nothing, which is the month worth seeing.
        self.spend('80.00')
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('0'))
        self.assertEqual(Decimal(str(row['net_profit'])), Decimal('-80.00'))

    def test_every_period_row_has_every_key(self):
        # A row missing a key renders as undefined in the sparkline and produces NaN SVG
        # coordinates — an invisible chart rather than an error.
        self.sell(quantity=5, when=timezone.now() - timedelta(days=200))
        self.spend('10.00')
        expected = {
            'period', 'total_revenue', 'total_costs', 'total_cogs',
            'gross_profit', 'total_expenses', 'net_profit',
        }
        rows = self.series()
        self.assertGreaterEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(set(row), expected)

    def test_revenue_and_cogs_do_not_fan_out_across_the_items_join(self):
        # Both expressions traverse `items`. Summed in separate annotate() calls on one
        # queryset they would multiply each other's row counts.
        order = Order.objects.create(account=self.account, exchange_rate=89000)
        for _ in range(3):
            OrderItem.objects.create(
                order=order, product=self.product, quantity=1, unit_multiplier=1,
                unit_price=Decimal('10.00'), unit_cost_price=Decimal('4.00'),
            )
        row = self.series()[-1]
        self.assertEqual(Decimal(str(row['total_revenue'])), Decimal('30.00'))
        self.assertEqual(Decimal(str(row['total_cogs'])), Decimal('12.00'))

    def test_each_dashboard_period_filter_returns_a_well_formed_series(self):
        # The three options in the dashboard's SegmentedControl. 'all_time' is deliberately
        # absent from PERIOD_WINDOW_DAYS and means "no filter".
        self.sell(quantity=10, when=timezone.now() - timedelta(days=400))
        self.sell(quantity=10, when=timezone.now() - timedelta(days=100))
        self.sell(quantity=10)
        self.spend('25.00')

        for period, group_by in (('all_time', 'year'), ('last_month', 'day'),
                                 ('last_year', 'month')):
            rows = self.series(period=period, group_by=group_by)
            self.assertTrue(rows, f'{period}/{group_by} returned no rows')
            for row in rows:
                self.assertIsInstance(row['period'], str)
                self.assertNotIsInstance(row['gross_profit'], str)

    def test_an_account_with_no_data_gets_an_empty_series_not_an_error(self):
        self.assertEqual(self.series(), [])


class BarcodeLookupFilterTests(AccountFixtureMixin, TestCase):
    """
    A scan needs an exact match. ?search= is icontains across name, description and barcode,
    so scanning '4006' would also return a product whose description happens to contain it —
    and the scanner adds items to orders without a human confirming each one.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('blk')
        self.category = Category.objects.create(name='Widgets', account=self.account)
        self.url = '/inventory/products/'

    def make_product(self, name, barcode=None, account=None, description=''):
        return Product.objects.create(
            name=name, description=description, cost_price='1.00',
            default_sell_price='2.00', category=self.category,
            account=account or self.account, barcode=barcode, stock_quantity=10,
        )

    def test_an_exact_barcode_returns_only_that_product(self):
        self.make_product('Widget', barcode='5901234123457')
        self.make_product('Gadget', barcode='4006381333931')

        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Widget')

    def test_a_partial_code_matches_nothing(self):
        self.make_product('Widget', barcode='5901234123457')
        response = self.client.get(
            self.url, {'barcode': '59012'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 0)

    def test_a_code_appearing_in_a_description_is_not_matched(self):
        self.make_product('Widget', barcode='5901234123457')
        self.make_product('Decoy', description='replaces part 5901234123457')
        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Widget')

    def test_a_scan_resolves_to_exactly_one_product(self):
        # Phase 4 allowed a code to be shared and this test asserted the API returned every
        # match. Barcodes are now unique per account, so a successful scan can only ever be
        # one product — which is what lets the scanner add a line without asking.
        self.make_product('Loose apples', barcode='2000000000001')
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.make_product('Loose pears', barcode='2000000000001')

        response = self.client.get(
            self.url, {'barcode': '2000000000001'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['results'][0]['name'], 'Loose apples')

    def test_the_lookup_is_account_scoped(self):
        other_account, _, _, _ = self.make_account_user('blk2')
        other_category = Category.objects.create(name='Theirs', account=other_account)
        Product.objects.create(
            name='Theirs', description='', cost_price='1.00', default_sell_price='2.00',
            category=other_category, account=other_account, barcode='5901234123457',
        )
        response = self.client.get(
            self.url, {'barcode': '5901234123457'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['count'], 0)


class CategoryManagementTests(AccountFixtureMixin, APITestCase):
    """CRUD for the Categories screen, plus the PROTECT foreign key it has to survive."""

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('catmgr')
        self.url = '/inventory/categories/'

    def make_product(self, category, name='Thing'):
        return Product.objects.create(
            account=self.account, name=name, category=category,
            cost_price='1.00', default_sell_price='2.00', stock_quantity=1,
        )

    def test_creating_a_category(self):
        response = self.client.post(
            self.url, {'name': 'Drinks'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['name'], 'Drinks')
        self.assertEqual(Category.objects.filter(account=self.account, name='Drinks').count(), 1)

    def test_a_new_category_reports_zero_products(self):
        # The serializer falls back to a query when the annotation is absent; a fresh category
        # has no annotation because it never came off the viewset's queryset.
        response = self.client.post(
            self.url, {'name': 'Empty'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.data['product_count'], 0)

    def test_listing_reports_how_many_products_each_category_holds(self):
        drinks = Category.objects.create(account=self.account, name='Drinks')
        Category.objects.create(account=self.account, name='Empty')
        self.make_product(drinks, 'Cola')
        self.make_product(drinks, 'Water')

        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)
        counts = {row['name']: row['product_count'] for row in response.data}
        self.assertEqual(counts, {'Drinks': 2, 'Empty': 0})

    def test_renaming_a_category(self):
        category = Category.objects.create(account=self.account, name='Drnks')
        response = self.client.patch(
            f'{self.url}{category.id}/', {'name': 'Drinks'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        category.refresh_from_db()
        self.assertEqual(category.name, 'Drinks')

    def test_deleting_an_unused_category(self):
        category = Category.objects.create(account=self.account, name='Unused')
        response = self.client.delete(
            f'{self.url}{category.id}/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Category.objects.filter(id=category.id).exists())

    def test_deleting_a_category_that_still_has_products_is_a_409_not_a_500(self):
        # Product.category is on_delete=PROTECT, so the delete raises ProtectedError. DRF has no
        # handler for it: without ProtectedDeleteMixin this is an uncaught 500.
        category = Category.objects.create(account=self.account, name='In use')
        self.make_product(category, 'Cola')

        response = self.client.delete(
            f'{self.url}{category.id}/', HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn('products', response.data['detail'])
        self.assertTrue(Category.objects.filter(id=category.id).exists())

    def test_duplicate_names_are_rejected_within_an_account(self):
        Category.objects.create(account=self.account, name='Drinks')
        response = self.client.post(
            self.url, {'name': 'Drinks'}, HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400)

    def test_two_accounts_may_each_have_a_category_of_the_same_name(self):
        other_account, _, other_client, other_header = self.make_account_user('catmgr2')
        Category.objects.create(account=self.account, name='Drinks')

        response = other_client.post(
            self.url, {'name': 'Drinks'}, HTTP_AUTHORIZATION=other_header,
        )

        self.assertEqual(response.status_code, 201)

    def test_categories_are_account_scoped(self):
        other_account, _, _, _ = self.make_account_user('catmgr3')
        Category.objects.create(account=other_account, name='Theirs')
        Category.objects.create(account=self.account, name='Mine')

        response = self.client.get(self.url, HTTP_AUTHORIZATION=self.header)

        self.assertEqual([row['name'] for row in response.data], ['Mine'])

    def test_cannot_delete_another_accounts_category(self):
        other_account, _, _, _ = self.make_account_user('catmgr4')
        theirs = Category.objects.create(account=other_account, name='Theirs')

        response = self.client.delete(
            f'{self.url}{theirs.id}/', HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 404)
        self.assertTrue(Category.objects.filter(id=theirs.id).exists())


    def test_a_duplicate_name_is_a_400_not_a_500(self):
        # The (account, name) constraint cannot be validated by DRF on its own: `account` is
        # never a serializer field, so without AccountUniqueNameMixin this is an uncaught
        # IntegrityError. Typing an existing name is an everyday action.
        Category.objects.create(account=self.account, name='Drinks')

        response = self.client.post(
            self.url, {'name': 'Drinks'}, HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('name', response.data)

    def test_a_duplicate_name_is_rejected_regardless_of_case(self):
        Category.objects.create(account=self.account, name='Drinks')

        response = self.client.post(
            self.url, {'name': 'drinks'}, HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 400)

    def test_surrounding_whitespace_is_stripped(self):
        response = self.client.post(
            self.url, {'name': '  Drinks  '}, HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['name'], 'Drinks')

    def test_renaming_a_category_to_its_own_name_is_allowed(self):
        # The uniqueness check must exclude the row being edited, or saving an unchanged form
        # rejects itself.
        category = Category.objects.create(account=self.account, name='Drinks')

        response = self.client.patch(
            f'{self.url}{category.id}/', {'name': 'Drinks'}, HTTP_AUTHORIZATION=self.header,
        )

        self.assertEqual(response.status_code, 200)


class SupplierProtectedDeleteTests(AccountFixtureMixin, APITestCase):
    """The same PROTECT trap as categories — Product.supplier is on_delete=PROTECT too."""

    def test_deleting_a_supplier_that_still_has_products_is_a_409_not_a_500(self):
        account, user, client, header = self.make_account_user('supdel')
        category = Category.objects.create(account=account, name='Cat')
        supplier = Supplier.objects.create(account=account, name='Acme')
        Product.objects.create(
            account=account, name='Thing', category=category, supplier=supplier,
            cost_price='1.00', default_sell_price='2.00', stock_quantity=1,
        )

        response = client.delete(
            f'/inventory/suppliers/{supplier.id}/', HTTP_AUTHORIZATION=header,
        )

        self.assertEqual(response.status_code, 409)
        self.assertTrue(Supplier.objects.filter(id=supplier.id).exists())


class TenantIsolationMatrixTests(AccountFixtureMixin, TestCase):
    """
    Exhaustive cross-account matrix over every scoped collection.

    The repo already had isolation tests, but each was written alongside the feature that
    introduced it, so coverage tracked whoever remembered. This drives every case from
    RESOURCES, which turns "someone added an endpoint and forgot to scope it" into a failing
    test rather than a silent leak. Adding a resource without adding it here is itself the
    visible omission.

    404 and never 403 throughout: a 403 on someone else's row confirms the row exists, which
    is an existence oracle across the tenant boundary. AccountScopedMixin gets this right by
    filtering the queryset rather than checking ownership after lookup, and this pins it.
    """

    # name -> callable(self, account) building one row owned by that account
    RESOURCES = [
        'products', 'categories', 'suppliers', 'customers', 'expenses', 'orders', 'purchases',
    ]

    def setUp(self):
        self.a_account, _, self.a_client, self.a_header = self.make_account_user('iso_a')
        self.b_account, _, self.b_client, self.b_header = self.make_account_user('iso_b')
        self.a = self.build_rows(self.a_account)
        self.b = self.build_rows(self.b_account)

    def build_rows(self, account):
        category = Category.objects.create(name='Widgets', account=account)
        supplier = Supplier.objects.create(name='Acme', account=account)
        # Name carries the account id so a leak is identifiable in a CSV: every other
        # row in this fixture is deliberately named identically across both accounts.
        customer = Customer.objects.create(
            name=f'Customer of {account.id}', phone_number='123', account=account,
        )
        product = Product.objects.create(
            name='Widget', description='', cost_price='4.00', default_sell_price='10.00',
            category=category, supplier=supplier, stock_quantity=100, account=account,
        )
        expense = Expense.objects.create(
            account=account, description='Rent', amount=Decimal('50.00'),
        )
        order = Order.objects.create(account=account, exchange_rate=89000, customer=customer)
        OrderItem.objects.create(
            order=order, product=product, quantity=1, unit_price=Decimal('10.00'),
            unit_cost_price=Decimal('4.00'),
        )
        purchase = Purchase.objects.create(
            account=account, exchange_rate=89000, supplier=supplier,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=product, quantity=1, unit_price=Decimal('4.00'),
        )
        return {
            'products': product, 'categories': category, 'suppliers': supplier,
            'customers': customer, 'expenses': expense, 'orders': order,
            'purchases': purchase,
        }

    def url(self, resource, row=None):
        return (
            f'/inventory/{resource}/{row.id}/' if row else f'/inventory/{resource}/'
        )

    # --- the matrix ---

    def test_a_list_never_contains_another_accounts_row(self):
        for resource in self.RESOURCES:
            with self.subTest(resource=resource):
                response = self.b_client.get(
                    self.url(resource), HTTP_AUTHORIZATION=self.b_header,
                )
                self.assertEqual(response.status_code, 200, response.data)
                body = response.data
                rows = body['results'] if isinstance(body, dict) and 'results' in body else body
                foreign_id = self.a[resource].id
                self.assertNotIn(
                    foreign_id, [row['id'] for row in rows],
                    f'{resource}: account A row leaked into account B list',
                )

    def test_retrieving_another_accounts_row_is_404(self):
        for resource in self.RESOURCES:
            with self.subTest(resource=resource):
                response = self.b_client.get(
                    self.url(resource, self.a[resource]), HTTP_AUTHORIZATION=self.b_header,
                )
                self.assertEqual(response.status_code, 404, f'{resource}: {response.status_code}')

    def test_patching_another_accounts_row_is_404_and_changes_nothing(self):
        for resource in self.RESOURCES:
            with self.subTest(resource=resource):
                row = self.a[resource]
                # Refresh first: the fixture assigned prices as strings, so comparing an
                # in-memory copy against a reloaded one reports a spurious difference.
                row.refresh_from_db()
                before = model_to_dict(row)
                response = self.b_client.patch(
                    self.url(resource, row), {'name': 'Hijacked', 'description': 'Hijacked'},
                    format='json', HTTP_AUTHORIZATION=self.b_header,
                )
                self.assertEqual(response.status_code, 404, f'{resource}: {response.status_code}')
                row.refresh_from_db()
                self.assertEqual(model_to_dict(row), before, f'{resource} was modified')

    def test_deleting_another_accounts_row_is_404_and_the_row_survives(self):
        for resource in self.RESOURCES:
            with self.subTest(resource=resource):
                row = self.a[resource]
                response = self.b_client.delete(
                    self.url(resource, row), HTTP_AUTHORIZATION=self.b_header,
                )
                self.assertEqual(response.status_code, 404, f'{resource}: {response.status_code}')
                self.assertTrue(
                    type(row).objects.filter(pk=row.pk).exists(), f'{resource} was deleted',
                )

    # --- POST referencing another account's row by id ---

    def test_a_product_cannot_be_created_against_another_accounts_category(self):
        response = self.b_client.post(
            '/inventory/products/',
            {
                'name': 'Sneaky', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.a['categories'].id,
            },
            format='json', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('category', response.data)

    def test_a_product_cannot_be_created_against_another_accounts_supplier(self):
        response = self.b_client.post(
            '/inventory/products/',
            {
                'name': 'Sneaky', 'description': '', 'cost_price': '1.00',
                'default_sell_price': '2.00', 'category': self.b['categories'].id,
                'supplier': self.a['suppliers'].id,
            },
            format='json', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('supplier', response.data)

    def test_an_order_cannot_be_placed_against_another_accounts_product(self):
        # The one that matters most: accepted, it would deduct stock from A's inventory.
        stock_before = self.a['products'].stock_quantity
        response = self.b_client.post(
            '/inventory/orders/',
            {'items': [{
                'product': self.a['products'].id, 'quantity': 1, 'unit_price': '10.00',
            }]},
            format='json', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.a['products'].refresh_from_db()
        self.assertEqual(self.a['products'].stock_quantity, stock_before)

    def test_an_order_cannot_be_placed_for_another_accounts_customer(self):
        response = self.b_client.post(
            '/inventory/orders/',
            {
                'customer': self.a['customers'].id,
                'items': [{
                    'product': self.b['products'].id, 'quantity': 1, 'unit_price': '10.00',
                }],
            },
            format='json', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 400, response.data)

    def test_a_purchase_cannot_be_recorded_against_another_accounts_product(self):
        stock_before = self.a['products'].stock_quantity
        response = self.b_client.post(
            '/inventory/purchases/',
            {
                'supplier': self.b['suppliers'].id,
                'items': [{
                    'product': self.a['products'].id, 'quantity': 5, 'unit_price': '4.00',
                }],
            },
            format='json', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.a['products'].refresh_from_db()
        self.assertEqual(self.a['products'].stock_quantity, stock_before)

    # --- nested images, which reach their account through the parent product ---

    def test_another_accounts_product_images_are_not_listable(self):
        response = self.b_client.get(
            f"/inventory/products/{self.a['products'].id}/images/",
            HTTP_AUTHORIZATION=self.b_header,
        )
        # Empty rather than 404: the nested list is scoped, so a foreign product simply has
        # no visible images. What must never happen is A's rows appearing in the body.
        rows = response.data['results'] if isinstance(response.data, dict) else response.data
        self.assertEqual(rows, [], response.data)

    def test_an_image_cannot_be_attached_to_another_accounts_product(self):
        image = SimpleUploadedFile('x.gif', _ONE_PIXEL_GIF, content_type='image/gif')
        response = self.b_client.post(
            f"/inventory/products/{self.a['products'].id}/images/",
            {'image': image}, format='multipart', HTTP_AUTHORIZATION=self.b_header,
        )
        self.assertEqual(response.status_code, 404, response.status_code)
        self.assertEqual(self.a['products'].images.count(), 0)

    # --- the manually-scoped APIViews, which AccountScopedMixin does not cover ---

    def test_analytics_counts_only_the_callers_rows(self):
        # AnalyticsView is an APIView, so it scopes by hand — the mixin does not apply. A
        # regression here is invisible: the numbers are merely wrong, never an error.
        response = self.b_client.get('/inventory/analytics/', HTTP_AUTHORIZATION=self.b_header)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Decimal(str(response.data['total_revenue'])), Decimal('10.00'))
        self.assertEqual(Decimal(str(response.data['total_expenses'])), Decimal('50.00'))
        self.assertEqual(response.data['products_count'], 1)

    def test_the_csv_exports_carry_only_the_callers_rows(self):
        # Both accounts hold identically-named rows, so a leak cannot be spotted by name.
        # Row counts can: one data row each, plus a header, plus a TOTALS footer where the
        # exporter has one.
        expected_rows = {
            '/inventory/orders/export/csv/': 3,
            '/inventory/purchases/export/csv/': 3,
            '/inventory/products/export/csv/': 2,  # catalogue export has no TOTALS row
        }
        for path, expected in expected_rows.items():
            with self.subTest(path=path):
                response = self.b_client.get(path, HTTP_AUTHORIZATION=self.b_header)
                self.assertEqual(response.status_code, 200)
                body = response.content.decode()
                rows = [line for line in body.splitlines() if line.strip()]
                self.assertEqual(len(rows), expected, f'{path} returned {rows}')
                # A's customer name is unique to A and would show up in any order leak.
                self.assertNotIn(f'Customer of {self.a_account.id}', body)


class SubscriptionGateMatrixTests(AccountFixtureMixin, TestCase):
    """
    Every non-live status must lock every protected endpoint, and must *not* lock the
    endpoints that exist to get the account back to live.

    Phase 2.5a's documented trap is that the wall blocks its own exit: miss one escape hatch
    and the account is unrecoverable without an admin. This asserts both halves for every
    status rather than for the one status a feature happened to be written against.
    """

    NON_LIVE = [
        Account.PENDING_VERIFICATION,
        Account.PENDING_PAYMENT,
        Account.PAST_DUE,
        Account.CANCELED,
    ]

    PROTECTED = [
        '/inventory/products/', '/inventory/categories/', '/inventory/suppliers/',
        '/inventory/customers/', '/inventory/expenses/', '/inventory/orders/',
        '/inventory/purchases/', '/inventory/analytics/',
        '/inventory/orders/export/csv/', '/inventory/purchases/export/csv/',
        '/inventory/products/export/csv/',
    ]

    ESCAPE_HATCHES = [
        ('get', '/accounts/subscription/'),
        ('post', '/accounts/verify-email/'),
        ('post', '/accounts/resend-code/'),
        ('post', '/accounts/password-reset/request/'),
        ('get', '/billing/config/'),
        ('post', '/billing/redeem-key/'),
    ]

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('gate')

    def set_status(self, status_value, expires_at=None):
        self.account.subscription_status = status_value
        self.account.expires_at = expires_at
        self.account.save(update_fields=['subscription_status', 'expires_at'])

    def test_every_non_live_status_locks_every_protected_endpoint(self):
        for status_value in self.NON_LIVE:
            self.set_status(status_value)
            for path in self.PROTECTED:
                with self.subTest(status=status_value, path=path):
                    response = self.client.get(path, HTTP_AUTHORIZATION=self.header)
                    self.assertEqual(response.status_code, 403, f'{status_value} {path}')

    def test_active_but_expired_is_treated_as_locked(self):
        # The column says active; expires_at says otherwise. Liveness is computed from both,
        # because nothing flips active -> past_due without a scheduled job that does not exist.
        self.set_status(Account.ACTIVE, expires_at=timezone.now() - timedelta(days=1))
        for path in self.PROTECTED:
            with self.subTest(path=path):
                response = self.client.get(path, HTTP_AUTHORIZATION=self.header)
                self.assertEqual(response.status_code, 403, path)

    def test_active_and_unexpired_reaches_everything(self):
        self.set_status(Account.ACTIVE, expires_at=timezone.now() + timedelta(days=1))
        for path in self.PROTECTED:
            with self.subTest(path=path):
                response = self.client.get(path, HTTP_AUTHORIZATION=self.header)
                self.assertEqual(response.status_code, 200, path)

    def test_the_escape_hatches_stay_reachable_from_every_locked_status(self):
        for status_value in self.NON_LIVE:
            self.set_status(status_value)
            for method, path in self.ESCAPE_HATCHES:
                with self.subTest(status=status_value, path=path):
                    response = getattr(self.client, method)(
                        path, {}, format='json', HTTP_AUTHORIZATION=self.header,
                    )
                    # Any answer but 403 — these validate their input and may 400 or 429,
                    # which is fine. 403 is the failure: the wall blocking its own exit.
                    self.assertNotEqual(
                        response.status_code, 403,
                        f'{status_value}: {path} is behind the paywall it exists to lift',
                    )

    def test_a_user_with_no_membership_reaches_nothing(self):
        stranger = User.objects.create_user(username='stranger', password='pw12345!')
        header = f'JWT {RefreshToken.for_user(stranger).access_token}'
        for path in self.PROTECTED:
            with self.subTest(path=path):
                response = self.client.get(path, HTTP_AUTHORIZATION=header)
                self.assertEqual(response.status_code, 403, path)

    def test_anonymous_reaches_nothing(self):
        for path in self.PROTECTED:
            with self.subTest(path=path):
                self.assertEqual(APIClient().get(path).status_code, 401, path)


class CSVFormulaInjectionTests(AccountFixtureMixin, TestCase):
    """
    A cell starting '=', '+', '-', '@', tab or CR executes as a formula when the file is
    opened in Excel, LibreOffice or Sheets. Every exporter writes user-controlled names.

    The path that makes this more than self-harm: the *admin* exports span every account and
    are opened by the platform superadmin, so any subscriber can name a customer
    `=HYPERLINK(...)` and attack the platform owner.
    """

    HOSTILE = '=HYPERLINK("http://attacker","Click")'

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('csvi')
        self.category = Category.objects.create(name=self.HOSTILE, account=self.account)
        self.supplier = Supplier.objects.create(name=self.HOSTILE, account=self.account)
        self.customer = Customer.objects.create(name=self.HOSTILE, account=self.account)
        self.product = Product.objects.create(
            name=self.HOSTILE, description='', cost_price='4.00',
            default_sell_price='10.00', category=self.category, supplier=self.supplier,
            stock_quantity=100, account=self.account, barcode='=1+1',
        )
        order = Order.objects.create(
            account=self.account, exchange_rate=89000, customer=self.customer,
        )
        OrderItem.objects.create(
            order=order, product=self.product, quantity=1, unit_price=Decimal('10.00'),
            unit_cost_price=Decimal('4.00'),
        )
        purchase = Purchase.objects.create(
            account=self.account, exchange_rate=89000, supplier=self.supplier,
        )
        PurchaseItem.objects.create(
            purchase_order=purchase, product=self.product, quantity=1,
            unit_price=Decimal('4.00'),
        )

    def assert_no_live_formula(self, body, path):
        for row in csv.reader(io.StringIO(body)):
            for cell in row:
                self.assertFalse(
                    cell.startswith(('=', '+', '@', '\t', '\r')),
                    f'{path}: cell {cell!r} would execute as a formula',
                )

    def test_no_export_emits_a_live_formula(self):
        for path in (
            '/inventory/orders/export/csv/',
            '/inventory/purchases/export/csv/',
            '/inventory/products/export/csv/',
        ):
            with self.subTest(path=path):
                response = self.client.get(path, HTTP_AUTHORIZATION=self.header)
                self.assertEqual(response.status_code, 200)
                self.assert_no_live_formula(response.content.decode(), path)

    def test_the_hostile_name_is_still_present_just_defused(self):
        # Escaping must neutralise the cell, not drop the data — the owner still has to be
        # able to see which product this is.
        response = self.client.get(
            '/inventory/products/export/csv/', HTTP_AUTHORIZATION=self.header,
        )
        self.assertIn('HYPERLINK', response.content.decode())

    def test_negative_money_is_not_escaped_into_text(self):
        # The trap. '-' is in the escape set and money() renders a negative line profit as
        # '-6.00'. Escaping that would emit "'-6.00", turning the numeric columns back into
        # text and undoing the export redesign that made them summable.
        losing = Order.objects.create(account=self.account, exchange_rate=89000)
        OrderItem.objects.create(
            order=losing, product=self.product, quantity=1,
            unit_price=Decimal('1.00'), unit_cost_price=Decimal('7.00'),
        )
        response = self.client.get(
            '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header,
        )
        body = response.content.decode()
        self.assertIn('-6.00', body)
        self.assertNotIn("'-6.00", body)

    def test_the_admin_exports_are_escaped_too(self):
        # The two admin actions are separate code with near-identical names; CLAUDE.md warns
        # that a formula fix usually needs both. This is the half a scanner did not flag.
        admin_user = User.objects.create_superuser(
            username='root8', email='root8@example.com', password='pw12345!',
        )
        admin_client = Client()
        admin_client.force_login(admin_user)

        for model, action in (
            ('order', 'export_orders_to_csv'), ('purchase', 'export_purchases_to_csv'),
        ):
            with self.subTest(model=model):
                ids = [str(row.pk) for row in {
                    'order': Order, 'purchase': Purchase,
                }[model].objects.all()]
                response = admin_client.post(
                    f'/admin/inventory/{model}/',
                    {'action': action, '_selected_action': ids},
                )
                self.assertEqual(response.status_code, 200, response.status_code)
                body = b''.join(response.streaming_content).decode() if getattr(
                    response, 'streaming', False,
                ) else response.content.decode()
                self.assert_no_live_formula(body, action)


class ExportThrottleTests(AccountFixtureMixin, TestCase):
    """
    The exports walk every line item an account has ever recorded — by far the most
    expensive thing an authenticated caller can ask for, and the cheapest to ask for in a
    loop.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('thr1')
        self.other_account, _, self.other_client, self.other_header = self.make_account_user(
            'thr2',
        )

    def setUp_rates(self, rate):
        # DRF copies DEFAULT_THROTTLE_RATES into SimpleRateThrottle.THROTTLE_RATES as a class
        # attribute at import, so override_settings(REST_FRAMEWORK=...) never reaches it —
        # api_settings rebuilds a new dict while the class keeps the old one. Patching the
        # dict in place is what actually changes the rate.
        return mock.patch.dict(ScopedRateThrottle.THROTTLE_RATES, {'exports': rate})

    def test_the_exports_throttle_after_the_configured_rate(self):
        cache.clear()
        with self.setUp_rates('3/hour'):
            statuses = [
                self.client.get(
                    '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header,
                ).status_code
                for _ in range(4)
            ]
        self.assertEqual(statuses[:3], [200, 200, 200])
        self.assertEqual(statuses[3], 429)

    def test_all_three_exports_share_one_budget(self):
        # One scope across the three views: they are equally expensive, so a per-view budget
        # would just mean three times the ceiling for the same database work.
        cache.clear()
        with self.setUp_rates('2/hour'):
            self.client.get('/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header)
            self.client.get('/inventory/purchases/export/csv/', HTTP_AUTHORIZATION=self.header)
            response = self.client.get(
                '/inventory/products/export/csv/', HTTP_AUTHORIZATION=self.header,
            )
        self.assertEqual(response.status_code, 429)

    def test_one_account_exhausting_its_budget_does_not_affect_another(self):
        # Per-user, not global. A shared counter would let any one subscriber deny the
        # export to everyone else on the platform.
        cache.clear()
        with self.setUp_rates('2/hour'):
            for _ in range(3):
                self.client.get(
                    '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.header,
                )
            response = self.other_client.get(
                '/inventory/orders/export/csv/', HTTP_AUTHORIZATION=self.other_header,
            )
        self.assertEqual(response.status_code, 200)

    def test_the_configured_production_rate_is_sane(self):
        # Above any real use (the SPA exports on a button press), below anything that ties up
        # the database. Pinned so it cannot drift to a value that throttles normal work.
        rate = settings.REST_FRAMEWORK['DEFAULT_THROTTLE_RATES']['exports']
        count, _, period = rate.partition('/')
        self.assertEqual(period, 'hour')
        self.assertGreaterEqual(int(count), 10)


class CORSConfigurationTests(TestCase):
    """
    CORS_ALLOW_ALL_ORIGINS was a dev convenience carried since before there were accounts.
    It is asserted here rather than merely set, because the failure is silent: a wildcard in
    production is invisible until someone points it out.
    """

    def test_the_wildcard_is_off_when_debug_is_off(self):
        """
        Evaluated in a subprocess, because the test runner forces settings.DEBUG to False
        *after* ims.settings has been imported — so in-process the two values can never
        agree, and asserting on them here would prove nothing about production.
        """
        script = (
            'import django, os; django.setup(); from django.conf import settings; '
            'print(settings.DEBUG, settings.CORS_ALLOW_ALL_ORIGINS, '
            'len(settings.CORS_ALLOWED_ORIGINS))'
        )
        result = subprocess.run(
            [sys.executable, '-c', script],
            capture_output=True, text=True, timeout=120,
            env={
                **os.environ,
                'DJANGO_SETTINGS_MODULE': 'ims.settings',
                'DJANGO_DEBUG': 'False',
                # Required since the F-06 boot guard: DEBUG off with the committed
                # default key is now a refused boot, which is the point of that guard.
                'DJANGO_SECRET_KEY': 'z' * 60,
                'ALLOWED_HOSTS': 'example.com',
            },
            cwd=str(settings.BASE_DIR),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        debug, wildcard, allowlist_size = result.stdout.split()
        self.assertEqual(debug, 'False')
        self.assertEqual(wildcard, 'False', 'CORS is wide open with DEBUG off')
        self.assertGreater(int(allowlist_size), 0, 'no allowlist to fall back on')

    def test_the_allowlist_can_be_set_from_the_environment(self):
        # So adding a domain is a config change, not a code deploy.
        script = (
            'import django; django.setup(); from django.conf import settings; '
            'print(",".join(settings.CORS_ALLOWED_ORIGINS))'
        )
        result = subprocess.run(
            [sys.executable, '-c', script],
            capture_output=True, text=True, timeout=120,
            env={
                **os.environ,
                'DJANGO_SETTINGS_MODULE': 'ims.settings',
                'DJANGO_DEBUG': 'False',
                # Required since the F-06 boot guard: DEBUG off with the committed
                # default key is now a refused boot, which is the point of that guard.
                'DJANGO_SECRET_KEY': 'z' * 60,
                'ALLOWED_HOSTS': 'example.com',
                'CORS_ALLOWED_ORIGINS': 'https://a.example.com, https://b.example.com',
            },
            cwd=str(settings.BASE_DIR),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(), 'https://a.example.com,https://b.example.com',
        )

    def test_an_allowlist_exists_for_when_the_wildcard_is_off(self):
        self.assertTrue(settings.CORS_ALLOWED_ORIGINS)

    def test_an_unlisted_origin_gets_no_allow_origin_header(self):
        with override_settings(
            DEBUG=False,
            CORS_ALLOW_ALL_ORIGINS=False,
            CORS_ALLOWED_ORIGINS=['https://ims.example.com'],
        ):
            response = self.client.get(
                '/inventory/products/', HTTP_ORIGIN='https://attacker.example',
            )
            self.assertNotIn('Access-Control-Allow-Origin', response)

    def test_a_listed_origin_is_allowed(self):
        with override_settings(
            DEBUG=False,
            CORS_ALLOW_ALL_ORIGINS=False,
            CORS_ALLOWED_ORIGINS=['https://ims.example.com'],
        ):
            response = self.client.get(
                '/inventory/products/', HTTP_ORIGIN='https://ims.example.com',
            )
            self.assertEqual(
                response['Access-Control-Allow-Origin'], 'https://ims.example.com',
            )


class SecretKeyBootGuardTests(TestCase):
    """
    The app must refuse to start in production on the SECRET_KEY committed to this repo.

    SIMPLE_JWT has no separate SIGNING_KEY, so that key signs every token: a deploy that
    forgets DJANGO_SECRET_KEY lets anyone who can read the source mint a token for any user.
    A silent insecure boot is the worst outcome, because nothing surfaces until the forged
    tokens do.

    Subprocesses throughout: the guard runs at settings-import time, and this process has
    already imported them.
    """

    def boot(self, env):
        return subprocess.run(
            [sys.executable, '-c', 'import django; django.setup(); print("booted")'],
            capture_output=True, text=True, timeout=120,
            env={
                **{k: v for k, v in os.environ.items() if k != 'DJANGO_SECRET_KEY'},
                'DJANGO_SETTINGS_MODULE': 'ims.settings',
                'ALLOWED_HOSTS': 'example.com',
                **env,
            },
            cwd=str(settings.BASE_DIR),
        )

    def test_it_refuses_to_boot_with_the_default_key_and_debug_off(self):
        result = self.boot({'DJANGO_DEBUG': 'False'})
        self.assertNotEqual(result.returncode, 0, 'booted on the insecure default key')
        self.assertIn('DJANGO_SECRET_KEY', result.stderr)
        self.assertIn('ImproperlyConfigured', result.stderr)

    def test_it_boots_with_a_real_key_and_debug_off(self):
        result = self.boot({
            'DJANGO_DEBUG': 'False',
            'DJANGO_SECRET_KEY': 'x' * 60,
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('booted', result.stdout)

    def test_local_development_is_untouched(self):
        # The guard is scoped to `not DEBUG`. If it fired in development, every contributor
        # would have to set the variable before the app would run at all.
        result = self.boot({'DJANGO_DEBUG': 'True'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('booted', result.stdout)


class OWASPControlTests(AccountFixtureMixin, TestCase):
    """
    One test per OWASP Top 10 (2021) control that automated scanning cannot check.

    Deliberately assertions about *behaviour*, not about the presence of a setting: a scanner
    can see `SECURE_HSTS_SECONDS`, but only a request can show whether the header is actually
    on the response the browser gets.
    """

    def setUp(self):
        self.account, self.user, self.client, self.header = self.make_account_user('owasp')
        self.other_account, self.other_user, self.other_client, self.other_header = (
            self.make_account_user('owasp2')
        )
        self.category = Category.objects.create(name='Widgets', account=self.account)

    # --- A01: Broken Access Control ---------------------------------------------------

    def test_a01_the_user_endpoint_lists_only_the_caller(self):
        # djoser mounts a full ModelViewSet at /auth/users/. If it listed every user, the
        # platform's whole customer roster would be readable by any subscriber.
        response = self.client.get('/auth/users/', HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response.status_code, 200)
        ids = [row['id'] for row in response.data]
        self.assertEqual(ids, [self.user.id])

    def test_a01_another_users_account_cannot_be_read_or_changed(self):
        for method, expected in (('get', 404), ('patch', 404), ('delete', 403)):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    f'/auth/users/{self.other_user.id}/',
                    {'email': 'hijack@example.com'},
                    format='json',
                    HTTP_AUTHORIZATION=self.header,
                )
                self.assertEqual(response.status_code, expected)
        self.other_user.refresh_from_db()
        self.assertEqual(self.other_user.email, '')

    def test_a01_a_missing_row_and_a_foreign_row_are_indistinguishable(self):
        # Both 404. A 403 on the foreign row would confirm it exists, turning the endpoint
        # into an existence oracle across the tenant boundary.
        foreign = Category.objects.create(name='Theirs', account=self.other_account)
        foreign_status = self.client.get(
            f'/inventory/categories/{foreign.id}/', HTTP_AUTHORIZATION=self.header,
        ).status_code
        missing_status = self.client.get(
            '/inventory/categories/99999999/', HTTP_AUTHORIZATION=self.header,
        ).status_code
        self.assertEqual(foreign_status, missing_status, 'existence oracle')
        self.assertEqual(foreign_status, 404)

    # --- A02: Cryptographic Failures --------------------------------------------------

    def test_a02_no_password_material_is_ever_serialized(self):
        for path in ('/auth/users/me/', '/accounts/subscription/'):
            with self.subTest(path=path):
                body = str(
                    self.client.get(path, HTTP_AUTHORIZATION=self.header).data
                ).lower()
                for leak in ('password', 'pbkdf2', 'argon2', 'code_hash'):
                    self.assertNotIn(leak, body, f'{path} leaked {leak}')

    def test_a02_the_otp_is_never_returned_in_a_response(self):
        # The code goes to the inbox and nowhere else. Returning it "for convenience" would
        # make the whole email round trip decorative.
        response = self.client.post(
            '/accounts/password-reset/request/', HTTP_AUTHORIZATION=self.header,
        )
        row = EmailVerification.objects.filter(user=self.user).first()
        self.assertIsNotNone(row)
        body = str(response.data)
        self.assertNotIn(row.code_hash, body)
        self.assertNotIn('code', response.data)

    def test_a02_codes_and_keys_are_generated_with_secrets_not_random(self):
        # Asserted structurally: `random` is a Mersenne Twister whose state is recoverable
        # from observed output, so a predictable OTP or discount key is a real compromise.
        import inspect

        from accounts.billing import keys as keys_module

        for module in (verification_module, keys_module):
            with self.subTest(module=module.__name__):
                source = inspect.getsource(module)
                self.assertIn('secrets', source)
                self.assertNotRegex(source, r'^import random', )

    def test_a02_the_stored_otp_is_not_the_plaintext_code(self):
        _, code = verification_module.issue_code(self.user)
        row = EmailVerification.objects.filter(user=self.user).first()
        self.assertNotEqual(row.code_hash, code)
        self.assertEqual(len(row.code_hash), 64)  # HMAC-SHA256 hex

    # --- A03: Injection ---------------------------------------------------------------

    def test_a03_a_sql_metacharacter_search_is_treated_as_text(self):
        Product.objects.create(
            name="Robert'); DROP TABLE inventory_product;--", description='',
            cost_price='1.00', default_sell_price='2.00', category=self.category,
            stock_quantity=1, account=self.account,
        )
        response = self.client.get(
            '/inventory/products/', {'search': "'); DROP TABLE inventory_product;--"},
            HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200)
        # The table still exists, which is the actual assertion.
        self.assertEqual(Product.objects.count(), 1)

    def test_a03_a_script_tag_in_a_name_round_trips_as_data(self):
        # The API is JSON and React escapes by default, so this is about the server not
        # "helpfully" rendering anything. It must come back byte-identical, not stripped —
        # silent mangling of a legitimate name is its own bug.
        payload = '<script>alert(1)</script>'
        response = self.client.post(
            '/inventory/categories/', {'name': payload},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['name'], payload)

    def test_a03_no_export_emits_a_live_formula(self):
        # The CSV half of injection, covered exhaustively in CSVFormulaInjectionTests; this
        # is the OWASP-facing restatement so the category is not silently uncovered.
        Product.objects.create(
            name='=cmd|calc', description='', cost_price='1.00',
            default_sell_price='2.00', category=self.category, stock_quantity=1,
            account=self.account,
        )
        body = self.client.get(
            '/inventory/products/export/csv/', HTTP_AUTHORIZATION=self.header,
        ).content.decode()
        for row in csv.reader(io.StringIO(body)):
            for cell in row:
                self.assertFalse(cell.startswith(('=', '+', '@')))

    # --- A04: Insecure Design ---------------------------------------------------------

    def test_a04_sensitive_endpoints_declare_a_throttle(self):
        from accounts import views as account_views
        from accounts.billing import views as billing_views

        for view in (
            account_views.VerifyEmailView, account_views.ResendCodeView,
            account_views.PasswordResetRequestView, account_views.PasswordResetVerifyView,
            account_views.PasswordResetConfirmView, billing_views.RedeemKeyView,
        ):
            with self.subTest(view=view.__name__):
                self.assertTrue(
                    view.throttle_classes,
                    f'{view.__name__} has no throttle — it takes a guessable credential',
                )

    def test_a04_stock_deduction_is_atomic_and_locked(self):
        # The transaction control that stops two concurrent orders both passing validation
        # and both deducting. Asserted structurally because provoking the race in a test
        # would need real concurrency against a shared database.
        import inspect

        from inventory import serializers as serializers_module

        source = inspect.getsource(serializers_module.CreateOrderSerializer)
        self.assertIn('select_for_update', source)
        self.assertIn('atomic', source)

    def test_a04_an_order_beyond_stock_is_refused(self):
        product = Product.objects.create(
            name='Scarce', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=5, account=self.account,
        )
        response = self.client.post(
            '/inventory/orders/',
            {'items': [{'product': product.id, 'quantity': 6, 'unit_price': '2.00'}]},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400)
        product.refresh_from_db()
        self.assertEqual(product.stock_quantity, 5)

    # --- A05: Security Misconfiguration -----------------------------------------------

    def test_a05_the_security_headers_are_on_a_real_response(self):
        response = self.client.get('/inventory/products/', HTTP_AUTHORIZATION=self.header)
        self.assertEqual(response['X-Frame-Options'], 'DENY')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(
            response['Referrer-Policy'], 'strict-origin-when-cross-origin',
        )
        self.assertIn('Content-Security-Policy', response)

    def test_a05_the_csp_forbids_inline_and_eval_script(self):
        # The directive that matters: JWTs live in localStorage, so an XSS is a full account
        # takeover and script-src is what limits the blast radius.
        policy = self.client.get(
            '/inventory/products/', HTTP_AUTHORIZATION=self.header,
        )['Content-Security-Policy']
        self.assertIn("script-src 'self'", policy)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", policy)
        self.assertNotIn('unsafe-eval', policy)
        self.assertIn("object-src 'none'", policy)
        self.assertIn("frame-ancestors 'none'", policy)

    def test_a05_the_debug_toolbar_is_absent_when_debug_is_off(self):
        # Checked in a subprocess: INSTALLED_APPS is built at settings-import time from the
        # env, and the test runner flips settings.DEBUG only afterwards — so in-process this
        # process legitimately has the toolbar loaded and an assertion here proves nothing.
        script = (
            'import django; django.setup(); from django.conf import settings; '
            'print("debug_toolbar" in settings.INSTALLED_APPS, '
            'any("debug_toolbar" in str(m) for m in settings.MIDDLEWARE))'
        )
        result = subprocess.run(
            [sys.executable, '-c', script],
            capture_output=True, text=True, timeout=120,
            env={
                **os.environ,
                'DJANGO_SETTINGS_MODULE': 'ims.settings',
                'DJANGO_DEBUG': 'False',
                'DJANGO_SECRET_KEY': 'y' * 60,
                'ALLOWED_HOSTS': 'example.com',
            },
            cwd=str(settings.BASE_DIR),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ['False', 'False'])

    def test_a05_every_routed_inventory_view_requires_authentication(self):
        """
        Generalises the finding that retired the `playground` app.

        That app held `say_hello`, which read `Order.objects` with no account filter and no
        authentication. It was never routed, so it was never exploitable — but it sat one
        innocuous line of `urls.py` away from being a cross-tenant leak, and it has now been
        deleted outright rather than left tripwired.

        The lesson generalises, so this replaces the app-specific check: every view reachable
        under /inventory/ must demand an authenticated caller. A plain Django view, which has
        no `permission_classes` at all, routed here would be the same bug wearing a new name.
        """
        from rest_framework.permissions import IsAuthenticated

        from inventory import urls as inventory_urls

        unprotected = []
        for pattern in inventory_urls.urlpatterns:
            callback = getattr(pattern, 'callback', None)
            view_class = getattr(callback, 'cls', None) or getattr(
                callback, 'view_class', None,
            )
            if view_class is None:
                unprotected.append(f'{pattern.pattern}: not a class-based DRF view')
                continue
            permissions = getattr(view_class, 'permission_classes', [])
            if not any(issubclass(p, IsAuthenticated) for p in permissions):
                unprotected.append(f'{pattern.pattern}: {view_class.__name__} {permissions}')

        self.assertEqual(
            unprotected, [], 'these inventory routes do not require authentication',
        )

    # --- A06: Vulnerable & Outdated Components ----------------------------------------

    def test_a06_no_declared_python_dependency_has_a_known_cve(self):
        # Runs pip-audit against Pipfile.lock's `default` section only — the application's
        # own dependencies. Scanning the whole virtualenv instead reports CVEs in the audit
        # tooling itself (semgrep pins a vulnerable `mcp`), which is not an app finding.
        import json

        lock = json.loads((settings.BASE_DIR / 'Pipfile.lock').read_text())
        pinned = [
            f'{name}{meta["version"]}'
            for name, meta in lock['default'].items()
            if meta.get('version', '').startswith('==')
        ]
        audit = shutil.which('pip-audit') or str(
            Path(sys.executable).with_name('pip-audit')
        )
        if not Path(audit).exists():
            self.skipTest('pip-audit is not installed in this environment')

        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as handle:
            handle.write('\n'.join(pinned))
            requirements = handle.name
        try:
            result = subprocess.run(
                [audit, '--progress-spinner', 'off', '-r', requirements],
                capture_output=True, text=True, timeout=600,
            )
        finally:
            os.unlink(requirements)

        self.assertEqual(
            result.returncode, 0,
            f'pip-audit reported vulnerable dependencies:\n{result.stdout}\n{result.stderr}',
        )

    # --- A07: Identification & Authentication Failures --------------------------------

    def test_a07_changing_the_password_invalidates_existing_refresh_tokens(self):
        stale = RefreshToken.for_user(self.user)
        _, code = verification_module.issue_code(
            self.user, purpose=verification_module.PASSWORD_RESET,
        )
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {
                'code': code, 'new_password': 'brandNewPw!2026',
                'confirm_password': 'brandNewPw!2026',
            },
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 200, response.data)
        refreshed = APIClient().post(
            '/auth/jwt/refresh/', {'refresh': str(stale)}, format='json',
        )
        self.assertEqual(refreshed.status_code, 401)

    def test_a07_logout_blacklists_the_refresh_token(self):
        token = RefreshToken.for_user(self.user)
        self.client.post(
            '/auth/jwt/blacklist/', {'refresh': str(token)},
            format='json', HTTP_AUTHORIZATION=self.header,
        )
        refreshed = APIClient().post(
            '/auth/jwt/refresh/', {'refresh': str(token)}, format='json',
        )
        self.assertEqual(refreshed.status_code, 401)

    def test_a07_repeated_bad_logins_lock_the_account_out(self):
        User.objects.create_user(username='brute@example.com', password='rightPw!2026')
        for _ in range(settings.AXES_FAILURE_LIMIT):
            self.client.post(
                '/auth/jwt/create/',
                {'username': 'brute@example.com', 'password': 'wrong'}, format='json',
            )
        # The correct password, now refused — which is what proves a lockout rather than
        # merely a rejected guess.
        response = self.client.post(
            '/auth/jwt/create/',
            {'username': 'brute@example.com', 'password': 'rightPw!2026'}, format='json',
        )
        self.assertNotEqual(response.status_code, 200)

    def test_a07_a_weak_password_is_refused_at_registration(self):
        response = APIClient().post(
            '/auth/users/',
            {
                'email': 'weak@example.com', 'password': '12345',
                'phone': '+961 70 000 000', 'business_name': 'Weak Co',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(User.objects.filter(username='weak@example.com').exists())

    # --- A08: Software & Data Integrity Failures --------------------------------------

    def test_a08_a_non_image_upload_is_rejected(self):
        product = Product.objects.create(
            name='Imaged', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=1, account=self.account,
        )
        payload = SimpleUploadedFile(
            'payload.jpg', b'<?php system($_GET["c"]); ?>', content_type='image/jpeg',
        )
        response = self.client.post(
            f'/inventory/products/{product.id}/images/', {'image': payload},
            format='multipart', HTTP_AUTHORIZATION=self.header,
        )
        # A declared content-type of image/jpeg is not believed: Pillow has to be able to
        # open it, which this is not.
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(product.images.count(), 0)

    def test_a08_an_svg_upload_is_rejected(self):
        # SVG is XML and can carry <script>. Served from the media origin it would be stored
        # XSS, so it must not be storable as an image in the first place.
        product = Product.objects.create(
            name='Svg', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=1, account=self.account,
        )
        payload = SimpleUploadedFile(
            'x.svg',
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            content_type='image/svg+xml',
        )
        response = self.client.post(
            f'/inventory/products/{product.id}/images/', {'image': payload},
            format='multipart', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)

    def test_a08_an_oversized_upload_is_rejected(self):
        product = Product.objects.create(
            name='Big', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=1, account=self.account,
        )
        payload = SimpleUploadedFile(
            'big.gif', _ONE_PIXEL_GIF + b'\x00' * (2000 * 1024), content_type='image/gif',
        )
        response = self.client.post(
            f'/inventory/products/{product.id}/images/', {'image': payload},
            format='multipart', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)

    def test_a08_an_uploaded_file_cannot_escape_its_account_directory(self):
        # upload_to interpolates the account id and the client-supplied filename. A traversal
        # sequence in the name must not walk out of the account's folder.
        product = Product.objects.create(
            name='Trav', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=1, account=self.account,
        )
        with tempfile.TemporaryDirectory() as media_root:
            with override_settings(MEDIA_ROOT=media_root):
                payload = SimpleUploadedFile(
                    '../../../../etc/evil.gif', _ONE_PIXEL_GIF, content_type='image/gif',
                )
                response = self.client.post(
                    f'/inventory/products/{product.id}/images/', {'image': payload},
                    format='multipart', HTTP_AUTHORIZATION=self.header,
                )
                self.assertEqual(response.status_code, 201, response.data)
                stored = product.images.get().image.name
                self.assertNotIn('..', stored)
                self.assertIn(f'inventory/images/{self.account.id}/', stored)

    # --- A09: Security Logging & Monitoring Failures ----------------------------------

    def test_a09_a_deletion_leaves_an_audit_record(self):
        supplier = Supplier.objects.create(name='Doomed', account=self.account)
        with self.assertLogs('ims.security', level='INFO') as captured:
            response = self.client.delete(
                f'/inventory/suppliers/{supplier.id}/', HTTP_AUTHORIZATION=self.header,
            )
        self.assertEqual(response.status_code, 204)
        line = '\n'.join(captured.output)
        self.assertIn('event=record_deleted', line)
        self.assertIn(f'user={self.user.pk}', line)
        self.assertIn(f'account={self.account.pk}', line)
        self.assertIn('model=Supplier', line)
        self.assertIn(f'pk={supplier.pk}', line)

    def test_a09_a_failed_delete_is_not_logged_as_a_deletion(self):
        # A PROTECT foreign key turns this into a 409. Logging before the delete would
        # record a deletion that never happened.
        Product.objects.create(
            name='Holds', description='', cost_price='1.00', default_sell_price='2.00',
            category=self.category, stock_quantity=1, account=self.account,
        )
        with self.assertLogs('ims.security', level='INFO') as captured:
            logging.getLogger('ims.security').info('event=probe')  # so assertLogs has output
            response = self.client.delete(
                f'/inventory/categories/{self.category.id}/',
                HTTP_AUTHORIZATION=self.header,
            )
        self.assertEqual(response.status_code, 409)
        self.assertNotIn('event=record_deleted', '\n'.join(captured.output))

    def test_a09_a_password_change_is_audited(self):
        _, code = verification_module.issue_code(
            self.user, purpose=verification_module.PASSWORD_RESET,
        )
        with self.assertLogs('ims.security', level='WARNING') as captured:
            self.client.post(
                '/accounts/password-reset/confirm/',
                {
                    'code': code, 'new_password': 'brandNewPw!2026',
                    'confirm_password': 'brandNewPw!2026',
                },
                format='json', HTTP_AUTHORIZATION=self.header,
            )
        self.assertIn('event=password_changed', '\n'.join(captured.output))

    def test_a09_the_audit_trail_never_carries_a_credential(self):
        from accounts.audit import log_auth_event

        with self.assertLogs('ims.security', level='WARNING') as captured:
            log_auth_event('password_changed', self.user, sessions_revoked=2)
        line = '\n'.join(captured.output)
        for forbidden in ('password=', 'token=', 'code=', 'secret'):
            self.assertNotIn(forbidden, line.lower())

    # --- A10: Server-Side Request Forgery ---------------------------------------------

    def test_a10_the_app_makes_no_outbound_http_request_from_user_input(self):
        # SSRF needs a fetcher. There is none: no requests/urllib/httpx call anywhere in the
        # application packages. Asserted so that adding one is a deliberate act reviewed
        # against this test, rather than a quiet import.
        import pathlib

        offenders = []
        for package in ('inventory', 'accounts', 'ims'):
            for path in pathlib.Path(settings.BASE_DIR / package).rglob('*.py'):
                if 'test' in path.name:
                    continue
                source = path.read_text()
                for needle in (
                    'import requests', 'urllib.request', 'urlopen', 'import httpx',
                    'http.client',
                ):
                    if needle in source:
                        offenders.append(f'{path.relative_to(settings.BASE_DIR)}: {needle}')
        self.assertEqual(
            offenders, [],
            'an outbound HTTP client appeared — review it for SSRF before allowing this',
        )

    def test_a10_an_image_url_cannot_be_set_through_the_api(self):
        # ExternalOrLocalImageField returns a stored absolute URL verbatim, which would be an
        # SSRF/redirect vector if a client could write one. It cannot: the API takes an
        # uploaded file, and the stored name is built by upload_to.
        product = Product.objects.create(
            name='UrlAttempt', description='', cost_price='1.00',
            default_sell_price='2.00', category=self.category, stock_quantity=1,
            account=self.account,
        )
        response = self.client.post(
            f'/inventory/products/{product.id}/images/',
            {'image': 'http://169.254.169.254/latest/meta-data/'},
            format='multipart', HTTP_AUTHORIZATION=self.header,
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(product.images.count(), 0)


class SPASecurityHeaderTests(TestCase):
    """The headers have to be on the HTML the browser actually loads, not just on the API."""

    def test_the_spa_index_carries_the_policy(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Content-Security-Policy', response)
        policy = response['Content-Security-Policy']
        # The fonts the built index.html references, or the app renders in a fallback face.
        self.assertIn('https://fonts.googleapis.com', policy)
        self.assertIn('https://fonts.gstatic.com', policy)
        self.assertIn("script-src 'self'", policy)

    def test_report_only_mode_swaps_the_header(self):
        # So a policy change can be watched on a live deployment before it starts blocking.
        with override_settings(CSP_REPORT_ONLY=True):
            from ims.security_headers import SecurityHeadersMiddleware

            middleware = SecurityHeadersMiddleware(lambda request: HttpResponse('ok'))
            response = middleware(self.client.get('/').wsgi_request)
            self.assertIn('Content-Security-Policy-Report-Only', response)
            self.assertNotIn('Content-Security-Policy', response)
