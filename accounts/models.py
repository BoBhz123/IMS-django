from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class Account(models.Model):
    """
    A subscribing business. Replaces what used to be a Postgres schema under
    django-tenants: every row of business data belongs to exactly one Account.
    """

    TRIAL = 'trial'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    CANCELED = 'canceled'
    SUBSCRIPTION_STATUS_CHOICES = [
        (TRIAL, 'Trial'),
        (ACTIVE, 'Active'),
        (PAST_DUE, 'Past due'),
        (CANCELED, 'Canceled'),
    ]

    MONTHLY = 'monthly'
    ONE_TIME = 'one_time'
    FREE_TRIAL = 'free_trial'
    PLAN_TYPE_CHOICES = [
        (MONTHLY, 'Monthly'),
        (ONE_TIME, 'One time'),
        (FREE_TRIAL, 'Free trial'),
    ]

    # Statuses that represent a paying-or-trialling customer. past_due and canceled are
    # absent on purpose: both mean "stop serving".
    LIVE_STATUSES = (TRIAL, ACTIVE)

    name = models.CharField(max_length=255)
    subscription_status = models.CharField(
        max_length=20, choices=SUBSCRIPTION_STATUS_CHOICES, default=TRIAL, db_index=True,
    )
    plan_type = models.CharField(
        max_length=20, choices=PLAN_TYPE_CHOICES, default=FREE_TRIAL,
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name

    @property
    def has_active_subscription(self):
        """
        Computed, never read from subscription_status alone.

        No scheduled job flips 'active' to 'past_due' when expires_at passes, so the column
        goes stale the moment a subscription lapses. Deriving liveness here means the
        permission class, the admin, and any future billing webhook cannot disagree.
        """
        if self.subscription_status not in self.LIVE_STATUSES:
            return False
        return self.expires_at is None or self.expires_at > timezone.now()


class Membership(models.Model):
    """
    Links a user to their account.

    A OneToOneField today because one account has one login. It exists as its own model
    rather than an `owner` field on Account so that supporting staff logins later is a
    field swap (OneToOne -> ForeignKey) plus a data migration, not a restructuring of every
    scoped query in the app.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='membership')
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='memberships')
    is_owner = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f'{self.user.username} → {self.account.name}'


def get_account(user):
    """
    The account whose data this user may see, or None.

    None for anonymous users, for platform superadmins (who have no membership and are not
    scoped), and for any user whose provisioning failed. Callers must treat None as
    "no business data", never as "all business data".
    """
    if not user or not user.is_authenticated:
        return None
    membership = getattr(user, 'membership', None)
    return membership.account if membership else None
