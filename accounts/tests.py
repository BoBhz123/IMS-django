from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from smtplib import SMTPException
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core import mail
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import IntegrityError, transaction
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from accounts import emails, verification
from accounts.billing import get_provider
from accounts.billing.activation import activate_account, add_months
from accounts.billing.base import PLAN_KEYS, ProviderUnavailable, UnknownPlan
from accounts.billing.keys import (
    ALPHABET, KEY_LENGTH, format_key, generate_code, normalize_key,
)
from accounts.models import (
    Account, DiscountKey, DiscountKeyRedemption, EmailVerification, Membership, get_account,
)

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


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class RegistrationTests(TestCase):
    URL = '/auth/users/'
    PAYLOAD = {
        'email': 'Owner@Example.com',
        'password': 'sTr0ng-pw-2026',
        'phone': '+961 70 123 456',
        'business_name': 'Corner Shop',
    }

    def setUp(self):
        self.client = APIClient()
        mail.outbox = []

    def post(self, **overrides):
        # The verification email is sent from transaction.on_commit, and TestCase wraps each
        # test in a transaction it never commits — so without capturing them the callbacks
        # silently never run and the email assertions test nothing.
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(self.URL, {**self.PAYLOAD, **overrides}, format='json')

    def test_registration_provisions_user_account_and_membership(self):
        response = self.post()
        self.assertEqual(response.status_code, 201, response.data)
        user = User.objects.get(email__iexact='owner@example.com')
        # username is derived from the email, lowercased. AUTH_USER_MODEL was not swapped, so
        # username remains the column simplejwt authenticates against.
        self.assertEqual(user.username, 'owner@example.com')
        self.assertEqual(user.email, 'owner@example.com')
        account = user.membership.account
        self.assertEqual(account.name, 'Corner Shop')
        self.assertEqual(account.phone, '+961 70 123 456')
        self.assertTrue(user.membership.is_owner)

    def test_a_fresh_signup_grants_no_access(self):
        # The payment wall's whole premise. Registering earns exactly nothing.
        self.post()
        account = Account.objects.get(memberships__user__email__iexact='owner@example.com')
        self.assertEqual(account.subscription_status, Account.PENDING_VERIFICATION)
        self.assertEqual(account.plan_type, '')
        self.assertIsNone(account.expires_at)
        self.assertFalse(account.has_active_subscription)

    def test_registration_emails_a_code(self):
        self.post()
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ['owner@example.com'])
        self.assertEqual(EmailVerification.objects.count(), 1)

    def test_the_new_user_can_log_in_but_not_use_the_api(self):
        # Login must work or they could never reach the verify endpoint; everything else stays
        # shut until payment.
        self.post()
        login = self.client.post(
            '/auth/jwt/create/',
            {'username': 'owner@example.com', 'password': self.PAYLOAD['password']},
            format='json',
        )
        self.assertEqual(login.status_code, 200, login.data)
        token = login.json()['access']
        blocked = self.client.get('/inventory/products/', HTTP_AUTHORIZATION=f'JWT {token}')
        self.assertEqual(blocked.status_code, 403)
        self.assertEqual(blocked.json()['code'], 'subscription_expired')

    def test_email_is_required(self):
        response = self.post(email='')
        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.data)

    def test_phone_is_required(self):
        response = self.post(phone='')
        self.assertEqual(response.status_code, 400)
        self.assertIn('phone', response.data)

    def test_a_junk_phone_is_rejected(self):
        response = self.post(phone='call me')
        self.assertEqual(response.status_code, 400)
        self.assertIn('phone', response.data)

    def test_a_duplicate_email_is_rejected_case_insensitively(self):
        self.post()
        response = self.post(email='OWNER@example.com')
        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.data)
        self.assertEqual(User.objects.filter(email__iexact='owner@example.com').count(), 1)

    def test_the_database_enforces_email_uniqueness_too(self):
        # The serializer's check is racy — two concurrent posts can both pass it. This proves
        # the case-insensitive index behind it exists and is doing the real work.
        User.objects.create_user(
            username='a@example.com', email='a@example.com', password='pw12345!',
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            User.objects.create_user(
                username='b@example.com', email='A@Example.com', password='pw12345!',
            )

    def test_blank_emails_do_not_collide(self):
        # The index is partial for exactly this reason: superusers made without an address
        # would otherwise all collide on the empty string.
        User.objects.create_user(username='one', email='', password='pw12345!')
        User.objects.create_user(username='two', email='', password='pw12345!')
        self.assertEqual(User.objects.filter(email='').count(), 2)

    def test_a_weak_password_is_rejected(self):
        response = self.post(password='pw')
        self.assertEqual(response.status_code, 400)
        self.assertIn('password', response.data)

    def test_business_name_falls_back_to_the_email(self):
        self.post(business_name='')
        account = Account.objects.get(memberships__user__email__iexact='owner@example.com')
        self.assertEqual(account.name, 'owner@example.com')

    def test_a_failed_email_send_still_produces_a_usable_account(self):
        with patch('accounts.serializers.send_verification_code', return_value=False):
            response = self.post()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertTrue(User.objects.filter(email__iexact='owner@example.com').exists())

    def test_new_users_are_never_staff(self):
        self.post()
        user = User.objects.get(email__iexact='owner@example.com')
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

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


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class OnboardingEndpointTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )
        self.account = Account.objects.create(
            name='Corner Shop', subscription_status=Account.PENDING_VERIFICATION,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(self.user).access_token}',
        )
        mail.outbox = []

    # --- the escape hatches must not sit behind the wall they exist to open ---

    def test_status_endpoint_is_reachable_while_pending(self):
        response = self.client.get('/accounts/subscription/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['status'], Account.PENDING_VERIFICATION)
        self.assertFalse(response.data['has_active_subscription'])
        self.assertEqual(response.data['business_name'], 'Corner Shop')
        self.assertEqual(response.data['email'], 'owner@example.com')

    def test_verify_endpoint_is_reachable_while_pending(self):
        _, code = verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(response.status_code, 200, response.data)

    def test_resend_endpoint_is_reachable_while_pending(self):
        response = self.client.post('/accounts/resend-code/')
        self.assertEqual(response.status_code, 200, response.data)

    def test_the_inventory_api_is_not_reachable_while_pending(self):
        response = self.client.get('/inventory/products/')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['code'], 'subscription_expired')

    # --- behaviour ---

    def test_verifying_moves_the_account_to_pending_payment(self):
        _, code = verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(response.data['status'], Account.PENDING_PAYMENT)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)
        # Still no access. Verifying an email is not paying for anything.
        self.assertFalse(self.account.has_active_subscription)

    def test_a_wrong_code_returns_a_machine_readable_error(self):
        verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': '000000'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'invalid_code')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_VERIFICATION)

    def test_a_locked_code_says_so(self):
        verification.issue_code(self.user)
        for _ in range(verification.MAX_ATTEMPTS):
            self.client.post('/accounts/verify-email/', {'code': '000000'}, format='json')
        response = self.client.post('/accounts/verify-email/', {'code': '000000'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'code_locked')

    def test_an_expired_code_says_so(self):
        row, code = verification.issue_code(self.user)
        row.expires_at = timezone.now() - timedelta(seconds=1)
        row.save(update_fields=['expires_at'])
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(response.data['code'], 'code_expired')

    def test_verifying_with_nothing_outstanding_says_so(self):
        response = self.client.post('/accounts/verify-email/', {'code': '123456'}, format='json')
        self.assertEqual(response.data['code'], 'no_code')

    def test_a_missing_code_is_a_field_error(self):
        response = self.client.post('/accounts/verify-email/', {}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('code', response.data)

    def test_resend_sends_a_new_code(self):
        response = self.client.post('/accounts/resend-code/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(EmailVerification.objects.filter(user=self.user).count(), 1)

    def test_resend_too_soon_returns_429_with_a_retry_after(self):
        self.client.post('/accounts/resend-code/')
        response = self.client.post('/accounts/resend-code/')
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.data['code'], 'resend_throttled')
        self.assertGreater(response.data['retry_after'], 0)

    def test_verifying_an_already_active_account_does_not_downgrade_it(self):
        self.account.subscription_status = Account.ACTIVE
        self.account.save(update_fields=['subscription_status'])
        _, code = verification.issue_code(self.user)
        self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)

    def test_one_users_code_cannot_verify_another_users_account(self):
        other = User.objects.create_user(
            username='other@example.com', email='other@example.com', password='pw12345!',
        )
        Membership.objects.create(
            user=other,
            account=Account.objects.create(name='Other Co'),
            is_owner=True,
        )
        _, their_code = verification.issue_code(other)
        response = self.client.post(
            '/accounts/verify-email/', {'code': their_code}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_VERIFICATION)

    def test_a_superadmin_has_no_account_but_is_not_sent_to_a_paywall(self):
        admin = User.objects.create_superuser(username='platform', password='pw12345!')
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(admin).access_token}')
        response = client.get('/accounts/subscription/')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data['status'])
        self.assertTrue(response.data['has_active_subscription'])

    def test_all_three_endpoints_require_authentication(self):
        anonymous = APIClient()
        self.assertEqual(anonymous.get('/accounts/subscription/').status_code, 401)
        self.assertEqual(
            anonymous.post('/accounts/verify-email/', {'code': '1'}).status_code, 401,
        )
        self.assertEqual(anonymous.post('/accounts/resend-code/').status_code, 401)


