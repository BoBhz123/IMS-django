from rest_framework.throttling import ScopedRateThrottle


class VerifyEmailThrottle(ScopedRateThrottle):
    """
    Belt and braces over the per-code attempt cap in accounts.verification. The cap kills a
    single code after 5 guesses; this stops someone cycling resend-then-guess-five-times
    indefinitely. django-axes guards login only and never sees these endpoints.

    The rate must stay comfortably above MAX_ATTEMPTS, or a legitimately locked-out user gets
    a 429 where they should get the "request a new code" message.
    """

    scope = 'verify_email'


class ResendCodeThrottle(ScopedRateThrottle):
    scope = 'resend_code'
