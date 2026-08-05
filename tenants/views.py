from django.db import connection
from django_tenants.utils import get_public_schema_name
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Domain, Tenant
from .serializers import TenantOnboardingSerializer


class TenantOnboardingView(APIView):
    """
    Platform-level operation: provisions a new tenant (Postgres schema + tenant-app
    migrations, via Tenant.auto_create_schema) and its primary Domain row.

    Deliberately does NOT touch DNS or Heroku's custom-domain configuration — there is no
    wildcard DNS/Heroku domain set up for this app (each of client.myimsapp.com and
    testlab.myimsapp.com was registered individually, by hand). A tenant created here will
    NOT be reachable at its subdomain until that's set up separately; the response says so
    explicitly rather than implying the tenant is immediately live.
    """

    permission_classes = [IsAdminUser]

    def post(self, request):
        # django_tenants itself refuses Tenant.save() for a new row unless the CURRENT
        # connection is already on the public schema (see TenantMixin.save()) — this check
        # exists anyway to fail with a clear 403 instead of a raised exception surfacing as
        # a generic 500, and to keep this a platform-level operation, not something callable
        # from within an existing tenant's own domain.
        if connection.schema_name != get_public_schema_name():
            return Response(
                {'detail': 'Tenant onboarding is only available from the public schema.'},
                status=403,
            )

        serializer = TenantOnboardingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        schema_name = serializer.validated_data['schema_name']
        domain_name = serializer.validated_data['domain']
        name = serializer.validated_data['name']

        tenant = Tenant.objects.create(schema_name=schema_name, name=name)
        try:
            domain = Domain.objects.create(domain=domain_name, tenant=tenant, is_primary=True)
        except Exception:
            # Schema + migrations already ran (auto_create_schema=True, in Tenant.save()) —
            # don't leave an orphaned, domain-less tenant behind if the Domain row fails.
            tenant.delete(force_drop=True)
            raise

        return Response(
            {
                'schema_name': tenant.schema_name,
                'name': tenant.name,
                'domain': domain.domain,
                'reachable': False,
                'note': (
                    'Tenant and domain record created. This domain is NOT yet reachable — '
                    'it requires a matching DNS record and Heroku custom domain '
                    '(no wildcard is configured; see client.myimsapp.com/testlab.myimsapp.com '
                    'for the manual steps each existing domain needed).'
                ),
            },
            status=201,
        )
