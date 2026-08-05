import re

from django.conf import settings
from django_tenants.utils import get_public_schema_name
from rest_framework import serializers

from .models import Domain, Tenant

# django_tenants' own schema_name validator (PGSQL_VALID_SCHEMA_NAME = r'^(?!pg_).{1,63}$')
# only blocks a "pg_" prefix — '.' matches almost any character, including '"', ';', spaces.
# The name is interpolated directly into `CREATE SCHEMA "%s"` via string formatting (Postgres
# DDL can't parameterize identifiers), so a stray '"' could break out of the quoted identifier.
# This is the real validation an untrusted, internet-facing field needs: a conservative
# allowlist, not django-tenants' permissive default.
_SCHEMA_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{2,62}$')

_RESERVED_SCHEMA_NAMES = {'public', 'information_schema', 'pg_catalog', 'pg_toast'}


class TenantOnboardingSerializer(serializers.Serializer):
    schema_name = serializers.CharField()
    name = serializers.CharField(required=False, allow_blank=True)

    def validate_schema_name(self, value):
        value = value.strip().lower()
        if not _SCHEMA_NAME_RE.match(value):
            raise serializers.ValidationError(
                'Must be lowercase letters, digits, and underscores only, starting with a '
                'letter, 3-63 characters.'
            )
        if value in _RESERVED_SCHEMA_NAMES or value == get_public_schema_name():
            raise serializers.ValidationError('This name is reserved.')
        if Tenant.objects.filter(schema_name=value).exists():
            raise serializers.ValidationError('A tenant with this schema name already exists.')
        return value

    def validate(self, attrs):
        schema_name = attrs['schema_name']
        domain = f'{schema_name}.{settings.TENANT_BASE_DOMAIN}'
        if Domain.objects.filter(domain=domain).exists():
            raise serializers.ValidationError({'schema_name': 'That domain is already taken.'})
        attrs['domain'] = domain
        attrs.setdefault('name', schema_name.capitalize())
        if not attrs['name']:
            attrs['name'] = schema_name.capitalize()
        return attrs
