from datetime import timedelta

from django import forms
from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin
from django.contrib.auth.forms import AdminPasswordChangeForm
from django.contrib.auth.models import User
from django.utils import timezone
from django.utils.html import format_html

from .billing.activation import activate_account, start_trial
from .billing.keys import generate_code, normalize_key
from .billing.webhooks import trial_expiry_sweep
from .crypto import UNREADABLE
from .models import (
    Account, DiscountKey, DiscountKeyRedemption, Membership, ProcessedWebhookEvent,
    UserPaymentRecord,
)


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0
    autocomplete_fields = ['user']


class SuperuserOnlyAdmin(admin.ModelAdmin):
    """
    Hides a model from everyone but platform superadmins.

    `has_module_permission` is the one that keeps it off the admin index; without it the
    section still renders and only the links 404, which looks like a bug rather than a
    boundary. All five are overridden because Django checks them independently — granting a
    staff user the model permission through a group would otherwise be enough to reach these,
    and issuing free subscriptions is not a delegable job.
    """

    def has_module_permission(self, request):
        return bool(request.user and request.user.is_superuser)

    def has_view_permission(self, request, obj=None):
        return bool(request.user and request.user.is_superuser)

    def has_add_permission(self, request):
        return bool(request.user and request.user.is_superuser)

    def has_change_permission(self, request, obj=None):
        return bool(request.user and request.user.is_superuser)

    def has_delete_permission(self, request, obj=None):
        return bool(request.user and request.user.is_superuser)


def status_badge(label, tone):
    """
    A coloured pill. Inline styles rather than a CSS file because the admin has no build step
    and a stylesheet would be one more thing to keep in sync with the light/dark admin themes.
    """
    tones = {
        'green': ('#137333', '#e6f4ea'),
        'amber': ('#8a6100', '#fef7e0'),
        'red': ('#a50e0e', '#fce8e6'),
        'grey': ('#3c4043', '#e8eaed'),
        'blue': ('#174ea6', '#e8f0fe'),
    }
    colour, background = tones.get(tone, tones['grey'])
    return format_html(
        '<span style="display:inline-block;padding:2px 8px;border-radius:10px;'
        'font-size:11px;font-weight:600;white-space:nowrap;color:{};background:{};">{}</span>',
        colour, background, label,
    )


# Which colour each stored status gets. Note `trialing` is amber, not green: the account is
# live but on borrowed time, and that distinction is the whole point of scanning this column.
STATUS_TONES = {
    Account.ACTIVE: 'green',
    Account.TRIALING: 'amber',
    Account.PENDING_VERIFICATION: 'grey',
    Account.PENDING_PAYMENT: 'grey',
    Account.PAST_DUE: 'red',
    Account.CANCELED: 'red',
}


@admin.action(description='Activate — 1 month (cash / Whish)')
def activate_monthly(modeladmin, request, queryset):
    _bulk_activate(request, queryset, Account.MONTHLY, months=1)


@admin.action(description='Activate — 1 year (cash / Whish)')
def activate_annual(modeladmin, request, queryset):
    _bulk_activate(request, queryset, Account.ANNUAL, months=12)


@admin.action(description='Activate — lifetime licence (cash / Whish)')
def activate_lifetime(modeladmin, request, queryset):
    _bulk_activate(request, queryset, Account.ONE_TIME)


def _bulk_activate(request, queryset, plan_type, months=None):
    """
    Runs each account through activate_account rather than queryset.update().

    A bulk update would set the status column and leave expires_at untouched, producing an
    account that reads 'active' but whose computed liveness is still False — the exact stale
    -column failure has_active_subscription exists to prevent. Slower, and correct.
    """
    count = 0
    for account in queryset:
        activate_account(account, plan_type=plan_type, months=months)
        count += 1
    messages.success(
        request, f'Activated {count} account(s) on the {plan_type} plan.',
    )


@admin.action(description='Activate selected accounts (grants app access)')
def activate_accounts(modeladmin, request, queryset):
    """
    Kept under its old name because it is referenced in HISTORY.md and the docs as *the*
    manual activation path. Now delegates to the monthly action rather than writing the
    status column directly, which is what it used to do — and which left expires_at unset.
    """
    _bulk_activate(request, queryset, Account.MONTHLY, months=1)