class ActivationTests(TestCase):
    """
    activate_account is the single place an account becomes usable. The webhook in 2.5b-2
    will call it too, so the expiry arithmetic is tested here rather than through whichever
    endpoint happens to reach it.
    """

    def setUp(self):
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )

    def test_lifetime_never_expires(self):
        activate_account(self.account, plan_type=Account.ONE_TIME)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.plan_type, Account.ONE_TIME)
        self.assertIsNone(self.account.expires_at)
        self.assertTrue(self.account.has_active_subscription)

    def test_months_set_an_expiry_in_the_future(self):
        activate_account(self.account, plan_type=Account.MONTHLY, months=3)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.plan_type, Account.MONTHLY)
        expected = add_months(timezone.now(), 3)
        self.assertLess(abs((self.account.expires_at - expected).total_seconds()), 60)

    def test_renewing_early_adds_to_the_time_left(self):
        # Redeeming a second key with a month still on the clock must not throw that month
        # away — extend from the existing expiry, not from now.
        future = timezone.now() + timedelta(days=30)
        self.account.expires_at = future
        self.account.subscription_status = Account.ACTIVE
        self.account.save()

        activate_account(self.account, plan_type=Account.MONTHLY, months=1)
        self.account.refresh_from_db()
        expected = add_months(future, 1)
        self.assertLess(abs((self.account.expires_at - expected).total_seconds()), 60)

    def test_renewing_after_lapsing_starts_from_now(self):
        # The mirror of the above: a lapsed account must not have its new month consumed by
        # the time it spent expired.
        self.account.expires_at = timezone.now() - timedelta(days=90)
        self.account.subscription_status = Account.PAST_DUE
        self.account.save()

        activate_account(self.account, plan_type=Account.MONTHLY, months=1)
        self.account.refresh_from_db()
        expected = add_months(timezone.now(), 1)
        self.assertLess(abs((self.account.expires_at - expected).total_seconds()), 60)

    def test_a_lifetime_grant_clears_an_earlier_expiry(self):
        self.account.expires_at = timezone.now() + timedelta(days=5)
        self.account.save()
        activate_account(self.account, plan_type=Account.ONE_TIME)
        self.account.refresh_from_db()
        self.assertIsNone(self.account.expires_at)

    def test_grace_days_extend_the_expiry(self):
        activate_account(self.account, plan_type=Account.MONTHLY, months=1, grace_days=3)
        self.account.refresh_from_db()
        expected = add_months(timezone.now(), 1) + timedelta(days=3)
        self.assertLess(abs((self.account.expires_at - expected).total_seconds()), 60)

    def test_monthly_without_months_is_a_programming_error(self):
        with self.assertRaises(ValueError):
            activate_account(self.account, plan_type=Account.MONTHLY)

    def test_unknown_plan_type_is_rejected(self):
        with self.assertRaises(ValueError):
            activate_account(self.account, plan_type='enterprise', months=1)


