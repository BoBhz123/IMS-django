"""
Outbound onboarding email.

Sent inline on the request thread. That is a deliberate trade: this project has no worker
queue, and adding one is a larger change than this phase warrants. The cost is latency on
signup; the mitigation is that a failed send never fails the request, because the user can
resend. Blocking registration on a third party's SMTP availability would turn a recoverable
annoyance into an unrecoverable one.
"""

import logging

from django.conf import settings
from django.core.mail import send_mail
from django.template.loader import render_to_string

from . import verification

logger = logging.getLogger(__name__)


def _send_code(user, code, *, template, subject, what):
    """Returns True if the message was handed to the mail backend. Never raises."""
    if not user.email:
        logger.error('No email address for user %s — cannot send %s', user.pk, what)
        return False

    account = getattr(getattr(user, 'membership', None), 'account', None)
    body = render_to_string(template, {
        'code': code,
        'business_name': account.name if account else 'your account',
        'ttl_minutes': int(verification.CODE_TTL.total_seconds() // 60),
    })

    try:
        send_mail(
            subject=subject,
            message=body,
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[user.email],
            fail_silently=False,
        )
    except Exception:
        # Reported to Sentry through the logging integration; the caller decides what to do.
        logger.exception('Failed to send %s to user %s', what, user.pk)
        return False
    return True


def send_verification_code(user, code):
    return _send_code(
        user, code,
        template='accounts/verification_code.txt',
        subject='Your verification code',
        what='a verification code',
    )


def send_password_reset_code(user, code):
    return _send_code(
        user, code,
        template='accounts/password_reset_code.txt',
        subject='Your password reset code',
        what='a password reset code',
    )
