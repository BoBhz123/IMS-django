"""
What a brute-force lockout looks like to the caller.

django-axes rejects inside `AxesStandaloneBackend`, which sits first in
AUTHENTICATION_BACKENDS — ahead of the credential check, ahead of `is_active`, ahead of
anything the Django admin can toggle. That ordering is correct and deliberate: a lockout that
could be lifted by guessing the right password is not a lockout.

What was wrong is that it said nothing. With no AXES_LOCKOUT_CALLABLE configured, axes
returned a bare 401 — byte-identical to a wrong password — so a locked-out user was told to
check credentials that were already correct, and an admin flipping `is_active` to fix it saw
no effect and no explanation. The lockout behaviour is unchanged here; only its visibility.
"""

from axes.backends import AxesStandaloneBackend
from axes.exceptions import AxesBackendPermissionDenied
from axes.helpers import get_cool_off
from django.http import JsonResponse

# 429, not 403 or 401. The client is being rate-limited, not denied for who it is, and the
# distinction is what lets the SPA say "wait" instead of "wrong password".
LOCKED_STATUS = 429

# Machine-readable, because the browser must branch on this rather than on the prose — the
# wording is free to change and translations would break a string match. Mirrors the
# `subscription_expired` code the billing 403 already uses.
LOCKED_CODE = 'account_locked'


def cool_off_seconds():
    """
    AXES_COOLOFF_TIME as whole seconds, or None when lockouts never expire.

    Read through axes' own helper rather than off the setting: the setting accepts an int of
    hours, a timedelta, or a callable, and only the helper knows how to normalise all three.
    """
    cool_off = get_cool_off()
    return int(cool_off.total_seconds()) if cool_off is not None else None


class VisibleLockoutBackend(AxesStandaloneBackend):
    """
    AxesStandaloneBackend, but the lockout actually reaches the caller.

    The stock backend only sets `request.axes_locked_out` when
    AXES_RESET_COOL_OFF_ON_FAILURE_DURING_LOCKOUT is False — and it defaults to True. That
    flag is the *only* thing AxesMiddleware looks at, so on a default install a lockout
    raises, is caught by django.contrib.auth.authenticate, and quietly becomes "no backend
    authenticated you": a plain 401, identical to a wrong password. That is the bug.

    Setting the flag here rather than flipping the setting keeps the security behaviour
    exactly as it was. With the setting left True, every attempt made *during* a lockout
    restarts the cooloff, so someone hammering the endpoint never waits it out — worth
    keeping. The setting is about how long the lockout lasts; this is about whether anyone
    is told it happened. They are not the same question, and the stock backend conflates them.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        try:
            return super().authenticate(request, username, password, **kwargs)
        except AxesBackendPermissionDenied:
            if request is not None:
                # On the *underlying* HttpRequest, not the one handed to us. simplejwt calls
                # django.contrib.auth.authenticate() with DRF's Request wrapper, and
                # AxesMiddleware reads the attribute off the Django HttpRequest it created —
                # so a flag set on the wrapper is written to an object the middleware never
                # looks at, and the lockout stays invisible. Verified by instrumentation:
                # the flag was present on the wrapper and absent on the underlying request
                # while the response stayed 401.
                #
                # Both are set: the wrapper for anything reading the request it was given,
                # the underlying one because that is what actually renders the response.
                request.axes_locked_out = True
                underlying = getattr(request, '_request', None)
                if underlying is not None:
                    underlying.axes_locked_out = True
            raise


def lockout_response(request, original_response=None, credentials=None):
    """
    The response axes returns for a locked-out attempt. Wired via AXES_LOCKOUT_CALLABLE.

    Takes axes' full three-argument signature deliberately. `get_lockout_response` calls a
    two-argument callable only as a *TypeError fallback*, which means any TypeError raised
    inside this function would be swallowed and the whole thing retried with a different
    signature — turning a real bug into a confusing second failure.

    Deliberately says nothing about whether the account exists or whether the password was
    right. A lockout is triggered by the username *as submitted*, so a response that
    distinguished "locked out" from "no such user" would turn the lockout into a user
    enumeration oracle — worse than the silence it replaces.
    """
    seconds = cool_off_seconds()
    minutes = round(seconds / 60) if seconds else None

    if minutes is None:
        wait = 'Contact support to unlock it.'
    elif minutes >= 60:
        hours = round(minutes / 60)
        wait = f"Try again in about {hours} hour{'s' if hours != 1 else ''}."
    else:
        wait = f'Try again in about {minutes} minute{"s" if minutes != 1 else ""}.'

    response = JsonResponse(
        {
            'detail': f'Too many failed sign-in attempts. {wait}',
            'code': LOCKED_CODE,
            'cooloff_seconds': seconds,
        },
        status=LOCKED_STATUS,
    )
    if seconds:
        # The correct HTTP semantic for "come back later", and it saves the client guessing
        # the cooloff. Integer seconds is the form every client understands.
        response['Retry-After'] = str(seconds)
    return response
