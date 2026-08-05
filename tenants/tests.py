from django.contrib.auth.models import Permission, User
from django.db import connection
from django_tenants.test.cases import TenantTestCase
from django_tenants.test.client import TenantClient
from django_tenants.utils import tenant_context
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