class AddMonthsTests(TestCase):
    def test_adds_a_calendar_month(self):
        moment = datetime(2026, 1, 15, 12, 0, tzinfo=dt_timezone.utc)
        self.assertEqual(add_months(moment, 1).date(), date(2026, 2, 15))

    def test_clamps_to_the_end_of_a_short_month(self):
        # 31 January + 1 month has no 31 February. Rolling over to 3 March would hand out
        # days nobody paid for and drift further with every renewal.
        moment = datetime(2026, 1, 31, 12, 0, tzinfo=dt_timezone.utc)
        self.assertEqual(add_months(moment, 1).date(), date(2026, 2, 28))

    def test_crosses_a_year_boundary(self):
        moment = datetime(2026, 11, 30, 12, 0, tzinfo=dt_timezone.utc)
        self.assertEqual(add_months(moment, 3).date(), date(2027, 2, 28))

    def test_twelve_months_is_the_same_date_next_year(self):
        moment = datetime(2026, 6, 10, 12, 0, tzinfo=dt_timezone.utc)
        self.assertEqual(add_months(moment, 12).date(), date(2027, 6, 10))

    def test_preserves_the_time_of_day(self):
        moment = datetime(2026, 6, 10, 9, 30, tzinfo=dt_timezone.utc)
        self.assertEqual(add_months(moment, 1).hour, 9)
        self.assertEqual(add_months(moment, 1).minute, 30)


