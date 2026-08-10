from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import F
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import Account, DiscountKey, DiscountKeyRedemption, get_account
from ..serializers import SubscriptionStatusSerializer
from ..throttles import RedeemKeyThrottle
from . import get_provider
from ..audit import log_auth_event
from .activation import activate_account
from .base import ProviderUnavailable, UnknownPlan
from .keys import normalize_key
from .serializers import CreateCheckoutSerializer, RedeemKeySerializer

# These are the endpoints an unpaid account needs in order to *stop* being unpaid, so each
# sheds the project-wide HasActiveSubscription default. Leave the default in place and the
# paywall blocks the only route through the paywall.
BILLING_PERMISSIONS = [IsAuthenticated]

# One body for unknown, expired, exhausted, and deactivated keys. Distinguishing them would
# turn the endpoint into an oracle that confirms which codes exist.
_INVALID_KEY = {'detail': 'That key is not valid.', 'code': 'invalid_key'}


class RedeemKeyView(APIView):
    permission_classes = BILLING_PERMISSIONS
    throttle_classes = [RedeemKeyThrottle]

    def post(self, request):
        serializer = RedeemKeySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        code = normalize_key(serializer.validated_data['code'])

        account = get_account(request.user)
        if account is None:
            return Response(
                {
                    'detail': 'This login has no business account to activate.',
                    'code': 'no_account',
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            with transaction.atomic():
                # select_for_update, not a plain get: two concurrent posts would otherwise
                # both read redemption_count=0, both pass the check, and both redeem a
                # single-use key.
                key = DiscountKey.objects.select_for_update().filter(code=code).first()
                if key is None or not key.is_redeemable():
                    return Response(_INVALID_KEY, status=status.HTTP_400_BAD_REQUEST)

                if key.percent_off != 100:
                    # Distinguishable on purpose: the owner needs to know the key is real
                    # but unsupported, not hunt for a typo. A partial discount needs a
                    # gateway charge for the remainder, which does not exist yet.
                    return Response(
                        {
                            'detail': (
                                'Partial-discount keys are not supported yet. '
                                'Please contact support.'
                            ),
                            'code': 'partial_discount_unsupported',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )

                DiscountKeyRedemption.objects.create(key=key, account=account)
                # F(), not key.redemption_count + 1: the lock makes that safe here, but the
                # expression keeps the count correct regardless of what this row holds.
                DiscountKey.objects.filter(pk=key.pk).update(
                    redemption_count=F('redemption_count') + 1,
                )

                if key.grants == DiscountKey.LIFETIME:
                    activate_account(account, plan_type=Account.ONE_TIME)
                else:
                    activate_account(
                        account, plan_type=Account.MONTHLY, months=key.grant_months,
                    )
        except IntegrityError:
            # The unique (key, account) constraint fired — this account already used it.
            # Safe to name: the caller can see their own redemption history anyway.
            return Response(
                {
                    'detail': 'This account has already used that key.',
                    'code': 'already_redeemed',
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # A subscription was granted without a card payment — the event most worth being
        # able to reconstruct later, since it is the one that moves money outside the
        # gateway. The key id, not the code: the code is a bearer credential.
        log_auth_event(
            'subscription_granted_by_key',
            request.user,
            account=account.pk,
            key_id=key.pk,
            grants=key.grants,
        )

        # The SPA re-routes off this body, so return exactly what GET /accounts/subscription/
        # returns rather than a bespoke shape it would need a second parser for.
        return Response(SubscriptionStatusSerializer(account).data)


class BillingConfigView(APIView):
    """
    What the plan screen renders. Card checkout availability is a server fact, so the SPA
    can hide the pay buttons instead of offering a button that always fails.
    """

    permission_classes = BILLING_PERMISSIONS

    def get(self, request):
        try:
            card_checkout_available = get_provider().name != 'dummy'
        except Exception:
            # A misconfigured provider must not take down the screen that offers the
            # discount-key alternative.
            card_checkout_available = False

        return Response({
            'card_checkout_available': card_checkout_available,
            'plans': [
                {
                    'key': Account.MONTHLY,
                    'name': 'Monthly',
                    'price_usd': settings.BILLING_PRICE_MONTHLY_USD,
                    'period': 'per month',
                    'description': 'Full access, billed monthly. Cancel any time.',
                },
                {
                    'key': Account.ONE_TIME,
                    'name': 'Lifetime',
                    'price_usd': settings.BILLING_PRICE_ONE_TIME_USD,
                    'period': 'one time',
                    'description': 'Pay once, use it forever. No recurring charge.',
                },
            ],
        })


class CreateCheckoutView(APIView):
    permission_classes = BILLING_PERMISSIONS

    def post(self, request):
        serializer = CreateCheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            payload = get_provider().create_checkout(
                get_account(request.user), serializer.validated_data['plan'],
            )
        except UnknownPlan:
            return Response(
                {'detail': 'Unknown plan.', 'code': 'unknown_plan'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProviderUnavailable as unavailable:
            # 503, not 500: nothing is broken, the capability simply is not switched on.
            return Response(
                {'detail': str(unavailable), 'code': 'card_checkout_unavailable'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(payload)
