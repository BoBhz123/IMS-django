"""
The card-payment provider seam.

Not speculative generality: the gateway is the one piece of this phase a third party can
refuse outright, and the whole point of the interface is that the rest of the system —
endpoints, screens, tests — is finished and exercised before anyone knows the answer.
"""

from abc import ABC, abstractmethod

from ..models import Account

# Deliberately derived from the model rather than retyped, so a new plan cannot exist at
# checkout without also existing at activation.
PLAN_KEYS = tuple(choice[0] for choice in Account.PLAN_TYPE_CHOICES)


class UnknownPlan(Exception):
    """The client sent a plan key the server does not offer."""


class ProviderUnavailable(Exception):
    """Card checkout cannot be performed — no credentials, or the gateway is down."""


class BillingProvider(ABC):
    name = 'base'

    def is_configured(self):
        """
        Whether card checkout can actually be opened right now.

        Asked by the plan screen so it can hide a pay button rather than offer one that
        always fails. Deliberately not `name != 'dummy'`: a real provider with half its
        credentials filled in is just as unable to take a payment as no provider at all.
        """
        return False

    def price_id_for(self, plan_key):
        """The gateway price id backing a plan, or '' if this provider has none."""
        return ''

    @abstractmethod
    def create_checkout(self, account, plan_key):
        """
        Return whatever the SPA needs to open the hosted checkout, as a dict.

        Implementations map the plan *key* to their own configured price id. The client
        never sends a price, an amount, or a currency — accepting any of those means
        somebody edits the request to one cent.
        """

    @staticmethod
    def validate_plan(plan_key):
        if plan_key not in PLAN_KEYS:
            raise UnknownPlan(plan_key)
        return plan_key