@admin.action(description='Extend trial by 14 days')
def extend_trial(modeladmin, request, queryset):
    """
    Adds to whatever is left, from the later of now and the current end date — extending an
    already-expired trial from its old date would grant nothing.
    """
    now = timezone.now()
    count = 0
    for account in queryset:
        base = max(now, account.trial_ends_at) if account.trial_ends_at else now
        account.trial_ends_at = base + timedelta(days=Account.TRIAL_DAYS)
        account.subscription_status = Account.TRIALING
        # Latched here too: this path sets TRIALING without going through start_trial, and a
        # trial that does not mark itself used is a trial that can be had twice.
        account.has_used_trial = True
        account.save(
            update_fields=['trial_ends_at', 'subscription_status', 'has_used_trial'],
        )
        count += 1
    messages.success(request, f'Extended the trial on {count} account(s).')


@admin.action(description='Reset trial to a fresh 14 days (overrides one-trial policy)')
def reset_trial(modeladmin, request, queryset):
    """
    Restarts the clock from now, discarding whatever was left. For support goodwill.

    Passes force=True: this is the one sanctioned way past `has_used_trial`, and it is
    superuser-only. The alternative is an admin editing the column by hand, which is the same
    act with less of a record.
    """
    count = 0
    for account in queryset:
        start_trial(account, force=True)
        count += 1
    messages.warning(
        request,
        f'Reset the trial on {count} account(s) — this overrode the one-trial-per-account '
        f'policy.',
    )


@admin.action(description='Revoke subscription (locks the account out immediately)')
def revoke_subscription(modeladmin, request, queryset):
    """
    Immediate, not end-of-period. This is the lever for a chargeback or a cash sale that
    fell through, where continuing to serve is the thing being prevented — so it clears both
    clocks rather than letting a leftover expires_at or trial_ends_at keep access alive.
    """
    updated = queryset.update(
        subscription_status=Account.CANCELED, expires_at=None, trial_ends_at=None,
    )
    messages.success(request, f'Revoked {updated} subscription(s).')


@admin.action(description='Sweep elapsed trials to pending payment')
def sweep_elapsed_trials(modeladmin, request, queryset):
    """
    Housekeeping, not enforcement — an elapsed trial is already locked out by the computed
    liveness check. This only corrects the stored column so the list filter tells the truth.
    """
    swept = trial_expiry_sweep()
    messages.success(request, f'Moved {swept} elapsed trial(s) to pending payment.')


# Everything that hands out or takes away paid access.
#
# The callables go in `actions` — a string there is only resolved against methods on the
# ModelAdmin, and these are module-level functions, so naming them would silently register
# nothing. The names are derived back off __name__ for the gating in get_actions, which is
# keyed by name; deriving rather than retyping keeps the two from drifting apart.
SUBSCRIPTION_ACTION_FUNCS = [
    activate_monthly, activate_annual, activate_lifetime, activate_accounts,
    extend_trial, reset_trial, revoke_subscription, sweep_elapsed_trials,
]
SUBSCRIPTION_ACTIONS = [func.__name__ for func in SUBSCRIPTION_ACTION_FUNCS]
SUBSCRIPTION_FIELDS = [
    'subscription_status', 'plan_type', 'expires_at', 'trial_ends_at',
    'paddle_customer_id', 'paddle_subscription_id',
]


