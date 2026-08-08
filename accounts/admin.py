from django.contrib import admin, messages

from .models import Account, Membership


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
