"""
The security audit trail.

One logger, one line format, so the events worth reconstructing after an incident are
greppable together instead of scattered across Django's per-module loggers at whatever level
each happened to use.

**Logged to stdout on purpose.** Heroku captures stdout into its log stream, and Sentry's
logging integration forwards WARNING and above — so these reach both without this project
acquiring a log-shipping dependency or a database table it would then have to prune. The
trade-off is honest: this is an audit *trail*, not tamper-evident audit *storage*. Anyone
with dyno access can write to stdout. That is the right level for a single-operator business
tool, and the wrong level for anything with a compliance obligation.

Never log a credential, a token, or an OTP — the code, its hash, and the JWT are all absent
by design. Identifiers only.
"""

import logging

logger = logging.getLogger('ims.security')


def _actor(user):
    if user is None or not getattr(user, 'is_authenticated', False):
        return 'anonymous'
    return f'user={user.pk}'


def log_event(event, user=None, account=None, **fields):
    """
    One structured-ish line per security-relevant action.

    `event` is a stable slug so a grep for it keeps working when the message wording changes.
    """
    parts = [f'event={event}', _actor(user)]
    if account is not None:
        parts.append(f'account={getattr(account, "pk", account)}')
    parts.extend(f'{key}={value}' for key, value in sorted(fields.items()))
    logger.info(' '.join(parts))


def log_deletion(user, account, model_name, pk):
    """
    A business record was destroyed. The row itself is gone; this is what remains of it.

    Takes the name and pk rather than the instance, because the caller has to capture them
    before the delete — Django's collector sets `instance.pk = None` on the way out.
    """
    log_event('record_deleted', user=user, account=account, model=model_name, pk=pk)


def log_auth_event(event, user, **fields):
    """
    Authentication-state changes: password changed, email verified, sessions revoked.

    WARNING rather than INFO — these are the events someone reads back when an account is
    reported stolen, and the Sentry integration only forwards WARNING and above.
    """
    parts = [f'event={event}', _actor(user)]
    parts.extend(f'{key}={value}' for key, value in sorted(fields.items()))
    logger.warning(' '.join(parts))
