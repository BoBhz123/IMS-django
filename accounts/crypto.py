"""
Field-level encryption for the payment log.

One key, one algorithm, one place. Fernet is AES-128-CBC with an HMAC and a timestamp, which
is the right shape for "encrypt this short string at rest" — it authenticates, so a tampered
ciphertext fails loudly instead of decrypting to garbage.

**What this defends against**: a leaked database dump, a stray backup, a replica somebody
forgot to lock down, a support user with read access to the table. **What it does not**: a
compromised application server. The key is in the process environment, so anything that can
run this module can decrypt. Saying so plainly matters — encryption at rest is routinely sold
as more than it is.
"""

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

logger = logging.getLogger(__name__)

# What `details` returns when the ciphertext will not open. A marker, not an exception: one
# unreadable row must not take down a changelist that is showing fifty.
UNREADABLE = '[unreadable — wrong or rotated encryption key]'


def _derive_key_from_secret():
    """
    A deterministic Fernet key from SECRET_KEY, for local development only.

    Deliberately *not* silently allowed in production: rotating SECRET_KEY would render every
    stored record unreadable, and SECRET_KEY is rotated for reasons that have nothing to do
    with this table. get_fernet() only reaches here when DEBUG is on.
    """
    digest = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    return base64.urlsafe_b64encode(digest)


def get_fernet():
    """
    The configured cipher.

    Raises ImproperlyConfigured in production when PAYMENT_ENCRYPTION_KEY is unset, rather
    than falling back to a SECRET_KEY-derived key. A fallback would work perfectly until the
    day somebody rotated SECRET_KEY, and then every payment record would be lost at once with
    no error to trace it to.
    """
    key = getattr(settings, 'PAYMENT_ENCRYPTION_KEY', '') or ''
    if key:
        try:
            return Fernet(key.encode() if isinstance(key, str) else key)
        except (ValueError, TypeError) as exc:
            raise ImproperlyConfigured(
                'PAYMENT_ENCRYPTION_KEY is not a valid Fernet key. Generate one with: '
                'python -c "from cryptography.fernet import Fernet; '
                'print(Fernet.generate_key().decode())"'
            ) from exc

    if settings.DEBUG:
        return Fernet(_derive_key_from_secret())

    raise ImproperlyConfigured(
        'PAYMENT_ENCRYPTION_KEY must be set when DEBUG is off — payment records cannot be '
        'stored unencrypted. Generate one with: python -c "from cryptography.fernet import '
        'Fernet; print(Fernet.generate_key().decode())"'
    )


def encrypt_text(value):
    """Encrypt a string to bytes. Empty in, empty out — never a ciphertext of ''."""
    if value is None or value == '':
        return b''
    return get_fernet().encrypt(str(value).encode('utf-8'))


def decrypt_text(value):
    """
    Decrypt bytes back to a string, or UNREADABLE if the key does not fit.

    Accepts memoryview as well as bytes: psycopg hands BinaryField back as a memoryview, and
    Fernet will not take one.
    """
    if not value:
        return ''
    if isinstance(value, memoryview):
        value = value.tobytes()

    try:
        return get_fernet().decrypt(bytes(value)).decode('utf-8')
    except (InvalidToken, ValueError, TypeError):
        # Not logged with the ciphertext or the key — just the fact, so a rotation shows up
        # in the log as a pattern rather than one confusing row.
        logger.warning('Could not decrypt a payment record; wrong or rotated key.')
        return UNREADABLE
