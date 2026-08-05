from django.db import connection
from storages.backends.s3 import S3Storage


class TenantS3Storage(S3Storage):
    """
    Namespaces every object under <tenant_schema_name>/... within the bucket, mirroring
    django_tenants.files.storage.TenantFileSystemStorage's per-tenant isolation, but for
    S3-API-compatible object storage (AWS S3, or Cloudflare R2 via AWS_S3_ENDPOINT_URL).

    `location` is a property (not a value set once at init) so it's re-evaluated on every
    access against whichever tenant is active on the connection at that moment — the same
    dynamic-per-request mechanism TenantFileSystemStorage uses.
    """

    @property
    def location(self):
        return connection.schema_name
