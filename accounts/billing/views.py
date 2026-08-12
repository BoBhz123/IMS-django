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

        # The SPA re-routes off this body, so return exactly what GET /accounts/subscription/
        # returns rather than a bespoke shape it would need a second parser for.
        return Response(SubscriptionStatusSerializer(account).data)


# One tier, three ways to pay for it. Every plan grants identical access — nothing anywhere
# in the app branches on plan_type to decide what a customer may do, only on whether their
# subscription is live. Keep it that way: the moment a feature checks plan_type, this becomes
# a tiered product and the whole permission story has to be revisited.
def _plan_catalogue():
    return [
        {
            'key': Account.MONTHLY,
            'name': 'Monthly',
            'price_usd': settings.BILLING_PRICE_MONTHLY_USD,
            'period': 'per month',
            'description': 'Full access, billed monthly. Cancel any time.',
            'highlight': False,
        },
        {
            'key': Account.ANNUAL,
            'name': 'Annual',
            'price_usd': settings.BILLING_PRICE_ANNUAL_USD,
            'period': 'per year',
            'description': 'Full access, billed yearly. Two months cheaper than monthly.',
            'highlight': True,
        },
        {
            'key': Account.ONE_TIME,
            'name': 'Lifetime',
            'price_usd': settings.BILLING_PRICE_ONE_TIME_USD,
            'period': 'one time',
            'description': 'Pay once, use it forever. No recurring charge.',
            'highlight': False,
        },
    ]


class BillingConfigView(APIView):
    """
    What the plan screen renders. Card checkout availability is a server fact, so the SPA
    can hide the pay buttons instead of offering a button that always fails.
    """

    permission_classes = BILLING_PERMISSIONS

    def get(self, request):
        try:
            provider = get_provider()
            card_checkout_available = provider.is_configured()
        except Exception:
            # A misconfigured provider must not take down the screen that offers the
            # discount-key and Whish/cash alternatives — that screen is the only way out of
            # the paywall for a customer who cannot use a card at all.
            provider = None
            card_checkout_available = False

        plans = _plan_catalogue()
        if provider is not None:
            # Per-plan, not global: a deployment that has configured monthly but not lifetime
            # should sell monthly rather than hide card payment altogether.
            for plan in plans:
                plan['card_available'] = bool(
                    card_checkout_available and provider.price_id_for(plan['key'])
                )
        else:
            for plan in plans:
                plan['card_available'] = False

        return Response({
            'card_checkout_available': card_checkout_available,
            'plans': plans,
            'trial_days': Account.TRIAL_DAYS,
            # Whish and cash settle over chat. Blank values mean the SPA hides that button
            # rather than rendering a link to nowhere.
            'local_payment': {
                'whatsapp_number': getattr(settings, 'WHATSAPP_NUMBER', ''),
                'telegram_username': getattr(settings, 'TELEGRAM_USERNAME', ''),
            },
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
