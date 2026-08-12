import math

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
    TRIALING = 'trialing'
    ACTIVE = 'active'
    PAST_DUE = 'past_due'
    CANCELED = 'canceled'
    SUBSCRIPTION_STATUS_CHOICES = [
        (PENDING_VERIFICATION, 'Pending email verification'),
        (PENDING_PAYMENT, 'Pending payment'),
        (TRIALING, 'Free trial'),
        (ACTIVE, 'Active'),
        (PAST_DUE, 'Past due'),
        (CANCELED, 'Canceled'),
    ]

    MONTHLY = 'monthly'
    ANNUAL = 'annual'
    ONE_TIME = 'one_time'
    PLAN_TYPE_CHOICES = [
        (MONTHLY, 'Monthly subscription'),
        (ANNUAL, 'Annual subscription'),
        (ONE_TIME, 'One-time licence (lifetime)'),
    ]

    # How long a cardless trial runs. One place, because the signup serializer, the admin's
    # reset action, and the tests all have to agree on it.
    TRIAL_DAYS = 14

    # The statuses that can grant access. `trialing` is a deliberate reversal of the Phase
    # 2.5a decision to have no trial at all — the business chose cardless acquisition over a
    # hard wall. Note it is *can* grant, not *does*: liveness is still computed below, so a
    # trialing row whose trial_ends_at has passed is as locked out as a canceled one.
    LIVE_STATUSES = (ACTIVE, TRIALING)

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
    # Separate from expires_at on purpose. Collapsing both into one column would make a
    # lapsed trial indistinguishable from a lapsed paid subscription, and those are different
    # sales conversations — and reactivating a paid account would silently hand back a trial.
    trial_ends_at = models.DateTimeField(null=True, blank=True)
    # Latched on the first trial and never cleared by ordinary code, so one account gets one
    # free trial. A null trial_ends_at cannot stand in for this: activating a paid plan leaves
    # the old trial date behind, and clearing it (as the revoke action does) would otherwise
    # hand the account a fresh fortnight for free.
    has_used_trial = models.BooleanField(
        default=False,
        help_text='Set the first time a trial starts. Blocks a second free trial.',
    )

    # Set by the Paddle webhook so a renewal or cancellation can find its way back to the
    # right row. Blank for accounts activated by discount key, cash, or the admin.
    paddle_customer_id = models.CharField(max_length=64, blank=True, default='', db_index=True)
    paddle_subscription_id = models.CharField(
        max_length=64, blank=True, default='', db_index=True,
    )

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

        A trial reads its own clock: trial_ends_at, not expires_at. A trialing row with no
        trial_ends_at is not live — an unbounded free trial is the one failure mode a
        payment wall cannot survive, so the null case denies rather than allows.
        """
        if self.subscription_status not in self.LIVE_STATUSES:
            return False
        if self.subscription_status == self.TRIALING:
            return self.trial_ends_at is not None and self.trial_ends_at > timezone.now()
        return self.expires_at is None or self.expires_at > timezone.now()

    @property
    def is_trialing(self):
        return self.subscription_status == self.TRIALING and self.has_active_subscription

    @property
    def payment_method(self):
        """
        How this account is paying, as a coarse label for the UI.

        Inferred rather than stored: there is no payment_method column, and adding one would
        mean every activation path has to remember to set it. The Paddle ids are written only
        by the webhook, so their presence is a reliable signal that a card is on file;
        anything else that reached `active` got there by key, cash, Whish, or an admin, all
        of which are the same thing to the customer reading this — a manual activation.
        """
        if self.subscription_status == self.TRIALING:
            return 'trial'
        if self.paddle_customer_id or self.paddle_subscription_id:
            return 'card'
        if self.subscription_status == self.ACTIVE:
            return 'manual'
        return ''

    @property
    def trial_days_remaining(self):
        """
        Whole days left, rounded up, or None when there is no live trial.

        Rounded up so the last partial day reads as "1 day left" rather than "0" — a banner
        that says zero while the app still works reads as a bug to the person seeing it.
        """
        if not self.trial_ends_at:
            return None
        seconds = (self.trial_ends_at - timezone.now()).total_seconds()
        if seconds <= 0:
            return 0
        return math.ceil(seconds / 86400)


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


class UserPaymentRecord(models.Model):
    """
    An encrypted note of how somebody paid.

    **This is not a card vault and must never become one.** Paddle is the merchant of record;
    it holds the card and this app never sees a PAN. What lands here is the human detail a
    cash or Whish sale leaves behind — "Whish, ref 88213, paid at the shop" — which is
    ordinary business record-keeping that nonetheless names a customer and a transaction, and
    so is worth encrypting at rest. Storing a real card number here would put this app in PCI
    scope, which is the entire thing Paddle was chosen to avoid.

    Encryption is Fernet (AES-128-CBC + HMAC), so a database dump alone is useless without
    the key. Be clear about the threat model: the key lives in the application's environment,
    so anything that can run this code can decrypt. This defends against a leaked backup, a
    misconfigured replica, or a support user reading the table — not against a compromised
    server.
    """

    CASH = 'cash'
    WHISH = 'whish'
    OMT = 'omt'
    CARD = 'card'
    OTHER = 'other'
    METHOD_CHOICES = [
        (CASH, 'Cash'),
        (WHISH, 'Whish Money'),
        (OMT, 'OMT'),
        (CARD, 'Card (via Paddle)'),
        (OTHER, 'Other'),
    ]

    account = models.ForeignKey(
        Account, on_delete=models.CASCADE, related_name='payment_records',
    )
    user = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True,
        related_name='payment_records',
        help_text='Who recorded this, when it was entered by hand.',
    )
    # Deliberately in the clear: this is the column reporting groups by, and knowing a sale
    # was cash is not sensitive. The identifying detail goes in the encrypted field.
    method = models.CharField(max_length=16, choices=METHOD_CHOICES, default=CASH)
    amount_usd = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    # Ciphertext. Never read this directly — use the `details` property, which is the only
    # thing that knows the key.
    encrypted_details = models.BinaryField(blank=True, default=b'')

    reference = models.CharField(
        max_length=64, blank=True, default='',
        help_text='Non-sensitive lookup handle, e.g. a receipt number. Stored in the clear.',
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['account', '-created_at'], name='payrec_account_created_idx'),
        ]

    def __str__(self):
        return f'{self.get_method_display()} ${self.amount_usd} — {self.account.name}'

    @property
    def details(self):
        """
        The decrypted note, or a placeholder when the key cannot open it.

        Returns a marker rather than raising: a rotated or missing key must not make the
        admin changelist 500 for every row at once. The failure is visible in the value.
        """
        from .crypto import decrypt_text
        return decrypt_text(self.encrypted_details)

    @details.setter
    def details(self, value):
        from .crypto import encrypt_text
        self.encrypted_details = encrypt_text(value)


class ProcessedWebhookEvent(models.Model):
    """
    One row per gateway event we have already acted on.

    Paddle retries a notification until it gets a 2xx, and a retry that re-runs activation
    would extend expires_at a second time — the customer pays for one month and gets two.
    The unique event_id is what makes handling idempotent: the insert is attempted first and
    an IntegrityError means "already done", which is race-free in a way that
    check-then-insert is not.
    """

    event_id = models.CharField(max_length=128, unique=True)
    event_type = models.CharField(max_length=64)
    received_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-received_at']

    def __str__(self):
        return f'{self.event_type} ({self.event_id})'


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
