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
