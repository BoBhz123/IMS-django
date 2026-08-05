from django.db import models
from django_tenants.models import TenantMixin, DomainMixin


class Tenant(TenantMixin):
    name = models.CharField(max_length=100)
    created_on = models.DateField(auto_now_add=True)

    # Auto-create the PostgreSQL schema (and run tenant migrations into it)
    # as soon as a Tenant row is saved.
    auto_create_schema = True

    def __str__(self):
        return self.name


class Domain(DomainMixin):
    pass