class BillingProviderTests(TestCase):
    def setUp(self):
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )

    def test_the_default_provider_is_the_dummy(self):
        self.assertEqual(get_provider().name, 'dummy')

    def test_the_dummy_refuses_checkout_rather_than_pretending(self):
        # A dummy that returned a plausible checkout would let a broken deployment look
        # like a working one right up to the point somebody expects money.
        with self.assertRaises(ProviderUnavailable):
            get_provider().create_checkout(self.account, 'monthly')

    def test_an_unknown_plan_is_rejected_before_the_provider_is_reached(self):
        with self.assertRaises(UnknownPlan):
            get_provider().create_checkout(self.account, 'enterprise')

    @override_settings(BILLING_PROVIDER='paddle')
    def test_paddle_is_not_wired_yet_and_says_so(self):
        # Better a loud error naming the phase than a mystery ImportError.
        with self.assertRaises(ImproperlyConfigured) as caught:
            get_provider()
        self.assertIn('2.5b-2', str(caught.exception))

    @override_settings(BILLING_PROVIDER='nonsense')
    def test_an_unrecognised_provider_is_a_configuration_error(self):
        with self.assertRaises(ImproperlyConfigured):
            get_provider()

    def test_plan_keys_match_the_account_model(self):
        # These two lists drifting apart would let checkout accept a plan that
        # activate_account then rejects with a ValueError — a 500, not a 400.
        self.assertEqual(set(PLAN_KEYS), {choice[0] for choice in Account.PLAN_TYPE_CHOICES})


