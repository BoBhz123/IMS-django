"""
Granting access.

Every route to an active subscription funnels through activate_account: discount-key
redemption today, Paddle's webhook in 2.5b-2. Expiry arithmetic that lives in one place
cannot disagree with itself, and "what made this account active" stays answerable.
"""

import calendar
from datetime import timedelta

from django.utils import timezone

from ..models import Account


def add_months(moment, months):
    """
    Calendar months, clamped to the last valid day of the target month.

    timedelta(days=30 * n) is the tempting shortcut and it is wrong: it drifts about five
    days a year against the date the customer thinks they bought. Rolling 31 January over
    into 3 March is the other wrong answer — it hands out days nobody paid for, and the
    error compounds on every renewal.
    """
    month_index = moment.month - 1 + months
    year = moment.year + month_index // 12
    month = month_index % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def activate_account(account, *, plan_type, months=None, grace_days=0):
    """
    Move an account to active and set its expiry. Saves and returns it.

    `months` extends from whichever is later, now or the current expires_at, so redeeming a
    key early adds to the time remaining instead of discarding it, while a lapsed account
    does not have its new month eaten by the period it spent expired.

    `grace_days` exists for the renewal webhook: a notification that arrives ten minutes
    late must not lock out a paying customer at midnight. Key redemption passes 0 — there
    is no third party to be late.

    Raises ValueError on an unusable combination. These are programming errors, not user
    input: callers validate the request before they get here.
    """
    if plan_type == Account.ONE_TIME:
        # A lifetime licence must clear any inherited expiry, or has_active_subscription
        # would still switch off on the old date.
        account.plan_type = Account.ONE_TIME
        account.expires_at = None
    elif plan_type == Account.MONTHLY:
        if not months or months < 1:
            raise ValueError('A monthly activation needs a positive number of months.')
        now = timezone.now()
        base = max(now, account.expires_at) if account.expires_at else now
        account.plan_type = Account.MONTHLY
        account.expires_at = add_months(base, months) + timedelta(days=grace_days)
    else:
        raise ValueError(f'Unknown plan type: {plan_type!r}')

    account.subscription_status = Account.ACTIVE
    account.save(update_fields=['subscription_status', 'plan_type', 'expires_at'])
    return account
