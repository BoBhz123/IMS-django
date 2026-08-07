from .models import get_account


class AccountScopedMixin:
    """
    Restricts a viewset to the requesting user's account.

    Explicit rather than magic: an auto-filtering manager or thread-local middleware would
    have to reach for global request state, which is absent in management commands, the
    shell, and background jobs — the places where an unfiltered queryset does the most
    damage. Here the scoping is visible in the class that needs it.

    `account_lookup` is the query path from this viewset's model to the Account, for models
    that reach it through a parent (e.g. ProductImage -> 'product__account').
    """

    account_lookup = 'account'

    @property
    def account(self):
        return get_account(self.request.user)

    def get_queryset(self):
        # get_account returns None for a user with no membership, and filter(account=None)
        # yields nothing — the safe direction. Superusers reach these endpoints only if they
        # also hold a membership; platform-wide access is via Django Admin, not the API.
        return super().get_queryset().filter(**{self.account_lookup: self.account})

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['account'] = self.account
        return context

    def perform_create(self, serializer):
        serializer.save(account=self.account)
