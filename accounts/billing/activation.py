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


# How many months each recurring plan buys. Derived per plan rather than passed by callers,
# so "annual" cannot mean twelve months at checkout and one month at renewal.
PLAN_MONTHS = {
    Account.MONTHLY: 1,
    Account.ANNUAL: 12,
}


class TrialAlreadyUsed(Exception):
    """This account has had its one free trial."""


def start_trial(account, *, days=None, save=True, force=False):
    """
    Put an account onto a cardless trial, starting now.

    Always restamps trial_ends_at from now rather than extending it: this is called when the
    trial *begins*, and extending an existing value would let a repeat caller stack trials.
    The admin's extend action is the deliberate exception and does its own arithmetic.

    One trial per account, latched on `has_used_trial`. Raises TrialAlreadyUsed on a second
    attempt rather than returning quietly — a caller that thinks it granted a trial and did
    not is worse than a loud failure, and every caller here is server-side code that knows
    whether it is re-onboarding or not.

    `force` is the superuser's override for the admin's reset action. It exists because
    support goodwill is a real requirement and the alternative is editing the column by hand,
    which is the same act with less of a record.
    """
    if account.has_used_trial and not force:
        raise TrialAlreadyUsed(
            f'Account {account.pk} has already used its free trial.'
        )

    days = Account.TRIAL_DAYS if days is None else days
    account.subscription_status = Account.TRIALING
    account.trial_ends_at = timezone.now() + timedelta(days=days)
    account.has_used_trial = True
    if save:
        account.save(
            update_fields=['subscription_status', 'trial_ends_at', 'has_used_trial'],
        )
    return account


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
    elif plan_type in PLAN_MONTHS:
        # Default to the plan's own period so callers cannot activate an annual plan for one
        # month by omitting the argument. months stays overridable for discount keys, which
        # grant an arbitrary number.
        months = PLAN_MONTHS[plan_type] if months is None else months
        if months < 1:
            raise ValueError('A recurring activation needs a positive number of months.')
        now = timezone.now()
        base = max(now, account.expires_at) if account.expires_at else now
        account.plan_type = plan_type
        account.expires_at = add_months(base, months) + timedelta(days=grace_days)
    else:
        raise ValueError(f'Unknown plan type: {plan_type!r}')

    account.subscription_status = Account.ACTIVE
    # trial_ends_at is deliberately left alone: it is the record of when this account's trial
    # ran, and clearing it would erase that. Liveness reads expires_at once status is active,
    # so a stale trial date cannot grant or deny anything.
    account.save(update_fields=['subscription_status', 'plan_type', 'expires_at'])
    return account