class DiscountKeyCodeTests(TestCase):
    def test_generated_codes_are_the_right_shape(self):
        code = generate_code()
        self.assertEqual(len(code), KEY_LENGTH)
        self.assertTrue(set(code) <= set(ALPHABET))

    def test_the_alphabet_excludes_ambiguous_characters(self):
        # These keys get read aloud off WhatsApp and copied by hand. O/0 and I/1/L are the
        # pairs that generate support calls.
        for character in '01OIL':
            self.assertNotIn(character, ALPHABET)

    def test_generated_codes_differ(self):
        self.assertNotEqual(generate_code(), generate_code())

    def test_normalize_strips_the_formatting_people_type(self):
        self.assertEqual(normalize_key('abcd-efgh-jkmn'), 'ABCDEFGHJKMN')
        self.assertEqual(normalize_key('  ABCD EFGH JKMN '), 'ABCDEFGHJKMN')

    def test_normalize_survives_none(self):
        self.assertEqual(normalize_key(None), '')

    def test_format_groups_in_fours(self):
        self.assertEqual(format_key('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN')


class DiscountKeyModelTests(TestCase):
    def test_a_fresh_key_is_redeemable(self):
        key = DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
        self.assertTrue(key.is_redeemable())

    def test_a_deactivated_key_is_not(self):
        key = DiscountKey.objects.create(
            code=generate_code(), grants=DiscountKey.LIFETIME, is_active=False,
        )
        self.assertFalse(key.is_redeemable())

    def test_an_expired_key_is_not(self):
        key = DiscountKey.objects.create(
            code=generate_code(),
            grants=DiscountKey.LIFETIME,
            expires_at=timezone.now() - timedelta(minutes=1),
        )
        self.assertFalse(key.is_redeemable())

    def test_an_exhausted_key_is_not(self):
        key = DiscountKey.objects.create(
            code=generate_code(),
            grants=DiscountKey.LIFETIME,
            max_redemptions=2,
            redemption_count=2,
        )
        self.assertFalse(key.is_redeemable())

    def test_a_multi_use_key_with_room_left_is(self):
        key = DiscountKey.objects.create(
            code=generate_code(),
            grants=DiscountKey.LIFETIME,
            max_redemptions=5,
            redemption_count=4,
        )
        self.assertTrue(key.is_redeemable())

    def test_codes_are_unique(self):
        DiscountKey.objects.create(code='ABCDEFGHJKMN', grants=DiscountKey.LIFETIME)
        with self.assertRaises(IntegrityError):
            DiscountKey.objects.create(code='ABCDEFGHJKMN', grants=DiscountKey.LIFETIME)

    def test_a_months_key_requires_a_month_count(self):
        key = DiscountKey(code=generate_code(), grants=DiscountKey.MONTHS, grant_months=None)
        with self.assertRaises(ValidationError):
            key.full_clean()

    def test_a_lifetime_key_needs_no_month_count(self):
        key = DiscountKey(code=generate_code(), grants=DiscountKey.LIFETIME)
        key.full_clean()  # must not raise

    def test_the_same_account_cannot_redeem_one_key_twice(self):
        account = Account.objects.create(name='Acme')
        key = DiscountKey.objects.create(
            code=generate_code(), grants=DiscountKey.LIFETIME, max_redemptions=5,
        )
        DiscountKeyRedemption.objects.create(key=key, account=account)
        with self.assertRaises(IntegrityError):
            DiscountKeyRedemption.objects.create(key=key, account=account)


class RedeemKeyTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(self.user).access_token}'
        )
        self.url = '/billing/redeem-key/'

    def make_key(self, **overrides):
        fields = {'code': generate_code(), 'grants': DiscountKey.LIFETIME}
        fields.update(overrides)
        return DiscountKey.objects.create(**fields)

    def test_a_pending_account_can_reach_the_endpoint(self):
        # The whole point: this is an escape from the paywall, so it must not be behind it.
        # A 403 here strands every unpaid account with no route out.
        key = self.make_key()
        response = self.client.post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.status_code, 200)

    def test_a_lifetime_key_activates_the_account(self):
        key = self.make_key()
        self.client.post(self.url, {'code': key.code}, format='json')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.plan_type, Account.ONE_TIME)
        self.assertIsNone(self.account.expires_at)

    def test_a_months_key_sets_an_expiry(self):
        key = self.make_key(grants=DiscountKey.MONTHS, grant_months=6)
        self.client.post(self.url, {'code': key.code}, format='json')
        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.MONTHLY)
        expected = add_months(timezone.now(), 6)
        self.assertLess(abs((self.account.expires_at - expected).total_seconds()), 60)

    def test_the_response_carries_the_new_status_for_the_router(self):
        key = self.make_key()
        response = self.client.post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.data['status'], Account.ACTIVE)
        self.assertTrue(response.data['has_active_subscription'])

    def test_redemption_is_recorded_and_counted(self):
        key = self.make_key()
        self.client.post(self.url, {'code': key.code}, format='json')
        key.refresh_from_db()
        self.assertEqual(key.redemption_count, 1)
        self.assertTrue(
            DiscountKeyRedemption.objects.filter(key=key, account=self.account).exists()
        )

    def test_dashes_and_lowercase_are_accepted(self):
        key = self.make_key()
        typed = format_key(key.code).lower()
        response = self.client.post(self.url, {'code': typed}, format='json')
        self.assertEqual(response.status_code, 200)

    def test_a_single_use_key_cannot_be_used_twice(self):
        key = self.make_key()
        other_user = User.objects.create_user(
            username='other@example.com', email='other@example.com', password='pw12345!',
        )
        other_account = Account.objects.create(
            name='Other', subscription_status=Account.PENDING_PAYMENT,
        )
        Membership.objects.create(user=other_user, account=other_account, is_owner=True)

        self.client.post(self.url, {'code': key.code}, format='json')

        other_client = APIClient()
        other_client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(other_user).access_token}'
        )
        response = other_client.post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.status_code, 400)
        other_account.refresh_from_db()
        self.assertEqual(other_account.subscription_status, Account.PENDING_PAYMENT)

    def test_the_same_account_redeeming_twice_is_told_so(self):
        key = self.make_key(max_redemptions=5)
        self.client.post(self.url, {'code': key.code}, format='json')
        response = self.client.post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'already_redeemed')
        key.refresh_from_db()
        self.assertEqual(key.redemption_count, 1)

    def test_unknown_expired_exhausted_and_inactive_keys_are_indistinguishable(self):
        # The endpoint must not be an oracle that confirms a key exists. Every one of these
        # returns the identical body, so probing tells an attacker nothing.
        expired = self.make_key(expires_at=timezone.now() - timedelta(minutes=1))
        exhausted = self.make_key(max_redemptions=1, redemption_count=1)
        inactive = self.make_key(is_active=False)

        bodies = []
        for code in ['ZZZZZZZZZZZZ', expired.code, exhausted.code, inactive.code]:
            response = self.client.post(self.url, {'code': code}, format='json')
            self.assertEqual(response.status_code, 400)
            bodies.append(response.data)

        self.assertEqual(len(set(str(body) for body in bodies)), 1)

    def test_a_partial_discount_key_is_refused(self):
        key = self.make_key(percent_off=50)
        response = self.client.post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'partial_discount_unsupported')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)

    def test_a_failed_redemption_does_not_consume_the_key(self):
        key = self.make_key(percent_off=50)
        self.client.post(self.url, {'code': key.code}, format='json')
        key.refresh_from_db()
        self.assertEqual(key.redemption_count, 0)

    def test_anonymous_callers_are_rejected(self):
        key = self.make_key()
        response = APIClient().post(self.url, {'code': key.code}, format='json')
        self.assertEqual(response.status_code, 401)

    def test_a_user_with_no_account_cannot_redeem(self):
        # A superadmin has no membership. Redeeming would activate nothing and 500 on the
        # None account.
        admin = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw12345!',
        )
        client = APIClient()
        client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(admin).access_token}'
        )
        response = client.post(self.url, {'code': self.make_key().code}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'no_account')

    def test_an_empty_code_is_a_field_error(self):
        response = self.client.post(self.url, {'code': ''}, format='json')
        self.assertEqual(response.status_code, 400)


class BillingEndpointTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(self.user).access_token}'
        )

    def test_config_is_reachable_while_pending(self):
        response = self.client.get('/billing/config/')
        self.assertEqual(response.status_code, 200)

    def test_config_reports_card_checkout_off_under_the_dummy(self):
        response = self.client.get('/billing/config/')
        self.assertFalse(response.data['card_checkout_available'])

    def test_config_lists_both_plans_with_prices(self):
        response = self.client.get('/billing/config/')
        plans = {plan['key']: plan for plan in response.data['plans']}
        self.assertEqual(set(plans), {Account.MONTHLY, Account.ONE_TIME})
        for plan in plans.values():
            self.assertTrue(plan['price_usd'])
            self.assertTrue(plan['name'])

    def test_checkout_is_reachable_while_pending(self):
        # Reachable, and refused for the right reason — a 403 here would mean the paywall
        # blocks its own checkout.
        response = self.client.post('/billing/checkout/', {'plan': 'monthly'}, format='json')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data['code'], 'card_checkout_unavailable')

    def test_checkout_rejects_an_unknown_plan(self):
        response = self.client.post(
            '/billing/checkout/', {'plan': 'enterprise'}, format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_checkout_ignores_any_amount_the_client_sends(self):
        # The client sends a plan key and nothing else is read. If an amount were ever
        # honoured, this is where it would show up.
        response = self.client.post(
            '/billing/checkout/',
            {'plan': 'monthly', 'amount': '0.01', 'currency': 'USD'},
            format='json',
        )
        self.assertEqual(response.status_code, 503)

    def test_anonymous_callers_are_rejected_everywhere(self):
        anonymous = APIClient()
        self.assertEqual(anonymous.get('/billing/config/').status_code, 401)
        self.assertEqual(
            anonymous.post('/billing/checkout/', {'plan': 'monthly'}, format='json').status_code,
            401,
        )


class DiscountKeyAdminTests(TestCase):
    def setUp(self):
        self.admin_user = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw12345!',
        )
        self.client = Client()
        self.client.force_login(self.admin_user)

    def add_payload(self, **overrides):
        payload = {
            'code': '',
            'percent_off': 100,
            'grants': DiscountKey.LIFETIME,
            'grant_months': '',
            'max_redemptions': 1,
            'expires_at_0': '', 'expires_at_1': '',
            'is_active': 'on',
            'amount_paid_usd': '0',
            'note': '',
            'created_at_0': '2026-08-08', 'created_at_1': '12:00:00',
        }
        payload.update(overrides)
        return payload

    def test_saving_a_key_without_a_code_generates_one(self):
        # The owner should never have to invent a code by hand — hand-typed codes are short,
        # guessable, and collide.
        response = self.client.post(
            '/admin/accounts/discountkey/add/',
            self.add_payload(amount_paid_usd='250.00', note='Paid cash, Hamra branch'),
        )
        self.assertEqual(response.status_code, 302)
        key = DiscountKey.objects.get()
        self.assertEqual(len(key.code), KEY_LENGTH)
        self.assertTrue(set(key.code) <= set(ALPHABET))

    def test_the_creating_admin_is_recorded(self):
        self.client.post('/admin/accounts/discountkey/add/', self.add_payload())
        self.assertEqual(DiscountKey.objects.get().created_by, self.admin_user)

    def test_a_typed_code_is_normalized_not_stored_as_typed(self):
        self.client.post(
            '/admin/accounts/discountkey/add/', self.add_payload(code='abcd-efgh-jkmn'),
        )
        self.assertEqual(DiscountKey.objects.get().code, 'ABCDEFGHJKMN')

    def test_the_deactivate_action_kills_selected_keys(self):
        keys = [
            DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
            for _ in range(2)
        ]
        self.client.post('/admin/accounts/discountkey/', {
            'action': 'deactivate_keys',
            '_selected_action': [str(key.pk) for key in keys],
        })
        self.assertEqual(DiscountKey.objects.filter(is_active=True).count(), 0)

    def test_the_changelist_renders(self):
        DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
        self.assertEqual(
            self.client.get('/admin/accounts/discountkey/').status_code, 200,
        )

    def test_the_redemption_changelist_renders(self):
        account = Account.objects.create(name='Acme')
        key = DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
        DiscountKeyRedemption.objects.create(key=key, account=account)
        self.assertEqual(
            self.client.get('/admin/accounts/discountkeyredemption/').status_code, 200,
        )


