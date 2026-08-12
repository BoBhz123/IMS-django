from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from . import verification
from .billing.activation import start_trial
from .emails import send_verification_code
from .models import Account, get_account
from .serializers import VerifyEmailSerializer, subscription_payload
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
        # Always re-read from the database, so a superadmin's manual override in the Django
        # admin — activate, extend, revoke — shows up on the next fetch with nothing to
        # invalidate. There is no cache here on purpose.
        return Response(subscription_payload(request.user))


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
            #
            # Verification is where the cardless trial actually begins. start_trial restamps
            # trial_ends_at from now rather than honouring the value written at signup, so a
            # customer who took three days to find the email still gets a full 14 — the
            # signup value only exists so the column is never null.
            start_trial(account)

        # `subscription_status`, matching the name every other endpoint uses for this column.
        # One name across the API is worth more than the shorter key here.
        return Response({
            'detail': 'Email verified.',
            'subscription_status': account.subscription_status if account else None,
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
