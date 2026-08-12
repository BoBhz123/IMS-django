"""
Prove the mail configuration works, without going through signup.

Exists because diagnosing "the OTP never arrived" through the signup flow is slow and
destructive — it creates a user, and the failure surfaces as a log line the operator has to
go looking for. This puts the exact SMTP exception on the terminal instead.
"""

import smtplib
import traceback

from django.conf import settings
from django.core.mail import get_connection, send_mail
from django.core.management.base import BaseCommand, CommandError

# Brevo's own wording for each. Mapped because the raw SMTP codes send people looking in the
# wrong place — 525 in particular reads like a credential problem and is not one.
SMTP_HINTS = {
    525: (
        'Brevo rejected the source IP, not the credentials. Brevo has an "Authorised IPs" '
        'allowlist under SMTP & API → SMTP; when it is on, only listed IPs may relay. Add '
        'this machine\'s public IP (or your dyno\'s), or turn the restriction off.'
    ),
    535: (
        'Bad SMTP credentials. EMAIL_HOST_USER is the Brevo *login* (…@smtp-brevo.com), and '
        'EMAIL_HOST_PASSWORD is the SMTP key — not your Brevo account password and not an '
        'API key.'
    ),
    550: (
        'The sender was refused. DEFAULT_FROM_EMAIL must be a verified sender in Brevo. A '
        'free-mail address (gmail.com, outlook.com) can be verified but cannot be DKIM-signed '
        'by you, so it is rejected or spam-filed — send from a domain you control.'
    ),
}


class Command(BaseCommand):
    help = 'Send a test email to prove the SMTP configuration works.'

    def add_arguments(self, parser):
        parser.add_argument(
            'recipient',
            help='Where to send the probe. Use an inbox you can actually read.',
        )
        parser.add_argument(
            '--show-config',
            action='store_true',
            help='Print the resolved EMAIL_* settings first (the password stays masked).',
        )

    def handle(self, *args, **options):
        if options['show_config']:
            self.print_config()

        recipient = options['recipient']
        self.stdout.write(f'Sending via {settings.EMAIL_HOST}:{settings.EMAIL_PORT} '
                          f'as {settings.DEFAULT_FROM_EMAIL} → {recipient}')

        try:
            sent = send_mail(
                subject='IMS test email',
                message=(
                    'If you are reading this, the IMS mail configuration works and '
                    'verification codes will send.'
                ),
                from_email=settings.DEFAULT_FROM_EMAIL,
                recipient_list=[recipient],
                # The entire point of this command is to see the exception.
                fail_silently=False,
            )
        except smtplib.SMTPException as exc:
            code = getattr(exc, 'smtp_code', None)
            self.stderr.write(self.style.ERROR(f'FAILED: {exc}'))
            hint = SMTP_HINTS.get(code)
            if hint:
                self.stderr.write(self.style.WARNING(f'\n  → {hint}\n'))
            raise CommandError('The mail server refused the message. See above.') from exc
        except Exception as exc:
            # Connection refused, DNS failure, timeout — not an SMTP-level rejection.
            self.stderr.write(self.style.ERROR(traceback.format_exc()))
            raise CommandError(f'Could not reach the mail server: {exc}') from exc

        if not sent:
            raise CommandError(
                'send_mail() reported 0 messages sent without raising. Check EMAIL_BACKEND — '
                'a console or locmem backend accepts everything and delivers nothing.'
            )
        self.stdout.write(self.style.SUCCESS(f'Sent. Check {recipient} (and its spam folder).'))

    def print_config(self):
        password = settings.EMAIL_HOST_PASSWORD or ''
        masked = f'{password[:6]}…{password[-4:]} ({len(password)} chars)' if password else '<empty>'
        for name in (
            'EMAIL_BACKEND', 'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USE_TLS', 'EMAIL_USE_SSL',
            'EMAIL_HOST_USER', 'DEFAULT_FROM_EMAIL', 'EMAIL_TIMEOUT',
        ):
            value = getattr(settings, name, '<unset>')
            self.stdout.write(f'  {name:20} = {value!r}  ({type(value).__name__})')
        self.stdout.write(f'  {"EMAIL_HOST_PASSWORD":20} = {masked}')

        # Silent-success trap: these two backends make a broken configuration look healthy.
        if 'smtp' not in settings.EMAIL_BACKEND:
            self.stdout.write(self.style.WARNING(
                f'  ! EMAIL_BACKEND is {settings.EMAIL_BACKEND} — nothing will actually be '
                f'delivered.'
            ))
        self.stdout.write('')

        try:
            get_connection()
        except Exception as exc:
            self.stderr.write(self.style.ERROR(f'  ! Backend would not construct: {exc}'))
