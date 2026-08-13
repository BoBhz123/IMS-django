"""
The lifetime of an unverified sign-up.

A registration is a *session*, not a row that lives forever: the account exists from the
moment the form is posted (there is nothing to attach a code or a payment to otherwise), but
it is inert — `pending_verification` is not in `Account.LIVE_STATUSES`, so every gated
endpoint already refuses it. This module decides when that session is over and destroys what
is left of it.

**Discarding is a hard delete, and that is the point.** There is a case-insensitive unique
index on `auth_user.email` (see accounts/migrations/0004), so leaving the row behind means
the address stays taken and "start over from scratch" fails with "an account with this email
already exists" — the one thing the user cannot fix themselves. A soft-deleted row would
need the sign-up path to learn how to reclaim it, which is a second place to get account
isolation wrong.

Deliberately free of DRF and HTTP, matching accounts/verification.py, so the guard around
the destructive part can be tested directly rather than through a view.
"""

import logging
from datetime import timedelta

from django.contrib.auth.models import User
from django.db import transaction
from django.utils import timezone

from .audit import log_auth_event
from .models import Account

logger = logging.getLogger(__name__)

# How long the whole unverified sign-up lives. Chosen to sit just above the code machinery
# rather than independently of it: verification.MAX_SENDS_PER_HOUR is 5 and CODE_TTL is 10
# minutes, so an hour is long enough for a user to spend every resend they are entitled to
# before the session closes. Shortening this below an hour strands people who still have
# codes coming.
REGISTRATION_SESSION_TTL = timedelta(minutes=60)


class NotDiscardable(Exception):
    """
    Raised when asked to discard something that is not a pending registration.

    Loud rather than a quiet no-op, matching `start_trial`'s TrialAlreadyUsed: a caller that
    believes it deleted an account and did not is worse than a failure, and this is the guard
    standing between a support ticket and a paying customer's data.
    """


def registration_deadline(now=None):
    return (now or timezone.now()) + REGISTRATION_SESSION_TTL


def is_pending_registration(account):
    return account is not None and account.is_pending_registration


def is_expired(account, now=None):
    """
    Whether this registration's session is over.

    False for anything that is not a pending registration — so a verified account, a paying
    one, or an account an admin has reset to pending_verification all answer False and are
    never candidates for deletion.
    """
    if not is_pending_registration(account):
        return False
    return account.registration_expires_at <= (now or timezone.now())


@transaction.atomic
def discard(account, *, reason):
    """
    Destroy an unverified registration: its users, their memberships, and the account row.

    The only supported way to delete an account outside the admin. Raises NotDiscardable for
    anything that has ever been verified, so this cannot be turned into a delete-my-customer
    endpoint by a caller that stops checking first.

    Returns the number of users deleted.
    """
    if not is_pending_registration(account):
        raise NotDiscardable(
            f'Account {getattr(account, "pk", None)} is not a pending registration.'
        )
    # Belt and braces over the status check. None of these can be set on a row that has
    # never been verified, so tripping one means an assumption above is wrong and the safe
    # answer is to delete nothing.
    if account.has_used_trial or account.expires_at or account.paddle_customer_id:
        raise NotDiscardable(
            f'Account {account.pk} carries billing history and will not be discarded.'
        )

    # Captured before the delete: Django's collector nulls `instance.pk` on the way out, and
    # the audit line has to name what was destroyed.
    account_pk = account.pk
    user_pks = list(account.memberships.values_list('user_id', flat=True))

    # Users first, then the account. Deleting a User cascades its Membership but nothing
    # points at Account from the user side, so the account row would be orphaned otherwise.
    # EmailVerification and simplejwt's OutstandingToken both cascade off the user, which is
    # what makes the outstanding code and the issued JWT dead rather than merely unused.
    deleted_users = User.objects.filter(pk__in=user_pks).delete()[0] if user_pks else 0
    account.delete()

    # Actor is None because the only caller is the account destroying itself, and its user
    # row no longer exists to be named. The deleted pks are the field worth having.
    log_auth_event(
        'registration_discarded',
        None,
        account=account_pk,
        users=','.join(str(pk) for pk in user_pks) or '-',
        reason=reason,
    )
    return deleted_users


def discard_if_expired(account, now=None):
    """
    Close out a registration whose session has elapsed. Returns True if anything was deleted.

    This is the enforcement path, called from the endpoints an unverified user can still
    reach. There is no scheduled job in this project — the management command is housekeeping
    for rows nobody comes back to, exactly as the trial sweep is — so expiry has to be acted
    on at the moment somebody asks.
    """
    if not is_expired(account, now=now):
        return False
    discard(account, reason='session_expired')
    return True


def expired_registrations(now=None):
    """The queryset the purge command walks. Same predicate as `is_expired`, in SQL."""
    return Account.objects.filter(
        subscription_status=Account.PENDING_VERIFICATION,
        registration_expires_at__isnull=False,
        registration_expires_at__lte=now or timezone.now(),
    )
