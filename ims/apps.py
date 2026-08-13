"""
App configs owned by the project itself.

Only one so far: swapping the default admin site for the superuser-only one. Done through
`AdminConfig.default_site` rather than by instantiating a site and re-registering everything
against it, because that is the hook Django reads *before* `autodiscover()` runs — so every
existing `admin.site.register(...)` in accounts/ and inventory/ lands on the restricted site
with no edits, and a new one cannot forget to.
"""

from django.contrib.admin.apps import AdminConfig


class IMSAdminConfig(AdminConfig):
    default_site = 'ims.admin_site.SuperuserOnlyAdminSite'
