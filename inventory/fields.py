from django.db.models import ImageField
from django.db.models.fields.files import ImageFieldFile


class ExternalOrLocalImageFieldFile(ImageFieldFile):
    """
    FileSystemStorage.url() runs the stored name through filepath_to_uri(), which
    percent-encodes ':', '?', '&', '=' — turning an absolute URL like
    "https://placehold.co/400x400.webp?text=WM" into garbage
    ("/media/tenant1/https%3A/placehold.co/...%3Ftext%3DWM"). When the stored name is
    already an absolute http(s) URL (seed data referencing an external CDN image
    directly, rather than a locally-stored file), return it unchanged instead of
    routing it through the storage backend's URL construction.
    """

    @property
    def url(self):
        if self.name and self.name.startswith(('http://', 'https://')):
            return self.name
        return super().url


class ExternalOrLocalImageField(ImageField):
    attr_class = ExternalOrLocalImageFieldFile
