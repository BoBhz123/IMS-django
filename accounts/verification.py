"""
Issuing and checking email verification codes.

Deliberately free of DRF and HTTP so the security rules can be tested directly, and so the
views that use it stay thin enough to read in one screen.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from .models import EmailVerification

CODE_LENGTH = 6
CODE_TTL = timedelta(minutes=10)
MAX_ATTEMPTS = 5
RESEND_COOLDOWN = timedelta(seconds=60)
MAX_SENDS_PER_HOUR = 5

OK = 'ok'
INVALID = 'invalid'
EXPIRED = 'expired'
LOCKED = 'locked'
NO_CODE = 'no_code'


class ResendThrottled(Exception):
    def __init__(self, retry_after):
        self.retry_after = retry_after
        super().__init__(f'Try again in {retry_after} seconds.')


def generate_code():
    # secrets, not random: random is a Mersenne Twister, and its state is recoverable from
    # enough observed output — an attacker who collects codes could predict the next.
    return f'{secrets.randbelow(10 ** CODE_LENGTH):0{CODE_LENGTH}d}'


def hash_code(code):
    return hmac.new(
        settings.SECRET_KEY.encode(), str(code).encode(), hashlib.sha256,
    ).hexdigest()


def issue_code(user):
    """
    Returns (row, plaintext_code). The plaintext exists only long enough to be emailed and is
    never persisted or logged. Raises ResendThrottled.
    """
    now = timezone.now()
    window = EmailVerification.objects.filter(
        user=user, created_at__gt=now - timedelta(hours=1),
    )

    latest = window.order_by('-created_at').first()
    if latest and now - latest.created_at < RESEND_COOLDOWN:
        remaining = RESEND_COOLDOWN - (now - latest.created_at)
        raise ResendThrottled(int(remaining.total_seconds()) + 1)

    if window.count() >= MAX_SENDS_PER_HOUR:
        oldest = window.order_by('created_at').first()
        remaining = oldest.created_at + timedelta(hours=1) - now
        raise ResendThrottled(max(int(remaining.total_seconds()) + 1, 1))

    # Expire anything still outstanding, so a code the user abandoned cannot be used later.
    EmailVerification.objects.filter(user=user, consumed_at__isnull=True).update(expires_at=now)

    code = generate_code()
    row = EmailVerification.objects.create(
        user=user, code_hash=hash_code(code), created_at=now, expires_at=now + CODE_TTL,
    )
    return row, code


def verify_code(user, code):
    """Returns OK / INVALID / EXPIRED / LOCKED / NO_CODE. Never raises on bad input."""
    now = timezone.now()
    row = (
        EmailVerification.objects
        .filter(user=user, consumed_at__isnull=True)
        .order_by('-created_at')
        .first()
    )
    if row is None:
        return NO_CODE
    if row.attempts >= MAX_ATTEMPTS:
        return LOCKED
    if row.expires_at <= now:
        return EXPIRED

    if not hmac.compare_digest(row.code_hash, hash_code(code or '')):
        # F() rather than row.attempts += 1: two concurrent guesses must both count, or the
        # cap is bypassable by racing.
        EmailVerification.objects.filter(pk=row.pk).update(attempts=F('attempts') + 1)
        return INVALID

    row.consumed_at = now
    row.save(update_fields=['consumed_at'])
    return OK