@admin.register(Account)
class AccountAdmin(admin.ModelAdmin):
    """
    Visible to staff, but only a superuser may change what an account has paid for.

    Not `SuperuserOnlyAdmin`: an account's name and phone are ordinary support data, and
    hiding the model entirely would leave a support user unable to look a customer up. The
    subscription columns are the privileged part, so those go read-only and every activation
    action disappears for anyone who is not a platform superadmin.
    """

    list_display = [
        'name', 'phone', 'status_badge', 'plan_badge', 'live_badge', 'expires_at',
        'trial_ends_at', 'has_used_trial', 'created_at',
    ]
    list_filter = ['subscription_status', 'plan_type', 'has_used_trial']
    search_fields = ['name', 'phone', 'paddle_customer_id', 'paddle_subscription_id']
    inlines = [MembershipInline]
    actions = SUBSCRIPTION_ACTION_FUNCS
    # Read-only for everyone, superusers included. This is a latch, not a setting: the only
    # sanctioned way to give an account a second trial is the reset action, which forces it
    # deliberately and says so in the message. A hand-editable checkbox is the same power
    # with none of that signal.
    # Both read-only for everyone, superusers included, and for the same reason: they are
    # latches rather than settings. `registration_expires_at` decides whether an unverified
    # row may be hard-deleted, so hand-editing it is either extending a sign-up session
    # arbitrarily or arming a delete on a row that should keep its address.
    readonly_fields = ['has_used_trial', 'registration_expires_at']
    fieldsets = [
        (None, {'fields': ['name', 'phone']}),
        ('Subscription', {
            'fields': [
                'subscription_status', 'plan_type', 'expires_at', 'trial_ends_at',
                'has_used_trial', 'registration_expires_at',
            ],
            'description': (
                'expires_at and trial_ends_at are directly editable by superusers so a cash '
                'or Whish sale can be dated by hand. Access is computed from these two '
                'columns plus the status — setting the status to active without an expiry '
                'grants unlimited access, which is what the lifetime plan is for. '
                'registration_expires_at is set only for a sign-up that has never been '
                'verified: once it passes, that account and its user are hard-deleted so '
                'the email address is free to sign up again. It is cleared for good the '
                'first time the address is verified.'
            ),
        }),
        ('Paddle', {
            'fields': ['paddle_customer_id', 'paddle_subscription_id'],
            'classes': ['collapse'],
            'description': 'Written by the webhook. Blank for cash, Whish, and key sales.',
        }),
    ]

    # --- superuser gating ---------------------------------------------------------------

    def get_actions(self, request):
        actions = super().get_actions(request)
        if not request.user.is_superuser:
            for name in SUBSCRIPTION_ACTIONS:
                actions.pop(name, None)
        return actions

    def get_readonly_fields(self, request, obj=None):
        readonly = list(super().get_readonly_fields(request, obj))
        if not request.user.is_superuser:
            # Read-only rather than removed from the fieldset: a support user should still be
            # able to *see* why a customer is locked out, just not change it.
            readonly.extend(field for field in SUBSCRIPTION_FIELDS if field not in readonly)
        return readonly

    # --- badges ---------------------------------------------------------------------------

    @admin.display(description='Status', ordering='subscription_status')
    def status_badge(self, account):
        return status_badge(
            account.get_subscription_status_display(),
            STATUS_TONES.get(account.subscription_status, 'grey'),
        )

    @admin.display(description='Plan', ordering='plan_type')
    def plan_badge(self, account):
        if not account.plan_type:
            return status_badge('No plan', 'grey')
        tone = 'blue' if account.plan_type == Account.ONE_TIME else 'grey'
        return status_badge(account.get_plan_type_display(), tone)

    @admin.display(description='Live')
    def live_badge(self, account):
        # The computed answer, not the stored status. An 'active' row whose expires_at has
        # passed reads as not live here, which is exactly what enforcement does — this column
        # exists so that disagreement is visible at a glance instead of via a support ticket.
        live = account.has_active_subscription
        return status_badge('Yes' if live else 'No', 'green' if live else 'red')


@admin.register(ProcessedWebhookEvent)
class ProcessedWebhookEventAdmin(SuperuserOnlyAdmin):
    """
    Read-only. This table is the idempotency ledger: deleting a row lets Paddle's next retry
    re-activate an account and double-extend its expiry, so it is not an editing surface.
    """

    list_display = ['event_id', 'event_type', 'received_at']
    list_filter = ['event_type']
    search_fields = ['event_id', 'event_type']
    readonly_fields = ['event_id', 'event_type', 'received_at']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ['user', 'account', 'is_owner', 'created_at']
    list_filter = ['is_owner']
    search_fields = ['user__username', 'account__name']
    autocomplete_fields = ['user', 'account']


@admin.action(description='Deactivate selected keys')
def deactivate_keys(modeladmin, request, queryset):
    """The kill switch — for a key that leaked, or a cash sale that fell through."""
    updated = queryset.update(is_active=False)
    messages.success(request, f'Deactivated {updated} key(s).')


class DiscountKeyForm(forms.ModelForm):
    """
    Makes `code` optional *in the admin only* — leaving it blank generates one.

    The generation happens in clean_code rather than save_model because ModelForm runs the
    model's own full_clean() in between, and that rejects a blank code. The model field
    stays required so no other code path can create a key without one.
    """

    class Meta:
        model = DiscountKey
        fields = '__all__'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['code'].required = False
        self.fields['code'].help_text = 'Leave blank to generate a key automatically.'

    def clean_code(self):
        return normalize_key(self.cleaned_data.get('code')) or generate_code()


