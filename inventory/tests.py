from django.contrib.auth.models import Permission, User
from django.test import TestCase
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

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
