from rest_framework.permissions import BasePermission

from .models import get_account


class HasActiveSubscription(BasePermission):
    """
    Requires a live subscription or a running trial. Platform superadmins bypass it.

    The 403 body carries a machine-readable code so the frontend can route to a subscribe
    screen instead of showing a generic "you don't have permission" toast. This is the lock
    the whole paywall rests on: every endpoint gets it from DEFAULT_PERMISSION_CLASSES, and
    the escape hatches (verify, resend, status, config, checkout, redeem) shed it explicitly.
    """

    message = {
        'detail': 'Your subscription has expired. Renew it to continue using the app.',
        'code': 'subscription_expired',
    }

    # A finished trial is not a lapsed subscription and should not be told it is. The SPA
    # shows a different headline for each, and "renew your subscription" to someone who has
    # never paid reads as a billing error.
    trial_message = {
        'detail': 'Your free trial has ended. Choose a plan to continue using the app.',
        'code': 'trial_expired',
    }

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True

        account = get_account(user)
        if account is None:
            return False
        if account.has_active_subscription:
            return True

        # Set per-request, so the instance DRF built for this view reports the right reason.
        if account.subscription_status == account.TRIALING:
            self.message = self.trial_message
        return False


class IsPlatformAdmin(BasePermission):
    """Platform-owner operations: every account's data, billing controls, global stats."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_superuser)
