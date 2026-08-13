"""
Superuser-only Django admin.

`is_staff` is what Django itself gates `/admin/` on, and that is not the boundary this app
wants. Under the Phase 2 role model `is_staff` means "platform support" while `is_superuser`
means "platform owner", and the admin exposes every account's business data plus the
subscription actions that decide what a customer has paid for. Leaving the default in place
means the boundary is only as good as nobody ever setting `is_staff` on a subscriber.

Enforced at the AdminSite rather than with middleware on purpose: `AdminSite.has_permission`
is the single function every admin view already funnels through (`admin_view` wraps each one),
so there is no route — an app's index, a model changelist, the password-change form, the
autocomplete JSON endpoints — that can be added later and miss the check. A middleware
matching on the `/admin/` path prefix would have to be kept in sync with wherever the admin
happens to be mounted.
"""

from django.contrib.admin import AdminSite
from django.shortcuts import redirect


class SuperuserOnlyAdminSite(AdminSite):
    """The admin site, restricted to active superusers."""

    def has_permission(self, request):
        # Deliberately drops Django's `request.user.is_staff` test rather than adding to it:
        # is_superuser already implies every permission, so a superuser who somehow lacks
        # is_staff should still get in, and a staff member who is not a superuser never
        # should. `is_active` is kept — a deactivated account must not retain admin.
        return request.user.is_active and request.user.is_superuser

    def login(self, request, extra_context=None):
        """
        Send an already-authenticated non-superuser to the app instead of a login form.

        `admin_view` redirects to this view whenever `has_permission` is False, so without
        this override a logged-in staff user is shown a login page for the session they are
        already in — an infinite-looking loop rather than a boundary. Anonymous callers still
        get the normal form: they may yet be a superuser who has not logged in.
        """
        if request.user.is_authenticated:
            # '/' is the SPA catch-all in ims/urls.py — the main application dashboard.
            return redirect('/')
        return super().login(request, extra_context)
