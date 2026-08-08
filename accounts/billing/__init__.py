from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from .base import PLAN_KEYS, BillingProvider, ProviderUnavailable, UnknownPlan
from .dummy import DummyProvider

__all__ = [
    'PLAN_KEYS', 'BillingProvider', 'ProviderUnavailable', 'UnknownPlan', 'get_provider',
]


def get_provider():
    """The configured card-payment provider. Raises ImproperlyConfigured for a bad setting."""
    configured = getattr(settings, 'BILLING_PROVIDER', 'dummy')
    if configured == 'dummy':
        return DummyProvider()
    if configured == 'paddle':
        raise ImproperlyConfigured(
            "BILLING_PROVIDER='paddle' is not implemented yet — Paddle checkout lands in "
            'Phase 2.5b-2, once seller approval comes through. Use the dummy provider and '
            'discount keys until then.'
        )
    raise ImproperlyConfigured(f'Unknown BILLING_PROVIDER: {configured!r}')
