"""The provider used by tests and by local development without gateway credentials."""

from .base import BillingProvider, ProviderUnavailable


class DummyProvider(BillingProvider):
    """
    Refuses card checkout, loudly.

    It deliberately does not fake a successful payment. A dummy that activated accounts
    would make a misconfigured production deployment indistinguishable from a working one
    until somebody went looking for the money. The discount-key path is the supported way
    to activate an account without a gateway, and it leaves an auditable record.
    """

    name = 'dummy'

    def create_checkout(self, account, plan_key):
        self.validate_plan(plan_key)
        raise ProviderUnavailable(
            'Card payment is not available yet. Use a discount key to activate this account.'
        )
