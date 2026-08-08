"""
Discount key codes.

Keys are handed over in person or read out over WhatsApp, so the alphabet and the grouping
matter as much as the entropy.
"""

import secrets

# No 0/O, no 1/I/L. Those are the pairs that turn into support calls when a key is read
# aloud or copied off a photo.
ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
KEY_LENGTH = 12
GROUP_SIZE = 4


def generate_code():
    """12 characters from a 31-symbol alphabet — around 10^17 combinations."""
    return ''.join(secrets.choice(ALPHABET) for _ in range(KEY_LENGTH))


def normalize_key(raw):
    """
    What the user typed, reduced to what is stored.

    People type the dashes they were shown, or none, or lowercase. All three are the same
    key; normalizing on the way in means the database only ever holds one form.
    """
    return ''.join(str(raw or '').split()).replace('-', '').upper()


def format_key(code):
    """Dash-separated groups of four, which is how the key is displayed and dictated."""
    return '-'.join(code[i:i + GROUP_SIZE] for i in range(0, len(code), GROUP_SIZE))
