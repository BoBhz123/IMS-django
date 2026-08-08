from datetime import timedelta
from smtplib import SMTPException
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core import mail
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts import emails, verification
from accounts.models import Account, EmailVerification, Membership, get_account

from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from inventory.models import Category, Product


def make_account(**kwargs):
    # Defaults to an account that can actually reach the API. The model default is
    # pending_verification, which 403s every request — correct for production, useless as a
    # fixture default. Liveness tests pass subscription_status explicitly, so nothing here
    # masks the state machine.
    kwargs.setdefault('subscription_status', Account.ACTIVE)
    return Account.objects.create(name=kwargs.pop('name', 'Test Co'), **kwargs)


class SubscriptionLivenessTests(TestCase):
    """
    Liveness is computed from status AND expires_at. Nothing flips 'active' to 'past_due'
    without a scheduled job, so trusting the column alone silently grants free service.
    """

    def test_active_with_future_expiry_is_live(self):
        account = make_account(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() + timedelta(days=1),
        )
        self.assertTrue(account.has_active_subscription)

    def test_active_with_past_expiry_is_not_live(self):
        account = make_account(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() - timedelta(days=1),
        )
        self.assertFalse(account.has_active_subscription)

    def test_active_with_no_expiry_is_live(self):
        # A one-time lifetime licence. NULL means "never expires", not "already expired".
        account = make_account(subscription_status=Account.ACTIVE, expires_at=None)
        self.assertTrue(account.has_active_subscription)

    def test_canceled_is_never_live_even_with_future_expiry(self):
        account = make_account(
            subscription_status=Account.CANCELED,
            expires_at=timezone.now() + timedelta(days=30),
        )
        self.assertFalse(account.has_active_subscription)

    def test_past_due_is_not_live(self):
        account = make_account(subscription_status=Account.PAST_DUE)
        self.assertFalse(account.has_active_subscription)

    def test_pending_verification_is_not_live(self):
        # The whole wall rests on this: an un-onboarded account exists and is inert.
        account = make_account(subscription_status=Account.PENDING_VERIFICATION)
        self.assertFalse(account.has_active_subscription)

    def test_pending_payment_is_not_live_even_with_no_expiry(self):
        # expires_at=None must not read as "unlimited" for an account that never paid.
        account = make_account(
            subscription_status=Account.PENDING_PAYMENT, expires_at=None,
        )
        self.assertFalse(account.has_active_subscription)

    def test_new_accounts_default_to_pending_verification(self):
        account = Account.objects.create(name='Fresh')
        self.assertEqual(account.subscription_status, Account.PENDING_VERIFICATION)
        self.assertEqual(account.plan_type, '')


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


