from django.db import migrations


def create_public_tenant(apps, schema_editor):
    Tenant = apps.get_model('tenants', 'Tenant')
    Domain = apps.get_model('tenants', 'Domain')

    tenant, _ = Tenant.objects.get_or_create(schema_name='public', defaults={'name': 'Public'})
    for domain in ('localhost', 'testserver'):
        Domain.objects.get_or_create(domain=domain, defaults={'tenant': tenant, 'is_primary': domain == 'localhost'})


def remove_public_tenant(apps, schema_editor):
    Tenant = apps.get_model('tenants', 'Tenant')
    Tenant.objects.filter(schema_name='public').delete()


class Migration(migrations.Migration):

    dependencies = [
        ('tenants', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(create_public_tenant, remove_public_tenant),
    ]