class CodePurposeTests(TestCase):
    """
    Codes are scoped to what they were issued for.

    Without a purpose, one `EmailVerification` table serves two flows and three things go
    wrong: a signup code can be replayed at the password-reset endpoint, requesting a reset
    silently expires an outstanding signup code, and the two flows share one
    five-sends-per-hour budget so using either one exhausts the other.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )

    def test_a_signup_code_does_not_verify_as_a_password_reset(self):
        _, code = verification.issue_code(self.user)
        self.assertEqual(
            verification.verify_code(
                self.user, code, purpose=verification.PASSWORD_RESET,
            ),
            verification.NO_CODE,
        )

    def test_a_reset_code_does_not_verify_as_an_email_verification(self):
        _, code = verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        self.assertEqual(verification.verify_code(self.user, code), verification.NO_CODE)

    def test_issuing_a_reset_code_leaves_an_outstanding_signup_code_alone(self):
        _, signup_code = verification.issue_code(self.user)
        verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        self.assertEqual(verification.verify_code(self.user, signup_code), verification.OK)

    def test_the_hourly_send_cap_is_counted_per_purpose(self):
        # Exhaust the signup budget outright, then prove a reset can still be requested.
        for _ in range(verification.MAX_SENDS_PER_HOUR):
            row, _ = verification.issue_code(self.user)
            row.created_at = timezone.now() - timedelta(seconds=90)
            row.save(update_fields=['created_at'])

        with self.assertRaises(verification.ResendThrottled):
            verification.issue_code(self.user)

        row, code = verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        self.assertIsNotNone(code)

    def test_codes_default_to_the_email_verification_purpose(self):
        row, _ = verification.issue_code(self.user)
        self.assertEqual(row.purpose, verification.EMAIL_VERIFICATION)


class NonConsumingCheckTests(TestCase):
    """
    `consume=False` is what lets the reset UI tell the user about a typo before it asks them
    to think up a password, without spending the code they will need one screen later.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )

    def test_a_check_leaves_the_code_usable(self):
        _, code = verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        for _ in range(3):
            self.assertEqual(
                verification.verify_code(
                    self.user, code, purpose=verification.PASSWORD_RESET, consume=False,
                ),
                verification.OK,
            )
        # Still spendable afterwards, exactly once.
        self.assertEqual(
            verification.verify_code(
                self.user, code, purpose=verification.PASSWORD_RESET,
            ),
            verification.OK,
        )
        self.assertEqual(
            verification.verify_code(
                self.user, code, purpose=verification.PASSWORD_RESET,
            ),
            verification.NO_CODE,
        )

    def test_a_wrong_guess_still_counts_against_the_cap(self):
        # Not consuming must not mean not counting, or the check endpoint is a free oracle to
        # grind the six-digit space against.
        row, _ = verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        verification.verify_code(
            self.user, '000000', purpose=verification.PASSWORD_RESET, consume=False,
        )
        row.refresh_from_db()
        self.assertEqual(row.attempts, 1)


