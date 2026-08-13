from .audit import log_deletion
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

    def perform_destroy(self, instance):
        # Logged here rather than in a post_delete signal because this is the only layer that
        # knows *who* deleted the row — a signal sees the instance and nothing else. One
        # override covers every account-scoped collection, so a new viewset is audited by
        # inheriting the mixin it already has to inherit in order to be scoped at all.
        #
        # The pk is read first and logged last. Django's collector sets `instance.pk = None`
        # once the row is gone, so reading it afterwards records `pk=None`; and logging
        # before the delete would record deletions that never happened, since a PROTECT
        # foreign key raises here and ProtectedDeleteMixin turns that into a 409.
        model_name, pk = type(instance).__name__, instance.pk
        super().perform_destroy(instance)
        log_deletion(self.request.user, self.account, model_name, pk)
