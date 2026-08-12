"""
Outbound onboarding email.

Sent inline on the request thread. That is a deliberate trade: this project has no worker
queue, and adding one is a larger change than this phase warrants. The cost is latency on
signup; the mitigation is that a failed send never fails the request, because the user can
resend. Blocking registration on a third party's SMTP availability would turn a recoverable
annoyance into an unrecoverable one.

Every message goes out as multipart/alternative — HTML *and* plain text. Not for looks: a
single-part HTML mail with no text alternative is one of the oldest spam signals there is,
and plenty of filters weight it heavily. The text part is a real rendering of the same
content, not a "please enable HTML" stub, because that is worth as little to a filter as it
is to someone reading on a watch.
"""

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from . import verification

logger = logging.getLogger(__name__)

# One template pair for every one-time code. The two flows differ in wording, not in layout,
# and a second copy of the table scaffolding is a second thing to keep rendering correctly in
# Outlook.
OTP_TEMPLATE = 'emails/otp_code'


def _send_code(user, code, *, subject, context, what):
    """Returns True if the message was handed to the mail backend. Never raises."""
    if not user.email:
        logger.error('No email address for user %s — cannot send %s', user.pk, what)
        return False

    account = getattr(getattr(user, 'membership', None), 'account', None)
    context = {
        'code': code,
        # Empty, not a stand-in phrase: the templates decide how to word its absence,
        # and 'your account' only reads correctly in the middle of one specific sentence.
        'business_name': account.name if account else '',
        'ttl_minutes': int(verification.CODE_TTL.total_seconds() // 60),
        **context,
    }

    text_body = render_to_string(f'{OTP_TEMPLATE}.txt', context)
    html_body = render_to_string(f'{OTP_TEMPLATE}.html', context)

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[user.email],
    )
    message.attach_alternative(html_body, 'text/html')

    try:
        message.send(fail_silently=False)
    except Exception:
        # Reported to Sentry through the logging integration; the caller decides what to do.
        logger.exception('Failed to send %s to user %s', what, user.pk)
        return False
    return True


def send_verification_code(user, code):
    return _send_code(
        user, code,
        # The [IMS] tag is for the reader scanning a crowded inbox, not for the filter —
        # bracketed tags do nothing for spam scoring either way. "code" and not "OTP":
        # people know what a code is.
        subject='[IMS] Your verification code',
        context={
            'preheader': 'Your IMS verification code — valid for a few minutes.',
            'heading': 'Confirm your email address',
            'intro': (
                'Enter this code in the app to finish setting up your account. '
                'It is the last step.'
            ),
            'code_label': 'Verification code',
            'reassurance': (
                'If you did not create an IMS account, you can ignore this email — nothing '
                'has been charged and no data has been stored.'
            ),
        },
        what='a verification code',
    )


def send_password_reset_code(user, code):
    return _send_code(
        user, code,
        subject='[IMS] Your password reset code',
        context={
            'preheader': 'Your IMS password reset code — valid for a few minutes.',
            'heading': 'Reset your password',
            'intro': 'Enter this code in the app to choose a new password.',
            'code_label': 'Password reset code',
            'reassurance': (
                'If you did not ask to change your password, ignore this email — your '
                'password has not been changed. Someone may know your current one, so sign '
                'in and change it if you are unsure.'
            ),
        },
        what='a password reset code',
    )
