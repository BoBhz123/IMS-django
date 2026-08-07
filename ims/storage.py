from storages.backends.s3 import S3Storage


class MediaS3Storage(S3Storage):
    """
    Media storage for S3-API-compatible object storage (AWS S3, or Cloudflare R2 via
    AWS_S3_ENDPOINT_URL).

    Per-tenant prefixing is gone with django-tenants. Uploads are namespaced per account by
    the model's own upload_to callable (see inventory.models.product_image_path) rather than
    by the storage backend, so the account is visible in the stored file name instead of
    being applied invisibly at write time.
    """