class SubscriptionEnforcementTests(TestCase):
    def build(self, **account_kwargs):
        account_kwargs.setdefault('subscription_status', Account.ACTIVE)
        account = Account.objects.create(name='Gated Co', **account_kwargs)
        user = User.objects.create_user(username=f'u{account.id}', password='pw12345!')
        Membership.objects.create(user=user, account=account, is_owner=True)
        category = Category.objects.create(name='Widgets', account=account)
        Product.objects.create(
            name='Widget', description='', cost_price='1.00', default_sell_price='2.00',
            category=category, stock_quantity=1, account=account,
        )
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        return account, client, header

    def test_active_account_may_use_the_api(self):
        _, client, header = self.build(subscription_status=Account.ACTIVE)
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)

    def test_pending_verification_account_is_blocked(self):
        _, client, header = self.build(subscription_status=Account.PENDING_VERIFICATION)
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 403)

    def test_pending_payment_account_is_blocked(self):
        # Verifying an email is not paying for anything.
        _, client, header = self.build(subscription_status=Account.PENDING_PAYMENT)
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 403)

    def test_expired_account_is_blocked(self):
        _, client, header = self.build(
            subscription_status=Account.ACTIVE,
            expires_at=timezone.now() - timedelta(days=1),
        )
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 403)

    def test_blocked_response_carries_a_machine_readable_code(self):
        # Flat, not nested under 'detail'. DRF's exception handler passes a dict `detail`
        # straight through as the response body instead of wrapping it, so the permission
        # class's dict `message` arrives as {'detail': ..., 'code': ...}. The frontend
        # interceptor reads body.code off this same shape.
        _, client, header = self.build(subscription_status=Account.CANCELED)
        body = client.get('/inventory/products/', HTTP_AUTHORIZATION=header).json()
        self.assertEqual(body['code'], 'subscription_expired')
        self.assertIn('subscription', body['detail'].lower())

    def test_anonymous_requests_are_rejected(self):
        self.assertEqual(APIClient().get('/inventory/products/').status_code, 401)

    def test_user_without_a_membership_gets_no_data(self):
        user = User.objects.create_user(username='orphan', password='pw12345!')
        client = APIClient()
        header = f'JWT {RefreshToken.for_user(user).access_token}'
        self.assertEqual(client.get('/inventory/products/', HTTP_AUTHORIZATION=header).status_code, 403)

    def test_subscriber_can_read_analytics_without_being_staff(self):
        _, client, header = self.build()
        response = client.get('/inventory/analytics/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)

    def test_subscriber_can_export_csv_without_being_staff(self):
        _, client, header = self.build()
        response = client.get('/inventory/orders/export/csv/', HTTP_AUTHORIZATION=header)
        self.assertEqual(response.status_code, 200)


class SignupProvisioningTests(TestCase):
    def signup(self, **payload):
        return APIClient().post('/auth/users/', {
            'username': payload.get('username', 'newbiz'),
            'password': payload.get('password', 'sTr0ng-pw-2026'),
            **({'business_name': payload['business_name']} if 'business_name' in payload else {}),
        }, format='json')

    def test_signup_creates_an_account_and_an_owner_membership(self):
        response = self.signup(business_name='Corner Shop')
        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username='newbiz')
        self.assertEqual(user.membership.account.name, 'Corner Shop')
        self.assertTrue(user.membership.is_owner)

    def test_account_name_defaults_to_the_username(self):
        self.signup()
        self.assertEqual(User.objects.get(username='newbiz').membership.account.name, 'newbiz')

    def test_a_fresh_signup_grants_no_access(self):
        # The payment wall's whole premise. Signup provisions an account that exists and is
        # inert; nothing about registering earns a single request.
        self.signup()
        account = User.objects.get(username='newbiz').membership.account
        self.assertEqual(account.subscription_status, Account.PENDING_VERIFICATION)
        self.assertEqual(account.plan_type, '')
        self.assertIsNone(account.expires_at)
        self.assertFalse(account.has_active_subscription)

    def test_new_users_are_never_staff(self):
        self.signup()
        user = User.objects.get(username='newbiz')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_a_new_signup_can_log_in_but_not_use_the_api(self):
        # Both halves matter. Login must work — otherwise the user cannot reach the verify
        # endpoint at all — while every business endpoint stays shut.
        self.signup()
        client = APIClient()
        login = client.post(
            '/auth/jwt/create/',
            {'username': 'newbiz', 'password': 'sTr0ng-pw-2026'}, format='json',
        )
        self.assertEqual(login.status_code, 200)
        token = login.json()['access']
        response = client.get('/inventory/products/', HTTP_AUTHORIZATION=f'JWT {token}')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['code'], 'subscription_expired')

    def test_createsuperuser_provisions_no_account(self):
        # Platform admins are not subscribers and must not own a workspace.
        admin = User.objects.create_superuser(username='platform', password='pw12345!')
        self.assertIsNone(get_account(admin))


def _shift_sends_back(user, seconds=120):
    """
    Moves a user's issued codes back in time so the next issue_code clears the 60-second
    cooldown without clearing the hourly cap. Faster and far less brittle than sleeping.
    """
    for row in EmailVerification.objects.filter(user=user):
        EmailVerification.objects.filter(pk=row.pk).update(
            created_at=row.created_at - timedelta(seconds=seconds),
        )


