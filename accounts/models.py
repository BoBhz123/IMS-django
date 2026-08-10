from django.contrib.auth.models import User
from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.utils import timezone


class Account(models.Model):
    """
    A subscribing business. Replaces what used to be a Postgres schema under
    django-tenants: every row of business data belongs to exactly one Account.
    """

    PENDING_VERIFICATION = 'pending_verification'
    PENDING_PAYMENT = 'pending_payment'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    CANCELED = 'canceled'
    SUBSCRIPTION_STATUS_CHOICES = [
        (PENDING_VERIFICATION, 'Pending email verification'),
        (PENDING_PAYMENT, 'Pending payment'),
        (ACTIVE, 'Active'),
        (PAST_DUE, 'Past due'),
        (CANCELED, 'Canceled'),
    ]

    MONTHLY = 'monthly'
    ONE_TIME = 'one_time'
    PLAN_TYPE_CHOICES = [
        (MONTHLY, 'Monthly subscription'),
        (ONE_TIME, 'One-time licence (lifetime)'),
    ]

    # The only status that grants access. There is deliberately no trial status: a trial is
    # by definition a free bypass of the payment wall. The pending_* states mean "signed up
    # but not onboarded"; past_due and canceled mean "stop serving".
    LIVE_STATUSES = (ACTIVE,)

    name = models.CharField(max_length=255)
    phone = models.CharField(
        max_length=32,
        blank=True,
        validators=[RegexValidator(
            r'^\+?[\d\s\-()]{6,32}$',
            'Enter a phone number — digits, spaces, dashes and an optional leading +.',
        )],
    )
    subscription_status = models.CharField(
        max_length=32,
        choices=SUBSCRIPTION_STATUS_CHOICES,
        default=PENDING_VERIFICATION,
        db_index=True,
    )
    # Blank until a plan is chosen at checkout. Kept out of the wall's logic entirely —
    # subscription_status decides access, plan_type only records what was bought.
    plan_type = models.CharField(
        max_length=20, choices=PLAN_TYPE_CHOICES, blank=True, default='',
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


class EmailVerification(models.Model):
    """
    One issued code. A row per send rather than one overwritten row: the hourly send cap and
    any later abuse investigation both need something to count.

    The code is stored as an HMAC, not plaintext — but be clear about what that buys. Any
    hash of a six-digit space falls instantly to an offline attacker, so hashing only keeps
    the code out of logs, backups and the admin, and makes a database-only leak useless
    without SECRET_KEY. The real defence is `attempts` plus `expires_at`.
    """

    EMAIL_VERIFICATION = 'email_verification'
    PASSWORD_RESET = 'password_reset'
    PURPOSE_CHOICES = [
        (EMAIL_VERIFICATION, 'Email verification'),
        (PASSWORD_RESET, 'Password reset'),
    ]

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name='email_verifications',
    )
    # What the code was issued for. Every query in accounts.verification filters on it, so a
    # signup code cannot be replayed at the password-reset endpoint, requesting a reset does
    # not expire an outstanding signup code, and the two flows do not share one hourly send
    # budget. Defaulting to EMAIL_VERIFICATION is what makes the backfill correct: every row
    # predating this field was issued by the signup flow.
    purpose = models.CharField(
        max_length=32, choices=PURPOSE_CHOICES, default=EMAIL_VERIFICATION, db_index=True,
    )
    code_hash = models.CharField(max_length=64)
    attempts = models.PositiveSmallIntegerField(default=0)
    # default=timezone.now, not auto_now_add: auto_now_add ignores assignment, which would
    # make the resend rate limits untestable without real sleeping.
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', '-created_at'], name='emailverif_user_created_idx'),
            models.Index(
                fields=['user', 'purpose', '-created_at'],
                name='emailverif_user_purpose_idx',
            ),
        ]

    def __str__(self):
        return (
            f'{self.get_purpose_display().lower()} code for {self.user.username} '
            f'({self.created_at:%Y-%m-%d %H:%M})'
        )


class DiscountKey(models.Model):
    """
    A prepaid activation code, issued by us rather than by the payment gateway.

    Deliberately not a gateway coupon. A coupon still requires the customer to complete a
    checkout round trip, and the requirement here is to bypass card checkout entirely for a
    customer who paid cash, Whish, or OMT. Local keys also record the sale where Phase 3's
    reporting can see it, and keep working if the gateway is down or never approved.
    """

    MONTHS = 'months'
    LIFETIME = 'lifetime'
    GRANT_CHOICES = [
        (MONTHS, 'A number of months'),
        (LIFETIME, 'Lifetime licence'),
    ]

    code = models.CharField(max_length=32, unique=True, db_index=True)
    # v1 honours 100 only; anything less needs a second gateway integration to charge the
    # remainder. The column exists so partial support is additive rather than a migration.
    percent_off = models.PositiveSmallIntegerField(default=100)
    grants = models.CharField(max_length=16, choices=GRANT_CHOICES, default=LIFETIME)
    grant_months = models.PositiveSmallIntegerField(
        null=True, blank=True, help_text='Required when the key grants months.',
    )
    max_redemptions = models.PositiveIntegerField(default=1)
    redemption_count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True, help_text='Kill switch.')

    # What was actually collected, and how. Without this a key is an unexplained free
    # activation, and there is no way to reconcile keys against cash a year later.
    amount_paid_usd = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    note = models.CharField(max_length=255, blank=True)

    created_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='discount_keys_created',
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return self.formatted_code

    @property
    def formatted_code(self):
        from .billing.keys import format_key
        return format_key(self.code)

    def clean(self):
        if self.grants == self.MONTHS and not self.grant_months:
            raise ValidationError(
                {'grant_months': 'A key that grants months needs a number of months.'}
            )

    def is_redeemable(self, now=None):
        """
        Whether the key may still be used. Read-only — the redeem endpoint re-checks this
        under a row lock, because two concurrent posts can both see the same True here.
        """
        now = now or timezone.now()
        if not self.is_active:
            return False
        if self.expires_at and self.expires_at <= now:
            return False
        return self.redemption_count < self.max_redemptions


class DiscountKeyRedemption(models.Model):
    """One account's use of one key. The unique constraint blocks double-dipping."""

    key = models.ForeignKey(
        DiscountKey, on_delete=models.CASCADE, related_name='redemptions',
    )
    account = models.ForeignKey(
        Account, on_delete=models.CASCADE, related_name='key_redemptions',
    )
    redeemed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-redeemed_at']
        constraints = [
            models.UniqueConstraint(
                fields=['key', 'account'], name='uniq_discount_key_per_account',
            ),
        ]

    def __str__(self):
        return f'{self.key.formatted_code} → {self.account.name}'
