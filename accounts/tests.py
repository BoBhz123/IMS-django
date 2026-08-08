from datetime import timedelta
from smtplib import SMTPException
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core import mail
from django.db import IntegrityError, transaction
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