@admin.register(DiscountKey)
class DiscountKeyAdmin(SuperuserOnlyAdmin):
    """Superuser-only: a key is a free subscription, and issuing one is not delegable."""

    form = DiscountKeyForm
    list_display = [
        'formatted_code', 'grants', 'grant_months', 'percent_off', 'redemption_count',
        'max_redemptions', 'is_active', 'redeemable', 'amount_paid_usd', 'created_at',
    ]
    list_filter = ['is_active', 'grants', 'percent_off']
    search_fields = ['code', 'note']
    readonly_fields = ['redemption_count', 'created_by', 'formatted_code']
    actions = [deactivate_keys]

    @admin.display(boolean=True, description='Redeemable now')
    def redeemable(self, key):
        # The computed answer, matching what the endpoint enforces — an active key that has
        # expired or run out reads as not redeemable here too.
        return key.is_redeemable()

    def save_model(self, request, obj, form, change):
        # Records who issued the key. On the redemption side this is the only trace of
        # which admin authorised a free activation.
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(DiscountKeyRedemption)
class DiscountKeyRedemptionAdmin(SuperuserOnlyAdmin):
    """
    Superuser-only, and read-only even for them: this is the audit trail of who activated
    with what. An audit trail that its own users can edit is not one.
    """

    list_display = ['key', 'account', 'redeemed_at']
    search_fields = ['key__code', 'account__name']
    readonly_fields = ['key', 'account', 'redeemed_at']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


class UserPaymentRecordForm(forms.ModelForm):
    """
    Exposes the encrypted note as an ordinary textarea.

    `encrypted_details` is a BinaryField; without this the admin would render raw ciphertext
    in a text box and save whatever was typed straight into the column unencrypted, which is
    exactly the failure the model exists to prevent.
    """

    details = forms.CharField(
        widget=forms.Textarea(attrs={'rows': 3}),
        required=False,
        label='Details (encrypted at rest)',
        help_text=(
            'Free text — how the customer paid, a Whish reference, who took the cash. '
            'Never a card number: Paddle is the merchant of record and this app is '
            'deliberately outside PCI scope.'
        ),
    )

    class Meta:
        model = UserPaymentRecord
        fields = ['account', 'user', 'method', 'amount_usd', 'reference', 'details']

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.instance and self.instance.pk:
            self.fields['details'].initial = self.instance.details

    def save(self, commit=True):
        record = super().save(commit=False)
        record.details = self.cleaned_data.get('details', '')
        if commit:
            record.save()
        return record


@admin.register(UserPaymentRecord)
class UserPaymentRecordAdmin(SuperuserOnlyAdmin):
    """
    Superuser-only, because reading this table is reading customers' payment history.

    The changelist deliberately shows a *masked* preview rather than the decrypted note: a
    list view is the thing left open on a shared screen, and there is no reason to decrypt
    fifty rows to answer "did this account pay?". The full text is on the change form, one
    deliberate click away.
    """

    form = UserPaymentRecordForm
    list_display = ['created_at', 'account', 'method', 'amount_usd', 'reference', 'masked']
    list_filter = ['method', 'created_at']
    search_fields = ['account__name', 'reference']
    autocomplete_fields = ['account', 'user']
    readonly_fields = ['created_at']

    @admin.display(description='Details')
    def masked(self, record):
        """A length hint, not the content. Enough to see a row is populated."""
        text = record.details
        if not text:
            return '—'
        if text == UNREADABLE:
            return status_badge('Unreadable', 'red')
        return status_badge(f'Encrypted · {len(text)} chars', 'blue')

    def save_model(self, request, obj, form, change):
        # Who filed the record, when it was entered by hand rather than by a webhook.
        if not change and obj.user_id is None:
            obj.user = request.user
        super().save_model(request, obj, form, change)


# --- User administration -----------------------------------------------------------------
# Django's own UserAdmin already ships the password-change form; it is re-registered here so
# that (a) the capability is explicit and cannot be lost to a stray unregister, and (b) the
# account a user belongs to is visible from the user page, which is where support starts.
admin.site.unregister(User)


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    # The dedicated set-password form, reached from the link on the change page. Named
    # explicitly rather than inherited so it survives a future refactor of this class.
    change_password_form = AdminPasswordChangeForm

    inlines = [MembershipInline]
    list_display = [
        'username', 'email', 'account_name', 'is_active', 'is_staff', 'is_superuser',
        'last_login',
    ]
    # search_fields is load-bearing, not cosmetic: MembershipAdmin and UserPaymentRecordAdmin
    # both use autocomplete_fields against User, and autocomplete 500s without it.
    search_fields = ['username', 'email', 'first_name', 'last_name']

    @admin.display(description='Account', ordering='membership__account__name')
    def account_name(self, user):
        membership = getattr(user, 'membership', None)
        return membership.account.name if membership else '—'

    def has_change_permission(self, request, obj=None):
        # A staff user must not be able to set another user's password — that is a full
        # account takeover, and it is the whole reason this class is spelled out.
        if obj is not None and not request.user.is_superuser:
            return False
        return super().has_change_permission(request, obj)
