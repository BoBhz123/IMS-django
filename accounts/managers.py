from django.db import models


class AccountScopedQuerySet(models.QuerySet):
    def for_account(self, account):
        """
        Narrow to one account's rows. A None account yields nothing — the safe reading of
        "this user has no account", and never "show everything".
        """
        if account is None:
            return self.none()
        return self.filter(account=account)


class AccountScopedManager(models.Manager.from_queryset(AccountScopedQuerySet)):
    """
    Default manager for account-owned models.

    Deliberately does NOT auto-filter. An auto-filtering manager needs the request in
    thread-local state, which is absent in management commands, the shell, and background
    jobs — so it silently returns unfiltered data in exactly the places a bulk mistake does
    the most damage. Scoping is applied explicitly by AccountScopedMixin (views) and by
    .for_account() (everywhere else).
    """
