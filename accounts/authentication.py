"""
JWT authentication that loads the caller's account in the same query as the caller.

Every authenticated request in this app resolves `get_account(request.user)` — the
subscription permission asks for it, `AccountScopedMixin` filters every queryset by it, and
the serializer context carries it. That traversal is `user -> membership -> account`, and
both hops are lazy: on a plain `User` fetched by id they cost one query each, on top of the
query that fetched the user. Three queries before a view has looked at a single row of
business data.

Django caches the descriptor after the first access, so the cost is per request rather than
per call — but the dashboard alone issues about ten requests, so it is thirty round trips to
resolve one membership that never changes during a page load. Selecting the join up front
makes it one.

Measured on the list endpoints: /inventory/orders/ went from 6 queries to 4, and
/inventory/products/ from 6 to 4 — a third of each, and all of it fixed overhead that was
being paid again on every call regardless of how much data was returned.
"""

from django.utils.translation import gettext_lazy as _
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed, InvalidToken
from rest_framework_simplejwt.settings import api_settings
from rest_framework_simplejwt.utils import get_md5_hash_password


class AccountAwareJWTAuthentication(JWTAuthentication):
    """
    `JWTAuthentication` with the membership and account joined into the user lookup.

    This overrides `get_user` wholesale rather than wrapping it, because the only thing that
    needs to change is the queryset and there is no seam for that upstream. The consequence
    is that the checks below are a *copy* of the library's, and a new check added upstream
    would not appear here on its own — so each one is pinned by a test in
    `AccountAwareJWTAuthenticationTests`, which fails if this class stops rejecting what the
    stock class rejects. Keep that pairing if this is ever updated.
    """

    def get_user(self, validated_token):
        try:
            user_id = validated_token[api_settings.USER_ID_CLAIM]
        except KeyError as exc:
            raise InvalidToken(
                _('Token contained no recognizable user identification')
            ) from exc

        try:
            # The whole point of this class. `membership` is a reverse one-to-one and
            # `account` a forward FK from it, so one join replaces two deferred queries.
            user = (
                self.user_model.objects
                .select_related('membership__account')
                .get(**{api_settings.USER_ID_FIELD: user_id})
            )
        except self.user_model.DoesNotExist as exc:
            raise AuthenticationFailed(_('User not found'), code='user_not_found') from exc

        if api_settings.CHECK_USER_IS_ACTIVE and not user.is_active:
            raise AuthenticationFailed(_('User is inactive'), code='user_inactive')

        if api_settings.CHECK_REVOKE_TOKEN:
            if validated_token.get(
                api_settings.REVOKE_TOKEN_CLAIM
            ) != get_md5_hash_password(user.password):
                raise AuthenticationFailed(
                    _("The user's password has been changed."), code='password_changed',
                )

        return user
