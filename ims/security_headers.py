"""
Content-Security-Policy and Referrer-Policy.

Hand-rolled rather than `django-csp`, deliberately: adding a dependency means
`pipenv install`, which relocks, and this repo has already had a lockfile relock silently
bump Django and DRF (see the Working Log). The policy below is ~40 lines and needs no
release cadence of its own.

**Why CSP is worth more here than in a typical Django app.** The SPA stores its JWTs in
`localStorage`, so any successful XSS is a full account takeover — the token can simply be
read and exfiltrated. `HttpOnly` cookies would be the structural fix and are a much larger
change (CSRF handling, the axios interceptor, the token store). CSP is the control that
reduces the blast radius in the meantime, and it is honest to record it as mitigation rather
than as a solution.
"""

from urllib.parse import urlparse

from django.conf import settings


def _sentry_ingest_origin():
    """
    The origin the browser SDK POSTs events to, derived from the DSN.

    A DSN looks like https://<key>@o123.ingest.sentry.io/456 — the origin is what
    `connect-src` has to allow. Returns None when Sentry is not configured, so the policy
    stays as tight as the deployment allows.
    """
    dsn = getattr(settings, 'SENTRY_DSN', None)
    if not dsn:
        return None
    parsed = urlparse(dsn)
    return f'{parsed.scheme}://{parsed.hostname}' if parsed.hostname else None


def build_csp():
    """The policy as an ordered list of directives, so the tests can read it back."""
    # Google Fonts, referenced from frontend/index.html: the stylesheet comes from
    # fonts.googleapis.com and the font files from fonts.gstatic.com. Both are needed or the
    # app renders in a fallback face.
    style_src = ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com']
    font_src = ["'self'", 'https://fonts.gstatic.com', 'data:']

    # 'unsafe-inline' in style-src is not laziness and not removable today: framer-motion
    # animates by writing inline styles on every frame, and Tailwind's runtime theme toggle
    # sets CSS custom properties inline. Nonces cannot cover style attributes, only <style>
    # elements, so this needs the animation library to change before it can tighten.

    connect_src = ["'self'"]
    sentry_origin = _sentry_ingest_origin()
    if sentry_origin:
        connect_src.append(sentry_origin)
    # The browser SDK is configured separately (VITE_SENTRY_DSN), so its ingest host can
    # differ from the Django DSN above. This is the knob for that, and for any other origin
    # the SPA legitimately calls.
    connect_src.extend(getattr(settings, 'CSP_EXTRA_CONNECT_SRC', []))

    # Product images: local media in dev, the R2 custom domain in production, and data: for
    # the inline placeholders. https: stays out — an explicit host list is the point.
    img_src = ["'self'", 'data:', 'blob:']
    custom_domain = getattr(settings, 'AWS_S3_CUSTOM_DOMAIN', None)
    if custom_domain:
        img_src.append(f'https://{custom_domain}')
    img_src.extend(getattr(settings, 'CSP_EXTRA_IMG_SRC', []))

    return [
        "default-src 'self'",
        # No inline or eval'd script. The Vite build emits a single external module, so this
        # needs no nonce — and if a future build inlines something, this breaks loudly in
        # development rather than silently weakening in production.
        "script-src 'self'",
        f"style-src {' '.join(style_src)}",
        f"font-src {' '.join(font_src)}",
        f"img-src {' '.join(img_src)}",
        f"connect-src {' '.join(connect_src)}",
        # The barcode scanner reads the camera through getUserMedia, which CSP does not
        # govern, but it does create object URLs for the video stream — covered by blob: in
        # img-src and media-src.
        "media-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        # Duplicates X_FRAME_OPTIONS = 'DENY' on purpose: frame-ancestors is the modern
        # directive and the one newer browsers honour, while X-Frame-Options covers the rest.
        "frame-ancestors 'none'",
    ]


class SecurityHeadersMiddleware:
    """
    Adds CSP and Referrer-Policy. Django's SecurityMiddleware covers HSTS, nosniff,
    X-Frame-Options and the SSL redirect, but has no CSP setting at all.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.policy = '; '.join(build_csp())

    def __call__(self, request):
        response = self.get_response(request)

        # Report-only when CSP_REPORT_ONLY is set, so a policy change can be rolled out and
        # watched before it starts blocking anything on a live deployment.
        header = (
            'Content-Security-Policy-Report-Only'
            if getattr(settings, 'CSP_REPORT_ONLY', False)
            else 'Content-Security-Policy'
        )
        response.setdefault(header, self.policy)

        # strict-origin-when-cross-origin: full URL on same-origin, bare origin on
        # cross-origin HTTPS, nothing when downgrading to HTTP. Without it, product and
        # order ids in the path leak to any third party the browser is sent to.
        response.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')

        return response
