import logging

from django.db import transaction
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.exceptions import TokenError

from . import verification
from .audit import log_auth_event
from .billing.activation import TrialAlreadyUsed, start_trial
from .emails import send_password_reset_code, send_verification_code
from .models import Account, get_account
# subscription_payload replaces the direct SubscriptionStatusSerializer use that used to be
# here: the no-account case (superadmin) now lives in that helper rather than being spelled
# out in the view, and /auth/users/me/ shares it.
from .serializers import (
    PasswordResetConfirmSerializer, VerifyEmailSerializer, subscription_payload,
)
from .throttles import (
    PasswordResetRequestThrottle, PasswordResetVerifyThrottle, ResendCodeThrottle,
    VerifyEmailThrottle,
)

logger = logging.getLogger(__name__)

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
            #
            # An account can be back at pending_verification with its trial already spent —
            # an admin resetting the status, or a re-verification after a support fix. That
            # must land on the paywall, not 500 and not hand out a second free fortnight.
            try:
                start_trial(account)
            except TrialAlreadyUsed:
                account.subscription_status = Account.PENDING_PAYMENT
                account.save(update_fields=['subscription_status'])

        log_auth_event('email_verified', request.user, account=getattr(account, 'pk', None))
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


# Changing a password is not a paid feature, and someone who thinks their account is
# compromised must be able to secure it whether or not the subscription is live — so these
# shed HasActiveSubscription too. They are not open to anonymous callers: the code goes to
# the address on file for the *authenticated* user, which is what makes a forgot-password
# endpoint's enumeration problem not exist here.
PASSWORD_RESET_PERMISSIONS = [IsAuthenticated]


class PasswordResetRequestView(APIView):
    """Step 1: email a code to the address on file."""

    permission_classes = PASSWORD_RESET_PERMISSIONS
    throttle_classes = [PasswordResetRequestThrottle]

    def post(self, request):
        try:
            _, code = verification.issue_code(
                request.user, purpose=verification.PASSWORD_RESET,
            )
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

        send_password_reset_code(request.user, code)
        # Reports success even when the send failed, matching ResendCodeView: the user's only
        # recourse is this same button either way. The code itself is never in the response.
        return Response({'detail': 'A password reset code is on its way.'})


class PasswordResetVerifyView(APIView):
    """
    Step 2: is this code right? Decides nothing and grants nothing.

    It exists so the user finds out about a typo before being asked to think up a password,
    and it checks with consume=False so the code survives to be spent at step 3. A wrong
    guess still counts against the attempt cap.
    """

    permission_classes = PASSWORD_RESET_PERMISSIONS
    throttle_classes = [PasswordResetVerifyThrottle]

    def post(self, request):
        serializer = VerifyEmailSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        result = verification.verify_code(
            request.user, serializer.validated_data['code'],
            purpose=verification.PASSWORD_RESET, consume=False,
        )
        if result != verification.OK:
            code, detail = _ERROR_CODES[result]
            return Response(
                {'detail': detail, 'code': code}, status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({'detail': 'Code accepted.'})


class PasswordResetConfirmView(APIView):
    """Step 3: the only endpoint that changes anything. Takes the code and the password."""

    permission_classes = PASSWORD_RESET_PERMISSIONS
    throttle_classes = [PasswordResetVerifyThrottle]

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(
            data=request.data, context={'user': request.user},
        )
        # Password rules are checked before the code is spent. The other order costs the user
        # a fresh email and a 60-second wait every time they pick a password the validators
        # dislike, which reads as the app being broken.
        serializer.is_valid(raise_exception=True)

        result = verification.verify_code(
            request.user, serializer.validated_data['code'],
            purpose=verification.PASSWORD_RESET,
        )
        if result != verification.OK:
            code, detail = _ERROR_CODES[result]
            return Response(
                {'detail': detail, 'code': code}, status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            request.user.set_password(serializer.validated_data['new_password'])
            request.user.save(update_fields=['password'])

        revoked = _revoke_refresh_tokens(request.user)
        log_auth_event('password_changed', request.user, sessions_revoked=revoked)
        return Response({
            'detail': 'Your password has been changed. Please sign in again.',
            'sessions_revoked': revoked,
        })


def _revoke_refresh_tokens(user):
    """
    Blacklist every outstanding refresh token for the user.

    A reset is what someone does when they believe their account is compromised. Django's
    session auth is not in play here — the SPA holds JWTs — and a refresh token issued before
    the change stays valid for its full 30 days unless it is blacklisted, so without this the
    reset locks out nobody. Access tokens already issued still run out their remaining hours;
    shortening that means checking a revocation list on every request, which is a bigger
    change than this warrants and is worth stating rather than leaving as a silent gap.
    """
    revoked = 0
    for outstanding in OutstandingToken.objects.filter(user=user):
        try:
            RefreshToken(outstanding.token).blacklist()
            revoked += 1
        except TokenError:
            # Already blacklisted, already expired, or unparseable. Nothing to revoke.
            continue
    return revoked
