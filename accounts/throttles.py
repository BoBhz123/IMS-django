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


class PasswordResetRequestThrottle(ScopedRateThrottle):
    """
    Separate scope from resend_code, matching the separate purpose on the code itself. A
    shared scope would let signup resends eat the budget for securing a compromised account.
    """

    scope = 'password_reset_request'


class PasswordResetVerifyThrottle(ScopedRateThrottle):
    """
    Covers both the check and the confirm endpoint, which is the point: they take the same
    credential, so throttling only one leaves the other as the way to grind it.
    """

    scope = 'password_reset_verify'


class RedeemKeyThrottle(ScopedRateThrottle):
    """
    The key space is about 10^17, so this is not the primary defence — it exists so a
    compromised login cannot be used to grind the endpoint, and so a key that leaks cannot
    be sprayed at every account at speed.
    """

    scope = 'redeem_key'
