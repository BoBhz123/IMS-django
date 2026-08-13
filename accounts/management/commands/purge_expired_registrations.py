"""
Delete unverified sign-ups whose session has closed.

**Housekeeping, not enforcement** — the same relationship the trial sweep has to
`has_active_subscription`. Nothing in this project runs on a schedule, so the endpoints an
unverified user can still reach (verify, resend) discard an expired registration themselves
the moment they are called. This command exists for the rows nobody ever comes back to,
which would otherwise sit in the table holding an email address hostage forever.

Safe to run repeatedly and safe to never run at all.
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts import registration


class Command(BaseCommand):
    help = 'Hard-delete unverified registrations whose sign-up session has expired.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='List what would be deleted without deleting anything.',
        )

    def handle(self, *args, **options):
        now = timezone.now()
        stale = list(registration.expired_registrations(now=now))

        if not stale:
            self.stdout.write('No expired registrations.')
            return

        deleted = 0
        for account in stale:
            age = now - account.registration_expires_at
            label = f'account {account.pk} ({account.name}) — expired {age} ago'
            if options['dry_run']:
                self.stdout.write(f'would discard: {label}')
                continue
            try:
                registration.discard(account, reason='purge_command')
            except registration.NotDiscardable as refused:
                # The queryset and the guard disagree, which should be impossible. Report it
                # rather than swallowing it: it means one of the two is wrong about what a
                # pending registration is, and deleting nothing is the safe side to err on.
                self.stderr.write(self.style.WARNING(f'skipped: {refused}'))
                continue
            deleted += 1
            self.stdout.write(f'discarded: {label}')

        if options['dry_run']:
            self.stdout.write(self.style.SUCCESS(f'{len(stale)} would be discarded.'))
        else:
            self.stdout.write(self.style.SUCCESS(f'Discarded {deleted} registration(s).'))
