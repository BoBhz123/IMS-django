from django import forms
from django.contrib import admin, messages

from .billing.keys import generate_code, normalize_key
from .models import Account, DiscountKey, DiscountKeyRedemption, Membership


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 0
    autocomplete_fields = ['user']


@admin.action(description='Activate selected accounts (grants app access)')
def activate_accounts(modeladmin, request, queryset):
    """
    The manual activation path. Until Phase 2.5b adds checkout this is the *only* route from
    pending_payment to active, and it stays useful afterwards: a customer who pays cash or
    phones in gets activated here rather than through a gateway.
    """
    updated = queryset.update(subscription_status=Account.ACTIVE)
    messages.success(request, f'Activated {updated} account(s).')


@admin.register(Account)
class AccountAdmin(admin.ModelAdmin):
    list_display = [
        'name', 'phone', 'subscription_status', 'plan_type', 'expires_at', 'is_live', 'created_at',
    ]
    list_filter = ['subscription_status', 'plan_type']
    search_fields = ['name', 'phone']
    inlines = [MembershipInline]
    actions = [activate_accounts]

    @admin.display(boolean=True, description='Subscription live')
    def is_live(self, account):
        # Shows the computed answer, not the stored status — an 'active' row whose
        # expires_at has passed reads as not live here, which is what enforcement does.
        return account.has_active_subscription


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
class DiscountKeyAdmin(admin.ModelAdmin):
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
class DiscountKeyRedemptionAdmin(admin.ModelAdmin):
    """Read-only: this is the audit trail of who activated with what, not an editing surface."""

    list_display = ['key', 'account', 'redeemed_at']
    search_fields = ['key__code', 'account__name']
    readonly_fields = ['key', 'account', 'redeemed_at']

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
