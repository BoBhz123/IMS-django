"""
Paddle, behind the BillingProvider seam.

Checkout is opened by Paddle.js in the browser, not by a server-side transaction create.
That is a deliberate choice: the overlay only needs a price id and the public client token,
so starting a checkout costs no API call and cannot fail because the server's API key is
stale or rate-limited. The server's job here is to decide *which* price the customer is
allowed to buy and to stamp the account id onto the checkout so the webhook can find its
way back. It never sends an amount or a currency — see the USD-only rule in CLAUDE.md.

Nothing in this module grants access. Only the webhook does, and only after verifying a
signature: the post-checkout redirect is attacker-controlled and is treated as decoration.
"""

import hashlib
import hmac
import time

from django.conf import settings

from ..models import Account
from .base import BillingProvider, ProviderUnavailable

# Paddle signs with the raw request body, so the mapping below is the only place plan keys
# turn into price ids. Keyed off the model's own constants so a new plan cannot be added to
# the choices without this dict failing loudly at config-check time.
PRICE_SETTING_NAMES = {
    Account.MONTHLY: 'PADDLE_PRICE_MONTHLY',
    Account.ANNUAL: 'PADDLE_PRICE_ANNUAL',
    Account.ONE_TIME: 'PADDLE_PRICE_LIFETIME',
}

# How long a signed notification stays acceptable. Paddle's own guidance is 5 seconds, which
# is too tight for a Heroku dyno that has just woken up; 5 minutes still makes a captured
# body useless long before anyone could replay it usefully.
SIGNATURE_MAX_AGE_SECONDS = 300


class PaddleProvider(BillingProvider):
    name = 'paddle'

    def __init__(self):
        self.environment = getattr(settings, 'PADDLE_ENVIRONMENT', 'sandbox')
        self.client_token = getattr(settings, 'PADDLE_CLIENT_TOKEN', '')

    def price_id_for(self, plan_key):
        """The configured price id for a plan, or '' when it has not been set up yet."""
        return getattr(settings, PRICE_SETTING_NAMES[plan_key], '')

    def is_configured(self):
        """
        Whether card checkout can actually be opened.

        Requires the client token and at least one price — a deployment mid-setup should
        show the plans it has rather than hiding checkout entirely.
        """
        return bool(self.client_token) and any(
            self.price_id_for(plan) for plan in PRICE_SETTING_NAMES
        )

    def create_checkout(self, account, plan_key):
        self.validate_plan(plan_key)
        if not self.client_token:
            raise ProviderUnavailable(
                'Card payment is not configured yet. Use a discount key, or pay by '
                'Whish or cash.'
            )

        price_id = self.price_id_for(plan_key)
        if not price_id:
            raise ProviderUnavailable(
                'That plan is not available for card payment yet. Use a discount key, or '
                'pay by Whish or cash.'
            )

        return {
            'provider': self.name,
            'environment': self.environment,
            'client_token': self.client_token,
            'price_id': price_id,
            'plan': plan_key,
            # Comes back verbatim on the webhook. It is how a completed payment is matched
            # to an account without trusting anything the browser reports.
            'custom_data': {
                'account_id': str(account.id) if account else '',
                'plan': plan_key,
            },
        }


def plan_for_price_id(price_id):
    """
    Reverse the price mapping for the webhook. None when the id is not one of ours.

    Needed because a notification names the price that was bought, not our plan key, and an
    unrecognised price must not be silently activated as a monthly plan.
    """
    if not price_id:
        return None
    for plan_key, setting_name in PRICE_SETTING_NAMES.items():
        if getattr(settings, setting_name, '') == price_id:
            return plan_key
    return None


def parse_signature_header(header):
    """
    Split Paddle's `ts=...;h1=...` header. Returns (timestamp, [h1 digests]).

    Tolerates several h1 values because Paddle sends one per active notification secret
    during a key rotation, and rejecting the rotation window would drop live events.
    """
    timestamp = None
    digests = []
    for part in (header or '').split(';'):
        key, _, value = part.partition('=')
        key, value = key.strip(), value.strip()
        if key == 'ts':
            timestamp = value
        elif key == 'h1' and value:
            digests.append(value)
    return timestamp, digests


def verify_signature(raw_body, header, secret, *, now=None, max_age=SIGNATURE_MAX_AGE_SECONDS):
    """
    Whether this body really came from Paddle.

    Signs `ts:body` over the *raw* bytes — re-serialising the parsed JSON changes whitespace
    and key order and the digest stops matching. compare_digest, not ==, so the comparison
    does not leak the expected value one byte at a time through timing.
    """
    if not secret:
        # No secret means every body is unverifiable. Denying is the only safe answer: this
        # endpoint is unauthenticated and hands out paid subscriptions.
        return False

    timestamp, digests = parse_signature_header(header)
    if not timestamp or not digests:
        return False

    try:
        signed_at = int(timestamp)
    except (TypeError, ValueError):
        return False

    now = time.time() if now is None else now
    if abs(now - signed_at) > max_age:
        # Replay window. Without it a captured body stays valid forever.
        return False

    payload = timestamp.encode() + b':' + raw_body
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, candidate) for candidate in digests)