class VerificationCodeTests(TestCase):
    """
    A 6-digit code is 1,000,000 guesses — a few minutes of scripting. Expiry alone does not
    protect it; the attempt cap and the resend limits are the actual defence.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )

    def test_generated_codes_are_six_digits(self):
        for _ in range(50):
            code = verification.generate_code()
            self.assertEqual(len(code), 6)
            self.assertTrue(code.isdigit())

    def test_the_code_is_not_stored_in_plaintext(self):
        row, code = verification.issue_code(self.user)
        self.assertNotIn(code, row.code_hash)
        self.assertEqual(row.code_hash, verification.hash_code(code))
        self.assertEqual(len(row.code_hash), 64)

    def test_correct_code_verifies(self):
        _, code = verification.issue_code(self.user)
        self.assertEqual(verification.verify_code(self.user, code), verification.OK)

    def test_a_consumed_code_cannot_be_replayed(self):
        _, code = verification.issue_code(self.user)
        verification.verify_code(self.user, code)
        self.assertEqual(verification.verify_code(self.user, code), verification.NO_CODE)

    def test_wrong_code_is_rejected_and_counted(self):
        row, _ = verification.issue_code(self.user)
        self.assertEqual(verification.verify_code(self.user, '000000'), verification.INVALID)
        row.refresh_from_db()
        self.assertEqual(row.attempts, 1)

    def test_the_code_dies_after_five_wrong_attempts(self):
        _, code = verification.issue_code(self.user)
        for _ in range(verification.MAX_ATTEMPTS):
            verification.verify_code(self.user, '000000')
        # Even the *correct* code is refused now — this is what stops brute force.
        self.assertEqual(verification.verify_code(self.user, code), verification.LOCKED)

    def test_an_expired_code_is_rejected(self):
        row, code = verification.issue_code(self.user)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=['expires_at'])
        self.assertEqual(verification.verify_code(self.user, code), verification.EXPIRED)

    def test_verifying_with_no_outstanding_code(self):
        self.assertEqual(verification.verify_code(self.user, '123456'), verification.NO_CODE)

    def test_an_empty_submission_does_not_blow_up(self):
        verification.issue_code(self.user)
        self.assertEqual(verification.verify_code(self.user, None), verification.INVALID)
        self.assertEqual(verification.verify_code(self.user, ''), verification.INVALID)

    def test_reissuing_invalidates_the_previous_code(self):
        _, first = verification.issue_code(self.user)
        _shift_sends_back(self.user)
        _, second = verification.issue_code(self.user)
        self.assertEqual(verification.verify_code(self.user, first), verification.INVALID)
        self.assertEqual(verification.verify_code(self.user, second), verification.OK)

    def test_resend_is_rate_limited_to_one_a_minute(self):
        verification.issue_code(self.user)
        with self.assertRaises(verification.ResendThrottled) as caught:
            verification.issue_code(self.user)
        self.assertGreater(caught.exception.retry_after, 0)

    def test_resend_is_capped_per_hour(self):
        # An unthrottled resend endpoint is an email bomb aimed at a third party, and a bill.
        for _ in range(verification.MAX_SENDS_PER_HOUR):
            verification.issue_code(self.user)
            _shift_sends_back(self.user)
        with self.assertRaises(verification.ResendThrottled):
            verification.issue_code(self.user)

    def test_one_users_codes_do_not_affect_another(self):
        other = User.objects.create_user(
            username='other@example.com', email='other@example.com', password='pw12345!',
        )
        _, mine = verification.issue_code(self.user)
        _, theirs = verification.issue_code(other)
        self.assertEqual(verification.verify_code(other, mine), verification.INVALID)
        self.assertEqual(verification.verify_code(other, theirs), verification.OK)


@override_settings(
    EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
    DEFAULT_FROM_EMAIL='ims@example.com',
)
class VerificationEmailTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )
        mail.outbox = []

    def test_the_code_is_in_the_email(self):
        self.assertTrue(emails.send_verification_code(self.user, '123456'))
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.to, ['owner@example.com'])
        self.assertIn('123456', message.body)
        self.assertIn('10 minutes', message.body)

    def test_a_send_failure_is_reported_not_raised(self):
        # Signup must not die because a third party's SMTP is down — the user can resend.
        with patch('accounts.emails.send_mail', side_effect=SMTPException('boom')):
            self.assertFalse(emails.send_verification_code(self.user, '123456'))

    def test_no_email_address_is_not_an_error(self):
        self.user.email = ''
        self.user.save(update_fields=['email'])
        self.assertFalse(emails.send_verification_code(self.user, '123456'))
        self.assertEqual(len(mail.outbox), 0)
