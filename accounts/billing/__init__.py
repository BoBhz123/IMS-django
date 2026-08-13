from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from .base import PLAN_KEYS, BillingProvider, ProviderUnavailable, UnknownPlan
from .dummy import DummyProvider
from .paddle import PaddleProvider

__all__ = [
    'PLAN_KEYS', 'BillingProvider', 'PaddleProvider', 'ProviderUnavailable', 'UnknownPlan',
    'get_provider',
]


def get_provider():
    """The configured card-payment provider. Raises ImproperlyConfigured for a bad setting."""
    configured = getattr(settings, 'BILLING_PROVIDER', 'dummy')
    if configured == 'dummy':
        return DummyProvider()
    if configured == 'paddle':
        return PaddleProvider()
    raise ImproperlyConfigured(f'Unknown BILLING_PROVIDER: {configured!r}')
