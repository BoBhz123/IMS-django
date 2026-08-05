from django.contrib.auth.models import Permission, User
from django.test import TestCase
from django_tenants.test.cases import TenantTestCase
from django_tenants.test.client import TenantClient
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import Category, Product, ProductImage


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
