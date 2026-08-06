import re

from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.views.static import serve as serve_static
from rest_framework_simplejwt.views import TokenBlacklistView

from .views import spa_index

urlpatterns = [
    path('admin/', admin.site.urls),
    path('inventory/', include('inventory.urls')),
    path('tenants/', include('tenants.urls')),

    # Djoser Authentication Endpoints
    path('auth/', include('djoser.urls')),
    path('auth/', include('djoser.urls.jwt')),
    path('auth/jwt/blacklist/', TokenBlacklistView.as_view(), name='jwt-blacklist'),
]

# Matches the DEBUG gate on debug_toolbar in settings.py (INSTALLED_APPS + MIDDLEWARE) —
# the app isn't loaded in production, so its URLs must not be routed there either.
if settings.DEBUG:
    urlpatterns += [path('__debug__/', include('debug_toolbar.urls'))]

# Deliberately built by hand instead of django.conf.urls.static.static() — that helper has
# its own hardcoded `if not settings.DEBUG: return []` internally, so it silently produces
# ZERO urlpatterns once DEBUG=False, no matter how it's called. That's what actually caused
# broken product-image thumbnails in production: every /media/... request fell through
# (unmatched) to the SPA catch-all below, returning the HTML app shell — 200 text/html where
# an image/png was expected — which the browser correctly refuses to render as an image.
# django.views.static.serve itself has no such guard, so calling it directly here serves
# unconditionally, regardless of DEBUG. This app has no other route for locally-stored media
# (no nginx/whitenoise-for-media, and S3/R2 isn't provisioned yet) — still not a
# production-grade solution on its own (Heroku's ephemeral filesystem means locally-stored
# uploads don't survive a dyno restart/deploy) — see ims/storage.py's TenantS3Storage, which
# activates automatically once AWS_STORAGE_BUCKET_NAME is set.
urlpatterns += [
    re_path(
        r'^%s(?P<path>.*)$' % re.escape(settings.MEDIA_URL.lstrip('/')),
        serve_static,
        kwargs={'document_root': settings.MEDIA_ROOT},
    ),
]

# Serves the built React app for '/' and any other path not matched above (client-side
# routes like /products — a hard refresh there should still load the SPA, not 404).
# Must stay last: everything above (admin/, inventory/, auth/, __debug__/, media/) needs
# to keep taking priority over this catch-all.
urlpatterns += [
    re_path(r'^.*$', spa_index, name='spa-index'),
]