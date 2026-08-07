from datetime import timedelta

from django.contrib.auth.models import User
from django.test import TestCase
from django.utils import timezone

from accounts.models import Account, Membership, get_account


def make_account(**kwargs):
    return Account.objects.create(name=kwargs.pop('name', 'Test Co'), **kwargs)


class SubscriptionLivenessTests(TestCase):
    """
    Liveness is computed from status AND expires_at. Nothing flips 'active' to 'past_due'
    without a scheduled job, so trusting the column alone silently grants free service.
    """

    def test_trial_with_future_expiry_is_active(self):
        account = make_account(
            subscription_status=Account.TRIAL,
            expires_at=timezone.now() + timedelta(days=1),
        )
        self.assertTrue(account.has_active_subscription)

    def test_active_with_past_expiry_is_not_active(self):
        account = make_account(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() - timedelta(days=1),
        )
        self.assertFalse(account.has_active_subscription)

    def test_active_with_no_expiry_is_active(self):
        account = make_account(subscription_status=Account.ACTIVE, expires_at=None)
        self.assertTrue(account.has_active_subscription)

    def test_canceled_is_never_active_even_with_future_expiry(self):
        account = make_account(
            subscription_status=Account.CANCELED,
            expires_at=timezone.now() + timedelta(days=30),
        )
        self.assertFalse(account.has_active_subscription)

    def test_past_due_is_not_active(self):
        account = make_account(subscription_status=Account.PAST_DUE)
        self.assertFalse(account.has_active_subscription)

    def test_new_accounts_default_to_trial(self):
        account = Account.objects.create(name='Fresh')
        self.assertEqual(account.subscription_status, Account.TRIAL)
        self.assertEqual(account.plan_type, Account.FREE_TRIAL)


class GetAccountTests(TestCase):
    def test_returns_the_members_account(self):
        account = make_account()
        user = User.objects.create_user(username='member', password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        self.assertEqual(get_account(user), account)

    def test_returns_none_for_a_user_with_no_membership(self):
        user = User.objects.create_user(username='loner', password='pw12345!')
        self.assertIsNone(get_account(user))

    def test_returns_none_for_anonymous(self):
        from django.contrib.auth.models import AnonymousUser
        self.assertIsNone(get_account(AnonymousUser()))
