from django.contrib import admin
from django.urls import path, include, re_path
from django.conf import settings
from django.conf.urls.static import static
from rest_framework_simplejwt.views import TokenBlacklistView

from .views import spa_index

urlpatterns = [
    path('admin/', admin.site.urls),
    path('inventory/', include('inventory.urls')),

    # Djoser Authentication Endpoints
    path('auth/', include('djoser.urls')),
    path('auth/', include('djoser.urls.jwt')),
    path('auth/jwt/blacklist/', TokenBlacklistView.as_view(), name='jwt-blacklist'),
    path('__debug__/', include('debug_toolbar.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Serves the built React app for '/' and any other path not matched above (client-side
# routes like /products — a hard refresh there should still load the SPA, not 404).
# Must stay last: everything above (admin/, inventory/, auth/, __debug__/, media/) needs
# to keep taking priority over this catch-all.
urlpatterns += [
    re_path(r'^.*$', spa_index, name='spa-index'),
]