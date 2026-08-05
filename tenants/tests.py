from django.contrib.auth.models import Permission, User
from django.db import connection
from django.test import TestCase
from django_tenants.test.cases import TenantTestCase
from django_tenants.test.client import TenantClient
from django_tenants.utils import tenant_context
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import Category, Product
from tenants.models import Domain, Tenant


class TenantIsolationTests(TenantTestCase):
    """
    Verifies that django-tenants' PostgreSQL schema isolation actually isolates
    `inventory` data (a TENANT_APPS model) between two tenants, at both the ORM
    level and the HTTP/API level.
    """

    @classmethod
    def setUpClass(cls):
        cls.sync_shared()

        cls.tenant1 = Tenant(schema_name='isolationtest1')
        cls.tenant1.save(verbosity=0)
        cls.domain1 = Domain.objects.create(
            tenant=cls.tenant1, domain='isolationtest1.test.com', is_primary=True
        )

        cls.tenant2 = Tenant(schema_name='isolationtest2')
        cls.tenant2.save(verbosity=0)
        cls.domain2 = Domain.objects.create(
            tenant=cls.tenant2, domain='isolationtest2.test.com', is_primary=True
        )

        connection.set_schema_to_public()

        # `auth.User` lives in a SHARED_APPS table (public schema) — one user, usable
        # against either tenant's domain, since auth is shared while inventory isn't.
        cls.user = User.objects.create_user(username='tenant-tester', password='pw12345!')
        cls.user.user_permissions.add(Permission.objects.get(codename='view_product'))
        cls.auth_header = f'JWT {RefreshToken.for_user(cls.user).access_token}'

    @classmethod
    def tearDownClass(cls):
        connection.set_schema_to_public()
        cls.user.delete()
        cls.domain1.delete()
        cls.tenant1.delete(force_drop=True)
        cls.domain2.delete()
        cls.tenant2.delete(force_drop=True)
        connection.set_schema_to_public()

    def tearDown(self):
        # Each test creates its own Products — wipe them so tests don't leak state
        # into each other (these tenant schemas persist for the whole test class).
        for tenant in (self.tenant1, self.tenant2):
            with tenant_context(tenant):
                Product.objects.all().delete()
                Category.objects.all().delete()

    def _create_product(self, tenant, name):
        with tenant_context(tenant):
            category = Category.objects.create(name=f'{name} category')
            return Product.objects.create(
                name=name,
                description='',
                cost_price='1.00',
                default_sell_price='2.00',
                category=category,
            )

    def test_database_isolation_between_schemas(self):
        self._create_product(self.tenant1, 'Tenant1 Widget')

        with tenant_context(self.tenant1):
            self.assertEqual(Product.objects.count(), 1)

        with tenant_context(self.tenant2):
            self.assertEqual(Product.objects.count(), 0)

    def test_http_search_isolation_between_tenants(self):
        self._create_product(self.tenant1, 'Tenant1 Only Widget')
        self._create_product(self.tenant2, 'Tenant2 Only Widget')

        client1 = TenantClient(self.tenant1)
        client2 = TenantClient(self.tenant2)

        response1 = client1.get('/inventory/products/', HTTP_AUTHORIZATION=self.auth_header)
        response2 = client2.get('/inventory/products/', HTTP_AUTHORIZATION=self.auth_header)

        self.assertEqual(response1.status_code, 200)
        self.assertEqual(response2.status_code, 200)

        names1 = [p['name'] for p in response1.json()['results']]
        names2 = [p['name'] for p in response2.json()['results']]

        self.assertEqual(names1, ['Tenant1 Only Widget'])
        self.assertEqual(names2, ['Tenant2 Only Widget'])

    def test_cross_tenant_id_access_returns_404(self):
        product = self._create_product(self.tenant1, 'Tenant1 Secret Widget')

        client2 = TenantClient(self.tenant2)
        response = client2.get(
            f'/inventory/products/{product.pk}/', HTTP_AUTHORIZATION=self.auth_header
        )

        self.assertEqual(response.status_code, 404)

    def test_same_client_sees_only_its_own_tenant_across_requests(self):
        self._create_product(self.tenant1, 'Tenant1 Widget A')
        self._create_product(self.tenant1, 'Tenant1 Widget B')

        client1 = TenantClient(self.tenant1)
        response = client1.get('/inventory/products/', HTTP_AUTHORIZATION=self.auth_header)

        self.assertEqual(response.status_code, 200)
        names = {p['name'] for p in response.json()['results']}
        self.assertEqual(names, {'Tenant1 Widget A', 'Tenant1 Widget B'})


