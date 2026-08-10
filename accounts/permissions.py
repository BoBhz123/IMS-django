from rest_framework.permissions import BasePermission

from .models import get_account


class HasActiveSubscription(BasePermission):
    """
    Requires a live subscription. Platform superadmins bypass it.

    The 403 body carries a machine-readable code so the frontend can route to a subscribe
    screen instead of showing a generic "you don't have permission" toast.
    """

    message = {
        'detail': 'Your subscription has expired. Renew it to continue using the app.',
        'code': 'subscription_expired',
    }

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False
        if user.is_superuser:
            return True
        account = get_account(user)
        return account is not None and account.has_active_subscription


class IsPlatformAdmin(BasePermission):
    """Platform-owner operations: every account's data, billing controls, global stats."""

    def has_permission(self, request, view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_superuser)
