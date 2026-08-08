from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import verification
from .emails import send_verification_code
from .models import Account, get_account
from .serializers import SubscriptionStatusSerializer, VerifyEmailSerializer
from .throttles import ResendCodeThrottle, VerifyEmailThrottle

# Every view here declares IsAuthenticated on its own, dropping the project-wide
# HasActiveSubscription default. These are the endpoints an un-onboarded user needs in order
# to *become* onboarded — leave the default in place and the wall blocks the only way through
# it, stranding the account until an admin intervenes.
ONBOARDING_PERMISSIONS = [IsAuthenticated]

_ERROR_CODES = {
    verification.INVALID: ('invalid_code', 'That code is not correct.'),
    verification.EXPIRED: ('code_expired', 'That code has expired. Request a new one.'),
    verification.LOCKED: ('code_locked', 'Too many incorrect attempts. Request a new code.'),
    verification.NO_CODE: (
        'no_code', 'There is no code waiting to be used. Request a new one.',
    ),
}


class SubscriptionStatusView(APIView):
    """What the SPA reads to decide which onboarding screen, if any, to show."""

    permission_classes = ONBOARDING_PERMISSIONS

    def get(self, request):
        account = get_account(request.user)
        if account is None:
            # Superadmins have no membership, and neither does a user whose provisioning
            # failed. Reporting either as "unpaid" would send the platform owner to a paywall.
            return Response({
                'status': None,
                'plan_type': '',
                'expires_at': None,
                'has_active_subscription': bool(request.user.is_superuser),
                'business_name': '',
                'phone': '',
                'email': request.user.email,
            })
        return Response(SubscriptionStatusSerializer(account).data)


class VerifyEmailView(APIView):
    permission_classes = ONBOARDING_PERMISSIONS
    throttle_classes = [VerifyEmailThrottle]

    def post(self, request):
        serializer = VerifyEmailSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = verification.verify_code(request.user, serializer.validated_data['code'])
        if result != verification.OK:
            code, detail = _ERROR_CODES[result]
            return Response(
                {'detail': detail, 'code': code}, status=status.HTTP_400_BAD_REQUEST,
            )

        account = get_account(request.user)
        if account and account.subscription_status == Account.PENDING_VERIFICATION:
            # Guarded rather than unconditional: re-verifying must never downgrade an account
            # that has since paid.
            account.subscription_status = Account.PENDING_PAYMENT
            account.save(update_fields=['subscription_status'])

        return Response({
            'detail': 'Email verified.',
            'status': account.subscription_status if account else None,
        })


class ResendCodeView(APIView):
    permission_classes = ONBOARDING_PERMISSIONS
    throttle_classes = [ResendCodeThrottle]

    def post(self, request):
        try:
            _, code = verification.issue_code(request.user)
        except verification.ResendThrottled as throttled:
            return Response(
                {
                    'detail': (
                        f'Wait {throttled.retry_after} seconds before requesting another code.'
                    ),
                    'code': 'resend_throttled',
                    'retry_after': throttled.retry_after,
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        send_verification_code(request.user, code)
        # Reports success even when the send failed. The user's only recourse is this same
        # button either way, and the distinction leaks nothing useful.
        return Response({'detail': 'A new code is on its way.'})
