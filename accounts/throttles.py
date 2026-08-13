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


class AbandonRegistrationThrottle(ScopedRateThrottle):
    """
    Keyed on the client address, deliberately — not on the user.

    Discarding a registration frees the email address, so sign-up → code → abandon → sign-up
    is a loop that can mail the *same* victim address repeatedly. The per-user caps in
    accounts.verification cannot see it, because every pass through the loop creates a brand
    new user row and therefore a brand new budget. The address is the only identifier that
    survives the loop, so it is the one this counts.

    The rate only has to accommodate a human fixing a typo, which is once or twice.
    """

    scope = 'abandon_registration'

    def get_cache_key(self, request, view):
        return self.cache_format % {
            'scope': self.scope,
            'ident': self.get_ident(request),
        }


class RedeemKeyThrottle(ScopedRateThrottle):
    """
    The key space is about 10^17, so this is not the primary defence — it exists so a
    compromised login cannot be used to grind the endpoint, and so a key that leaks cannot
    be sprayed at every account at speed.
    """

    scope = 'redeem_key'