class TenantOnboardingTests(TestCase):
    """
    Covers tenants/views.py::TenantOnboardingView. Runs as a plain TestCase (not
    TenantTestCase) since everything it exercises — Tenant, Domain, auth.User — lives in
    the shared/public schema; standard TestCase transaction rollback also cleanly undoes
    the real CREATE SCHEMA DDL a successful onboarding call triggers (Postgres DDL is
    transactional).
    """

    def setUp(self):
        self.admin = User.objects.create_user(
            username='onboard-admin', password='pw12345!', is_staff=True, is_superuser=True
        )
        self.admin_auth = f'JWT {RefreshToken.for_user(self.admin).access_token}'

        self.nonadmin = User.objects.create_user(username='onboard-nonadmin', password='pw12345!')
        self.nonadmin_auth = f'JWT {RefreshToken.for_user(self.nonadmin).access_token}'

        self.client = APIClient()

    def test_admin_can_onboard_a_new_tenant(self):
        response = self.client.post(
            '/tenants/onboard/',
            {'schema_name': 'acme_co'},
            HTTP_AUTHORIZATION=self.admin_auth,
        )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body['schema_name'], 'acme_co')
        self.assertEqual(body['domain'], 'acme_co.myimsapp.com')
        self.assertFalse(body['reachable'])

        tenant = Tenant.objects.get(schema_name='acme_co')
        domain = Domain.objects.get(tenant=tenant)
        self.assertEqual(domain.domain, 'acme_co.myimsapp.com')
        self.assertTrue(domain.is_primary)

    def test_rejects_unauthenticated_request(self):
        response = self.client.post('/tenants/onboard/', {'schema_name': 'no_auth'})
        self.assertEqual(response.status_code, 401)
        self.assertFalse(Tenant.objects.filter(schema_name='no_auth').exists())

    def test_rejects_non_admin_user(self):
        response = self.client.post(
            '/tenants/onboard/',
            {'schema_name': 'blocked_co'},
            HTTP_AUTHORIZATION=self.nonadmin_auth,
        )
        self.assertEqual(response.status_code, 403)
        self.assertFalse(Tenant.objects.filter(schema_name='blocked_co').exists())

    def test_rejects_when_not_on_public_schema(self):
        # TenantMainMiddleware resolves the schema fresh from each request's Host header —
        # setting connection.schema_name manually beforehand doesn't survive the middleware
        # re-resolving it, so this needs a real Domain + matching Host header, same as
        # TenantIsolationTests' use of TenantClient elsewhere in this file.
        other = Tenant(schema_name='some_other_tenant')
        other.save(verbosity=0)
        Domain.objects.create(
            tenant=other, domain='some-other-tenant.test.com', is_primary=True
        )
        try:
            response = self.client.post(
                '/tenants/onboard/',
                {'schema_name': 'should_be_blocked'},
                HTTP_AUTHORIZATION=self.admin_auth,
                HTTP_HOST='some-other-tenant.test.com',
            )
        finally:
            connection.set_schema_to_public()
            other.delete(force_drop=True)

        self.assertEqual(response.status_code, 403)
        self.assertFalse(Tenant.objects.filter(schema_name='should_be_blocked').exists())

    def test_rejects_injection_attempt_in_schema_name(self):
        response = self.client.post(
            '/tenants/onboard/',
            {'schema_name': 'foo"; DROP SCHEMA public CASCADE; --'},
            HTTP_AUTHORIZATION=self.admin_auth,
        )
        self.assertEqual(response.status_code, 400)

    def test_rejects_uppercase_and_special_characters(self):
        response = self.client.post(
            '/tenants/onboard/',
            {'schema_name': 'Acme-Co!'},
            HTTP_AUTHORIZATION=self.admin_auth,
        )
        self.assertEqual(response.status_code, 400)

    def test_rejects_reserved_schema_name(self):
        response = self.client.post(
            '/tenants/onboard/',
            {'schema_name': 'public'},
            HTTP_AUTHORIZATION=self.admin_auth,
        )
        self.assertEqual(response.status_code, 400)

    def test_rejects_duplicate_schema_name(self):
        existing = Tenant(schema_name='dupe_co')
        existing.save(verbosity=0)
        try:
            response = self.client.post(
                '/tenants/onboard/',
                {'schema_name': 'dupe_co'},
                HTTP_AUTHORIZATION=self.admin_auth,
            )
        finally:
            existing.delete(force_drop=True)

        self.assertEqual(response.status_code, 400)

    def test_rejects_domain_collision_even_with_different_schema_name(self):
        other = Tenant(schema_name='other_owner')
        other.save(verbosity=0)
        Domain.objects.create(domain='taken_co.myimsapp.com', tenant=other, is_primary=True)
        try:
            response = self.client.post(
                '/tenants/onboard/',
                {'schema_name': 'taken_co'},
                HTTP_AUTHORIZATION=self.admin_auth,
            )
        finally:
            other.delete(force_drop=True)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(Tenant.objects.filter(schema_name='taken_co').exists())