class PasswordResetEndpointTests(TestCase):
    """
    Three endpoints for a three-screen flow, but only one of them decides anything: the
    password changes in `confirm`, which takes the code and the new password together.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='oldpw12345!',
        )
        self.account = Account.objects.create(
            name='Corner Shop', subscription_status=Account.ACTIVE,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.credentials(
            HTTP_AUTHORIZATION=f'JWT {RefreshToken.for_user(self.user).access_token}',
        )
        mail.outbox = []

    def issue(self):
        _, code = verification.issue_code(self.user, purpose=verification.PASSWORD_RESET)
        return code

    # --- request ---

    def test_requesting_a_code_emails_one(self):
        response = self.client.post('/accounts/password-reset/request/')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn('owner@example.com', mail.outbox[0].to)
        self.assertEqual(
            EmailVerification.objects.filter(
                user=self.user, purpose=verification.PASSWORD_RESET,
            ).count(),
            1,
        )

    def test_the_emailed_code_is_not_in_the_response(self):
        response = self.client.post('/accounts/password-reset/request/')
        self.assertNotIn('code', response.data)

    def test_requesting_twice_in_a_row_is_throttled(self):
        self.client.post('/accounts/password-reset/request/')
        response = self.client.post('/accounts/password-reset/request/')
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.data['code'], 'resend_throttled')

    # --- verify (the check that decides nothing) ---

    def test_verifying_the_right_code_succeeds(self):
        code = self.issue()
        response = self.client.post(
            '/accounts/password-reset/verify/', {'code': code}, format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_verifying_does_not_spend_the_code(self):
        code = self.issue()
        self.client.post('/accounts/password-reset/verify/', {'code': code}, format='json')
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_verifying_a_wrong_code_is_a_400(self):
        self.issue()
        response = self.client.post(
            '/accounts/password-reset/verify/', {'code': '000000'}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'invalid_code')

    # --- confirm ---

    def test_the_password_changes(self):
        code = self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('brandNewPw!2026'))

    def test_a_valid_session_alone_cannot_change_the_password(self):
        # The whole point of the flow. If confirm accepted an authenticated request without a
        # code, the three screens would be theatre: anyone with a borrowed session could set a
        # new password and lock the owner out.
        self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('oldpw12345!'))

    def test_a_wrong_code_does_not_change_the_password(self):
        self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': '000000', 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'invalid_code')
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('oldpw12345!'))

    def test_a_signup_code_cannot_be_spent_here(self):
        _, signup_code = verification.issue_code(self.user)
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': signup_code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('oldpw12345!'))

    def test_the_code_is_single_use(self):
        code = self.issue()
        self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'anotherPw!2026', 'confirm_password': 'anotherPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('brandNewPw!2026'))

    def test_a_weak_password_is_rejected_by_djangos_validators(self):
        code = self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': '12345', 'confirm_password': '12345'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('new_password', response.data)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('oldpw12345!'))

    def test_a_rejected_password_does_not_burn_the_code(self):
        # Otherwise picking a password the validators dislike costs the user a fresh email
        # and a 60-second wait, which reads as the app being broken.
        code = self.issue()
        self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': '12345', 'confirm_password': '12345'},
            format='json',
        )
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_mismatched_confirmation_is_rejected(self):
        code = self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'different!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('oldpw12345!'))

    def test_existing_refresh_tokens_stop_working(self):
        # A reset is what someone does when they think their account is compromised. If the
        # attacker's refresh token outlives it, the reset achieved nothing.
        stale = RefreshToken.for_user(self.user)
        code = self.issue()
        self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        response = APIClient().post(
            '/auth/jwt/refresh/', {'refresh': str(stale)}, format='json',
        )
        self.assertEqual(response.status_code, 401)

    # --- permissions ---

    def test_anonymous_callers_are_rejected(self):
        for path in ('request', 'verify', 'confirm'):
            response = APIClient().post(f'/accounts/password-reset/{path}/')
            self.assertEqual(response.status_code, 401, path)

    def test_the_flow_is_reachable_without_a_live_subscription(self):
        # Changing a password is not a paid feature, and someone locked out of a lapsed
        # account still needs to be able to secure it.
        self.account.subscription_status = Account.PENDING_PAYMENT
        self.account.save(update_fields=['subscription_status'])

        code = self.issue()
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_one_users_code_cannot_reset_anothers_password(self):
        victim = User.objects.create_user(
            username='victim@example.com', email='victim@example.com', password='victimPw123!',
        )
        _, victim_code = verification.issue_code(
            victim, purpose=verification.PASSWORD_RESET,
        )
        response = self.client.post(
            '/accounts/password-reset/confirm/',
            {'code': victim_code, 'new_password': 'brandNewPw!2026', 'confirm_password': 'brandNewPw!2026'},
            format='json',
        )
        self.assertEqual(response.status_code, 400)
        victim.refresh_from_db()
        self.assertTrue(victim.check_password('victimPw123!'))


class PasswordResetEmailTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw12345!',
        )
        mail.outbox = []

    def test_the_email_carries_the_code_and_says_what_it_is_for(self):
        self.assertTrue(emails.send_password_reset_code(self.user, '123456'))
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertIn('123456', message.body)
        self.assertIn('password', message.subject.lower())

    def test_a_failed_send_is_reported_rather_than_raised(self):
        with patch('accounts.emails.send_mail', side_effect=SMTPException('nope')):
            self.assertFalse(emails.send_password_reset_code(self.user, '123456'))

    def test_a_user_with_no_address_cannot_be_sent_one(self):
        self.user.email = ''
        self.user.save(update_fields=['email'])
        self.assertFalse(emails.send_password_reset_code(self.user, '123456'))
