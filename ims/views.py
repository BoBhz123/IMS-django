from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, HttpResponseNotFound

_INDEX_HTML_PATH = Path(settings.BASE_DIR) / 'frontend' / 'dist' / 'index.html'


def spa_index(request):
    """
    Serves the built React app's index.html for '/' and any client-side route (so a
    hard refresh on e.g. /products doesn't 404 — the SPA's own router takes over once
    index.html's JS loads). The built JS/CSS assets themselves are served separately by
    WhiteNoise via WHITENOISE_ROOT, at the root-relative paths Vite already emits them at.
    """
    if not _INDEX_HTML_PATH.exists():
        return HttpResponseNotFound(
            "Frontend build not found — run `npm run build` in frontend/."
        )
    return HttpResponse(_INDEX_HTML_PATH.read_bytes(), content_type='text/html')
