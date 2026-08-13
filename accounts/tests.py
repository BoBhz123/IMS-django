import json
import re
import smtplib
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from io import StringIO
from smtplib import SMTPException
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth.models import Permission, User
from django.core import mail
from django.core.cache import cache
from django.core.mail import EmailMultiAlternatives
from django.core.management import call_command
from django.core.management.base import CommandError
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import IntegrityError, transaction
from django.conf import settings
from django.test import Client, RequestFactory, TestCase, override_settings
from django.utils import timezone

from accounts import emails, registration, verification
from accounts.billing import get_provider
from accounts.billing.activation import (
    TrialAlreadyUsed, activate_account, add_months, start_trial,
)
from accounts.billing.base import PLAN_KEYS, ProviderUnavailable, UnknownPlan
from accounts.admin import status_badge
from accounts.crypto import UNREADABLE, encrypt_text
from accounts.billing.keys import (
    ALPHABET, KEY_LENGTH, format_key, generate_code, normalize_key,
)
from accounts.billing.paddle import plan_for_price_id, verify_signature
from accounts.billing.webhooks import trial_expiry_sweep
from accounts.models import (
    Account, DiscountKey, DiscountKeyRedemption, EmailVerification, Membership,
    ProcessedWebhookEvent, UserPaymentRecord, get_account,
)
from cryptography.fernet import Fernet

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
        with patch.object(EmailMultiAlternatives, 'send', side_effect=SMTPException('boom')):
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
        self.assertEqual(response.data['subscription_status'], Account.PENDING_VERIFICATION)
        self.assertFalse(response.data['subscription_live'])
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

    def test_verifying_starts_the_cardless_trial(self):
        _, code = verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(response.data['subscription_status'], Account.TRIALING)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        # Access is granted here — this is the point of a cardless trial, and it is the one
        # place the payment wall is deliberately open.
        self.assertTrue(self.account.has_active_subscription)
        self.assertEqual(self.account.trial_days_remaining, Account.TRIAL_DAYS)

    def test_the_trial_clock_restarts_at_verification_not_signup(self):
        # A customer who takes three days to find the email must still get a full trial.
        self.account.trial_ends_at = timezone.now() + timedelta(days=2)
        self.account.save(update_fields=['trial_ends_at'])

        _, code = verification.issue_code(self.user)
        self.client.post('/accounts/verify-email/', {'code': code}, format='json')

        self.account.refresh_from_db()
        self.assertEqual(self.account.trial_days_remaining, Account.TRIAL_DAYS)

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
        self.assertIsNone(response.data['subscription_status'])
        self.assertTrue(response.data['subscription_live'])

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

    def test_a_plan_supplies_its_own_period_when_months_is_omitted(self):
        # The webhook does not compute a duration — it names a plan. Defaulting per plan is
        # what stops an annual purchase being activated for one month by an omitted argument.
        activate_account(self.account, plan_type=Account.MONTHLY)
        monthly_expiry = self.account.expires_at

        other = Account.objects.create(name='Other')
        activate_account(other, plan_type=Account.ANNUAL)

        self.assertEqual(monthly_expiry.date(), add_months(timezone.now(), 1).date())
        self.assertEqual(other.expires_at.date(), add_months(timezone.now(), 12).date())

    def test_annual_activation_records_the_annual_plan(self):
        activate_account(self.account, plan_type=Account.ANNUAL)
        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.ANNUAL)
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertTrue(self.account.has_active_subscription)

    def test_a_non_positive_month_count_is_still_a_programming_error(self):
        with self.assertRaises(ValueError):
            activate_account(self.account, plan_type=Account.MONTHLY, months=0)

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
    def test_paddle_is_selectable(self):
        self.assertEqual(get_provider().name, 'paddle')

    @override_settings(
        BILLING_PROVIDER='paddle', PADDLE_CLIENT_TOKEN='', PADDLE_PRICE_MONTHLY='pri_x',
    )
    def test_paddle_without_a_client_token_refuses_rather_than_half_working(self):
        # Half-configured is indistinguishable from working right up to the point a customer
        # clicks pay, so the provider reports itself unavailable instead.
        provider = get_provider()
        self.assertFalse(provider.is_configured())
        with self.assertRaises(ProviderUnavailable):
            provider.create_checkout(self.account, 'monthly')

    @override_settings(
        BILLING_PROVIDER='paddle', PADDLE_CLIENT_TOKEN='live_tok',
        PADDLE_PRICE_MONTHLY='pri_monthly', PADDLE_PRICE_ANNUAL='',
        PADDLE_PRICE_LIFETIME='',
    )
    def test_paddle_refuses_a_plan_whose_price_is_not_configured(self):
        # Per-plan, so a deployment mid-setup still sells the plan it has finished wiring.
        provider = get_provider()
        self.assertTrue(provider.is_configured())
        checkout = provider.create_checkout(self.account, 'monthly')
        self.assertEqual(checkout['price_id'], 'pri_monthly')
        with self.assertRaises(ProviderUnavailable):
            provider.create_checkout(self.account, 'annual')

    @override_settings(
        BILLING_PROVIDER='paddle', PADDLE_CLIENT_TOKEN='live_tok',
        PADDLE_PRICE_ANNUAL='pri_annual', PADDLE_ENVIRONMENT='sandbox',
    )
    def test_paddle_checkout_carries_the_account_id_and_no_amount(self):
        checkout = get_provider().create_checkout(self.account, 'annual')
        self.assertEqual(checkout['custom_data']['account_id'], str(self.account.id))
        self.assertEqual(checkout['environment'], 'sandbox')
        # The client is told which price to buy, never how much it costs. An amount or a
        # currency here is an amount or a currency somebody can edit in devtools.
        self.assertNotIn('amount', checkout)
        self.assertNotIn('currency', checkout)

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
        self.assertEqual(response.data['subscription_status'], Account.ACTIVE)
        self.assertTrue(response.data['subscription_live'])

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

    def test_config_lists_all_three_plans_with_prices(self):
        response = self.client.get('/billing/config/')
        plans = {plan['key']: plan for plan in response.data['plans']}
        self.assertEqual(
            set(plans), {Account.MONTHLY, Account.ANNUAL, Account.ONE_TIME},
        )
        for plan in plans.values():
            self.assertTrue(plan['price_usd'])
            self.assertTrue(plan['name'])

    def test_config_exposes_the_local_payment_contacts(self):
        # Whish and cash settle over chat; a blank value is how the SPA knows to hide the
        # button rather than render a link to nowhere.
        with override_settings(WHATSAPP_NUMBER='96170000000', TELEGRAM_USERNAME='ims'):
            response = self.client.get('/billing/config/')
        self.assertEqual(response.data['local_payment']['whatsapp_number'], '96170000000')
        self.assertEqual(response.data['local_payment']['telegram_username'], 'ims')

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


# --- Phase 2.5b-2: trials, Paddle checkout, and the signed webhook -----------------------

WEBHOOK_SECRET = 'pdl_ntfset_test_secret'

PADDLE_TEST_SETTINGS = dict(
    BILLING_PROVIDER='paddle',
    PADDLE_CLIENT_TOKEN='test_client_token',
    PADDLE_ENVIRONMENT='sandbox',
    PADDLE_WEBHOOK_SECRET=WEBHOOK_SECRET,
    PADDLE_PRICE_MONTHLY='pri_monthly',
    PADDLE_PRICE_ANNUAL='pri_annual',
    PADDLE_PRICE_LIFETIME='pri_lifetime',
)


def sign(body, secret=WEBHOOK_SECRET, timestamp=None):
    """Build the Paddle-Signature header for a raw body, the way Paddle does."""
    import hashlib
    import hmac
    import time

    timestamp = str(int(time.time()) if timestamp is None else timestamp)
    digest = hmac.new(
        secret.encode(), timestamp.encode() + b':' + body, hashlib.sha256,
    ).hexdigest()
    return f'ts={timestamp};h1={digest}'


class TrialLifecycleTests(TestCase):
    """The cardless 14-day trial: how it starts, what it grants, and how it ends."""

    def setUp(self):
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_VERIFICATION,
        )

    def test_a_started_trial_grants_access(self):
        start_trial(self.account)
        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        self.assertTrue(self.account.has_active_subscription)
        self.assertTrue(self.account.is_trialing)

    def test_an_elapsed_trial_denies_access_without_any_job_having_run(self):
        # The whole point of computing liveness: nothing sweeps the status column on a
        # schedule, so an elapsed trial has to lock itself out.
        start_trial(self.account)
        self.account.trial_ends_at = timezone.now() - timedelta(minutes=1)
        self.account.save(update_fields=['trial_ends_at'])

        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        self.assertFalse(self.account.has_active_subscription)
        self.assertFalse(self.account.is_trialing)
        self.assertEqual(self.account.trial_days_remaining, 0)

    def test_a_trialing_row_with_no_end_date_is_not_live(self):
        # An unbounded free trial is the one failure a payment wall cannot survive, so the
        # null case denies rather than allows.
        self.account.subscription_status = Account.TRIALING
        self.account.trial_ends_at = None
        self.account.save(update_fields=['subscription_status', 'trial_ends_at'])
        self.assertFalse(self.account.has_active_subscription)

    def test_days_remaining_rounds_up_so_the_last_day_never_reads_zero(self):
        self.account.trial_ends_at = timezone.now() + timedelta(hours=3)
        self.assertEqual(self.account.trial_days_remaining, 1)

    def test_expires_at_is_ignored_while_trialing(self):
        # The two clocks are separate on purpose. A leftover expires_at from a lapsed
        # subscription must not shorten or extend a trial granted afterwards.
        start_trial(self.account)
        self.account.expires_at = timezone.now() - timedelta(days=100)
        self.assertTrue(self.account.has_active_subscription)

    def test_paying_during_a_trial_switches_to_the_paid_clock(self):
        start_trial(self.account)
        activate_account(self.account, plan_type=Account.ANNUAL)

        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertFalse(self.account.is_trialing)
        # trial_ends_at survives as a record of when the trial ran, and is now inert.
        self.assertIsNotNone(self.account.trial_ends_at)
        self.assertTrue(self.account.has_active_subscription)

    def test_the_sweep_only_touches_elapsed_trials(self):
        start_trial(self.account)
        elapsed = Account.objects.create(
            name='Lapsed', subscription_status=Account.TRIALING,
            trial_ends_at=timezone.now() - timedelta(days=1),
        )

        self.assertEqual(trial_expiry_sweep(), 1)

        self.account.refresh_from_db()
        elapsed.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        self.assertEqual(elapsed.subscription_status, Account.PENDING_PAYMENT)


class TrialAccessControlTests(TestCase):
    """A trial must actually open the app, and its end must actually close it."""

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(name='Acme')
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_a_trialing_account_reaches_the_core_app(self):
        start_trial(self.account)
        self.assertEqual(self.client.get('/inventory/products/').status_code, 200)

    def test_an_elapsed_trial_is_locked_out_with_its_own_error_code(self):
        # trial_expired, not subscription_expired: telling someone who has never paid to
        # "renew their subscription" reads as a billing bug.
        start_trial(self.account)
        self.account.trial_ends_at = timezone.now() - timedelta(minutes=1)
        self.account.save(update_fields=['trial_ends_at'])

        response = self.client.get('/inventory/products/')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()['code'], 'trial_expired')

    def test_the_subscription_screen_stays_reachable_after_the_trial_ends(self):
        # The escape from the paywall must not be behind the paywall.
        start_trial(self.account)
        self.account.trial_ends_at = timezone.now() - timedelta(minutes=1)
        self.account.save(update_fields=['trial_ends_at'])

        for path in ('/accounts/subscription/', '/billing/config/'):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_status_reports_the_trial_countdown(self):
        start_trial(self.account)
        data = self.client.get('/accounts/subscription/').json()
        self.assertEqual(data['subscription_status'], Account.TRIALING)
        self.assertTrue(data['is_trial'])
        self.assertEqual(data['trial_days_remaining'], Account.TRIAL_DAYS)


class PaddleSignatureTests(TestCase):
    """Signature verification is the webhook's only authentication."""

    def test_a_correctly_signed_body_verifies(self):
        body = b'{"event_id":"evt_1"}'
        self.assertTrue(verify_signature(body, sign(body), WEBHOOK_SECRET))

    def test_a_tampered_body_does_not_verify(self):
        header = sign(b'{"event_id":"evt_1"}')
        self.assertFalse(
            verify_signature(b'{"event_id":"evt_2"}', header, WEBHOOK_SECRET)
        )

    def test_the_wrong_secret_does_not_verify(self):
        body = b'{"event_id":"evt_1"}'
        self.assertFalse(verify_signature(body, sign(body), 'pdl_ntfset_other'))

    def test_an_absent_secret_rejects_everything(self):
        # An unauthenticated endpoint that grants subscriptions must fail closed when it is
        # not configured, never open.
        body = b'{"event_id":"evt_1"}'
        self.assertFalse(verify_signature(body, sign(body), ''))

    def test_an_old_signature_is_refused(self):
        body = b'{"event_id":"evt_1"}'
        stale = sign(body, timestamp=1)
        self.assertFalse(verify_signature(body, stale, WEBHOOK_SECRET))

    def test_a_malformed_header_is_refused(self):
        body = b'{"event_id":"evt_1"}'
        for header in ('', 'garbage', 'ts=;h1=', 'ts=notanumber;h1=abc', 'h1=abc'):
            self.assertFalse(verify_signature(body, header, WEBHOOK_SECRET), header)

    def test_several_h1_values_are_accepted_during_a_secret_rotation(self):
        body = b'{"event_id":"evt_1"}'
        real = sign(body).split('h1=')[1]
        timestamp = sign(body).split(';')[0].split('=')[1]
        header = f'ts={timestamp};h1=deadbeef;h1={real}'
        self.assertTrue(verify_signature(body, header, WEBHOOK_SECRET))

    @override_settings(**PADDLE_TEST_SETTINGS)
    def test_price_ids_map_back_to_plan_keys(self):
        self.assertEqual(plan_for_price_id('pri_monthly'), Account.MONTHLY)
        self.assertEqual(plan_for_price_id('pri_annual'), Account.ANNUAL)
        self.assertEqual(plan_for_price_id('pri_lifetime'), Account.ONE_TIME)
        # An unrecognised price must not silently become a monthly plan.
        self.assertIsNone(plan_for_price_id('pri_someone_elses'))
        self.assertIsNone(plan_for_price_id(''))


@override_settings(**PADDLE_TEST_SETTINGS)
class PaddleWebhookTests(TestCase):
    WEBHOOK_URL = '/billing/webhook/paddle/'

    def setUp(self):
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        self.client = Client()

    def post(self, payload, *, secret=WEBHOOK_SECRET, timestamp=None, header=None):
        body = json.dumps(payload).encode()
        return self.client.post(
            self.WEBHOOK_URL,
            data=body,
            content_type='application/json',
            HTTP_PADDLE_SIGNATURE=(
                header if header is not None else sign(body, secret, timestamp)
            ),
        )

    def completed(self, event_id='evt_1', price_id='pri_annual', **data):
        payload = {
            'event_id': event_id,
            'event_type': 'transaction.completed',
            'data': {
                'id': 'txn_1',
                'customer_id': 'ctm_1',
                'items': [{'price': {'id': price_id}}],
                'custom_data': {'account_id': str(self.account.id)},
            },
        }
        payload['data'].update(data)
        return payload

    # --- authentication -----------------------------------------------------------------

    def test_an_unsigned_request_is_refused_and_grants_nothing(self):
        response = self.client.post(
            self.WEBHOOK_URL, data=json.dumps(self.completed()),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 403)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)

    def test_a_forged_signature_is_refused(self):
        response = self.post(self.completed(), secret='pdl_ntfset_attacker')
        self.assertEqual(response.status_code, 403)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)

    def test_a_replayed_old_signature_is_refused(self):
        response = self.post(self.completed(), timestamp=1)
        self.assertEqual(response.status_code, 403)

    def test_nothing_is_recorded_for_a_rejected_request(self):
        # A rejected body must not consume its own event id, or an attacker could block the
        # real notification by racing it with a forgery.
        self.post(self.completed(), secret='wrong')
        self.assertFalse(ProcessedWebhookEvent.objects.exists())

    # --- granting -----------------------------------------------------------------------

    def test_a_completed_transaction_activates_the_account(self):
        response = self.post(self.completed())
        self.assertEqual(response.status_code, 200)

        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.plan_type, Account.ANNUAL)
        self.assertTrue(self.account.has_active_subscription)
        self.assertEqual(self.account.paddle_customer_id, 'ctm_1')

    def test_the_plan_comes_from_the_price_that_was_paid_not_the_claim(self):
        # custom_data is what we asked for; the line item is what the money bought. When
        # they disagree the money wins.
        payload = self.completed(price_id='pri_monthly')
        payload['data']['custom_data']['plan'] = 'one_time'
        self.post(payload)

        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.MONTHLY)
        self.assertIsNotNone(self.account.expires_at)

    def test_a_lifetime_purchase_clears_the_expiry(self):
        self.post(self.completed(price_id='pri_lifetime'))
        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.ONE_TIME)
        self.assertIsNone(self.account.expires_at)
        self.assertTrue(self.account.has_active_subscription)

    def test_an_unknown_price_is_acknowledged_but_grants_nothing(self):
        # 200 so Paddle stops retrying an event we will never handle; no activation, because
        # guessing a plan from an unrecognised price is how you give away the product.
        response = self.post(self.completed(price_id='pri_not_ours'))
        self.assertEqual(response.status_code, 200)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)

    def test_an_unmatchable_account_is_acknowledged_but_grants_nothing(self):
        payload = self.completed()
        payload['data']['custom_data'] = {'account_id': '999999'}
        payload['data']['customer_id'] = 'ctm_unknown'
        response = self.post(payload)
        self.assertEqual(response.status_code, 200)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.PENDING_PAYMENT)

    def test_a_trialing_account_that_pays_moves_onto_the_paid_plan(self):
        start_trial(self.account)
        self.post(self.completed())
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.plan_type, Account.ANNUAL)

    # --- idempotency --------------------------------------------------------------------

    def test_a_retried_event_does_not_extend_the_expiry_twice(self):
        # Paddle retries until it sees a 2xx. Without the event ledger the customer pays for
        # one year and gets two.
        self.post(self.completed(price_id='pri_monthly'))
        self.account.refresh_from_db()
        first_expiry = self.account.expires_at

        response = self.post(self.completed(price_id='pri_monthly'))
        self.assertEqual(response.status_code, 200)

        self.account.refresh_from_db()
        self.assertEqual(self.account.expires_at, first_expiry)
        self.assertEqual(ProcessedWebhookEvent.objects.count(), 1)

    def test_a_genuinely_new_event_does_extend_the_expiry(self):
        # The mirror of the test above: idempotency must key on the event id, not on "this
        # account already paid", or a real renewal would be swallowed.
        self.post(self.completed(event_id='evt_1', price_id='pri_monthly'))
        self.account.refresh_from_db()
        first_expiry = self.account.expires_at

        self.post(self.completed(event_id='evt_2', price_id='pri_monthly'))
        self.account.refresh_from_db()
        self.assertGreater(self.account.expires_at, first_expiry)

    def test_an_event_without_an_id_is_rejected(self):
        payload = self.completed()
        del payload['event_id']
        self.assertEqual(self.post(payload).status_code, 400)

    def test_a_malformed_body_is_rejected(self):
        body = b'not json at all'
        response = self.client.post(
            self.WEBHOOK_URL, data=body, content_type='application/json',
            HTTP_PADDLE_SIGNATURE=sign(body),
        )
        self.assertEqual(response.status_code, 400)

    # --- revoking -----------------------------------------------------------------------

    def test_a_cancellation_marks_the_account_canceled(self):
        activate_account(self.account, plan_type=Account.MONTHLY)
        self.account.paddle_subscription_id = 'sub_1'
        self.account.save(update_fields=['paddle_subscription_id'])
        paid_until = self.account.expires_at

        self.post({
            'event_id': 'evt_cancel',
            'event_type': 'subscription.canceled',
            'data': {'id': 'sub_1', 'customer_id': 'ctm_1'},
        })

        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.CANCELED)
        # The paid period is not clawed back — Paddle cancellations take effect at the end
        # of the term, and expires_at already encodes that date.
        self.assertEqual(self.account.expires_at, paid_until)

    def test_a_subscription_id_is_recorded_but_a_transaction_id_is_not(self):
        # Storing txn_* in paddle_subscription_id would make a later cancellation lookup
        # match the wrong row.
        self.post(self.completed())
        self.account.refresh_from_db()
        self.assertEqual(self.account.paddle_subscription_id, '')

        self.post({
            'event_id': 'evt_sub',
            'event_type': 'subscription.activated',
            'data': {
                'id': 'sub_9', 'customer_id': 'ctm_1',
                'items': [{'price': {'id': 'pri_monthly'}}],
                'custom_data': {'account_id': str(self.account.id)},
            },
        })
        self.account.refresh_from_db()
        self.assertEqual(self.account.paddle_subscription_id, 'sub_9')

    def test_a_renewal_is_matched_by_subscription_id_without_custom_data(self):
        # Renewals do not always echo custom_data back, so the gateway ids are the fallback.
        self.account.paddle_subscription_id = 'sub_7'
        self.account.save(update_fields=['paddle_subscription_id'])

        self.post({
            'event_id': 'evt_renew',
            'event_type': 'subscription.updated',
            'data': {
                'id': 'sub_7', 'customer_id': 'ctm_1',
                'items': [{'price': {'id': 'pri_monthly'}}],
            },
        })

        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)

    def test_a_payment_failure_does_not_cut_access_off(self):
        # Paddle retries a failed card for days. Revoking on the first failure locks out
        # customers whose second attempt succeeds.
        activate_account(self.account, plan_type=Account.MONTHLY)
        self.post({
            'event_id': 'evt_pastdue',
            'event_type': 'subscription.past_due',
            'data': {'id': 'sub_1', 'customer_id': 'ctm_1'},
        })
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)


class AdminSubscriptionControlTests(TestCase):
    """The superadmin's manual levers for cash and Whish sales."""

    def setUp(self):
        self.admin = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        self.client = Client()
        self.client.force_login(self.admin)
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )

    def run_action(self, action):
        return self.client.post(
            '/admin/accounts/account/',
            {'action': action, '_selected_action': [str(self.account.pk)]},
            follow=True,
        )

    def test_activating_sets_the_expiry_not_just_the_status(self):
        # The old bulk update wrote the status column and left expires_at null, producing an
        # account that reads active but computes as not live.
        self.run_action('activate_monthly')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertIsNotNone(self.account.expires_at)
        self.assertTrue(self.account.has_active_subscription)

    def test_annual_and_lifetime_activation(self):
        self.run_action('activate_annual')
        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.ANNUAL)

        self.run_action('activate_lifetime')
        self.account.refresh_from_db()
        self.assertEqual(self.account.plan_type, Account.ONE_TIME)
        self.assertIsNone(self.account.expires_at)

    def test_resetting_a_trial_grants_a_fresh_full_term(self):
        self.account.trial_ends_at = timezone.now() - timedelta(days=30)
        self.account.save(update_fields=['trial_ends_at'])

        self.run_action('reset_trial')
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        self.assertEqual(self.account.trial_days_remaining, Account.TRIAL_DAYS)

    def test_extending_an_expired_trial_counts_from_now_not_the_old_date(self):
        self.account.subscription_status = Account.TRIALING
        self.account.trial_ends_at = timezone.now() - timedelta(days=30)
        self.account.save(update_fields=['subscription_status', 'trial_ends_at'])

        self.run_action('extend_trial')
        self.account.refresh_from_db()
        self.assertTrue(self.account.has_active_subscription)
        self.assertEqual(self.account.trial_days_remaining, Account.TRIAL_DAYS)

    def test_extending_a_running_trial_adds_to_what_is_left(self):
        start_trial(self.account, days=3)
        self.run_action('extend_trial')
        self.account.refresh_from_db()
        self.assertEqual(self.account.trial_days_remaining, 3 + Account.TRIAL_DAYS)

    def test_revoking_locks_the_account_out_immediately(self):
        activate_account(self.account, plan_type=Account.ANNUAL)
        self.run_action('revoke_subscription')

        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.CANCELED)
        self.assertFalse(self.account.has_active_subscription)
        # Both clocks cleared, or a leftover date would keep serving a chargeback.
        self.assertIsNone(self.account.expires_at)
        self.assertIsNone(self.account.trial_ends_at)

    def test_the_webhook_ledger_is_read_only(self):
        ProcessedWebhookEvent.objects.create(event_id='evt_1', event_type='x')
        response = self.client.get('/admin/accounts/processedwebhookevent/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.client.get('/admin/accounts/processedwebhookevent/add/').status_code, 403,
        )


class AdminPermissionBoundaryTests(TestCase):
    """
    Only a platform superadmin may hand out or take away paid access.

    Staff-but-not-superuser is the role this guards against. CLAUDE.md says only superadmins
    should ever have is_staff, but "should" is not a constraint the database enforces, and a
    group grant is one click away.
    """

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        # Staff with every model permission there is — the strongest non-superuser possible.
        self.staff = User.objects.create_user(
            username='staff', email='staff@example.com', password='pw-12345', is_staff=True,
        )
        self.staff.user_permissions.set(Permission.objects.all())
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        self.key = DiscountKey.objects.create(code=generate_code())

    def client_for(self, user):
        client = Client()
        client.force_login(user)
        return client

    # --- discount keys ------------------------------------------------------------------

    def test_a_superuser_can_reach_the_discount_key_admin(self):
        client = self.client_for(self.superuser)
        self.assertEqual(client.get('/admin/accounts/discountkey/').status_code, 200)
        self.assertEqual(client.get('/admin/accounts/discountkey/add/').status_code, 200)

    def test_staff_cannot_reach_the_discount_key_admin_even_with_every_permission(self):
        client = self.client_for(self.staff)
        for path in (
            '/admin/accounts/discountkey/',
            '/admin/accounts/discountkey/add/',
            f'/admin/accounts/discountkey/{self.key.pk}/change/',
            '/admin/accounts/discountkeyredemption/',
            '/admin/accounts/processedwebhookevent/',
        ):
            self.assertIn(client.get(path).status_code, (302, 403), path)

    def test_the_key_sections_are_absent_from_a_staff_users_admin_index(self):
        # has_module_permission, not just the per-object checks: a section that renders and
        # then 403s on every link reads as a broken admin rather than a boundary.
        body = self.client_for(self.staff).get('/admin/').content.decode()
        self.assertNotIn('/admin/accounts/discountkey/', body)
        self.assertIn('/admin/accounts/discountkey/', 
                      self.client_for(self.superuser).get('/admin/').content.decode())

    # --- account subscription overrides -------------------------------------------------

    def test_staff_can_no_longer_look_an_account_up(self):
        # Reversed deliberately. This used to allow it — name and phone read as ordinary
        # support data — but SuperuserOnlyAdminSite now closes /admin/ to every
        # non-superuser, and a customer lookup is not worth a hole in that. Support reads
        # accounts through the API or a shell, not through a site that also exposes every
        # other account's business data.
        client = self.client_for(self.staff)
        self.assertEqual(client.get('/admin/accounts/account/').status_code, 302)

    def test_staff_get_no_subscription_actions(self):
        # Asked of the ModelAdmin rather than over HTTP: the site now bounces staff before
        # any view runs, so an HTTP assertion here would pass against an empty redirect body
        # and stop testing get_actions at all. This gate is the layer underneath the site —
        # it is what still holds if the site check is ever loosened.
        admin_instance = admin.site._registry[Account]
        request = RequestFactory().get('/')
        request.user = self.staff
        actions = admin_instance.get_actions(request)
        for action in ('activate_monthly', 'activate_annual', 'revoke_subscription'):
            self.assertNotIn(action, actions, action)

    def test_a_superuser_gets_every_subscription_action(self):
        body = self.client_for(self.superuser).get('/admin/accounts/account/').content.decode()
        for action in (
            'activate_monthly', 'activate_annual', 'activate_lifetime', 'extend_trial',
            'reset_trial', 'revoke_subscription',
        ):
            self.assertIn(f'value="{action}"', body, action)

    def test_a_staff_post_to_an_admin_action_never_reaches_the_view(self):
        # The site-level check runs before dispatch, so the POST is a redirect to the SPA,
        # not a filtered action list. Distinct from
        # test_a_staff_post_cannot_run_a_revoke_it_cannot_see below, which pins the
        # ModelAdmin gate underneath it.
        activate_account(self.account, plan_type=Account.ANNUAL)
        response = self.client_for(self.staff).post(
            '/admin/accounts/account/',
            {'action': 'revoke_subscription', '_selected_action': [str(self.account.pk)]},
        )
        self.assertEqual(response.status_code, 302)
        self.account.refresh_from_db()
        self.assertTrue(self.account.has_active_subscription)

    def test_staff_see_the_subscription_fields_read_only(self):
        admin_instance = admin.site._registry[Account]
        request = RequestFactory().get('/')
        request.user = self.staff
        readonly = admin_instance.get_readonly_fields(request, self.account)
        for field in ('subscription_status', 'plan_type', 'expires_at', 'trial_ends_at'):
            self.assertIn(field, readonly, field)

    def test_a_superuser_can_edit_the_subscription_fields(self):
        admin_instance = admin.site._registry[Account]
        request = RequestFactory().get('/')
        request.user = self.superuser
        readonly = admin_instance.get_readonly_fields(request, self.account)
        for field in ('subscription_status', 'expires_at', 'trial_ends_at'):
            self.assertNotIn(field, readonly, field)

    def test_a_staff_post_cannot_run_a_revoke_it_cannot_see(self):
        # The action list is a UI affordance; get_actions is what actually gates the POST.
        activate_account(self.account, plan_type=Account.ANNUAL)
        self.client_for(self.staff).post(
            '/admin/accounts/account/',
            {'action': 'revoke_subscription', '_selected_action': [str(self.account.pk)]},
            follow=True,
        )
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertTrue(self.account.has_active_subscription)

    # --- badges --------------------------------------------------------------------------

    def test_the_live_badge_reports_the_computed_answer_not_the_column(self):
        # An 'active' row whose expiry has passed must read as not live, or the admin quietly
        # disagrees with what enforcement does.
        admin_instance = admin.site._registry[Account]
        self.account.subscription_status = Account.ACTIVE
        self.account.expires_at = timezone.now() - timedelta(days=1)

        self.assertIn('No', admin_instance.live_badge(self.account))
        self.account.expires_at = timezone.now() + timedelta(days=1)
        self.assertIn('Yes', admin_instance.live_badge(self.account))

    def test_an_account_with_no_plan_still_renders_a_badge(self):
        admin_instance = admin.site._registry[Account]
        self.assertIn('No plan', admin_instance.plan_badge(self.account))

    def test_badges_escape_what_they_render(self):
        # format_html, not an f-string: a business name is user input and reaches this column.
        self.assertIn('&lt;script&gt;', status_badge('<script>', 'grey'))


class RedeemKeyPayloadTests(TestCase):
    """The redemption response is what the SPA re-routes off, so its shape is load-bearing."""

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_a_valid_redemption_returns_a_live_account_payload(self):
        key = DiscountKey.objects.create(
            code=generate_code(), grants=DiscountKey.MONTHS, grant_months=3,
        )
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )

        self.assertEqual(response.status_code, 200)
        # Everything the SPA needs to decide "go to /" without a second round trip.
        self.assertEqual(response.data['subscription_status'], Account.ACTIVE)
        self.assertTrue(response.data['subscription_live'])
        self.assertEqual(response.data['plan_type'], Account.MONTHLY)
        self.assertIsNotNone(response.data['expires_at'])
        self.assertEqual(response.data['id'], self.account.id)

    def test_a_lifetime_key_returns_a_null_expiry_rather_than_omitting_it(self):
        key = DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )
        self.assertEqual(response.data['plan_type'], Account.ONE_TIME)
        self.assertIsNone(response.data['expires_at'])
        self.assertTrue(response.data['subscription_live'])

    def test_redemption_is_logged_for_reconciliation(self):
        key = DiscountKey.objects.create(
            code=generate_code(), grants=DiscountKey.MONTHS, grant_months=1,
            amount_paid_usd=15,
        )
        self.client.post('/billing/redeem-key/', {'code': key.code}, format='json')

        redemption = DiscountKeyRedemption.objects.get(key=key, account=self.account)
        self.assertIsNotNone(redemption.redeemed_at)
        key.refresh_from_db()
        self.assertEqual(key.redemption_count, 1)

    def test_an_expired_key_is_refused(self):
        key = DiscountKey.objects.create(
            code=generate_code(), expires_at=timezone.now() - timedelta(minutes=1),
        )
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.account.refresh_from_db()
        self.assertFalse(self.account.has_active_subscription)

    def test_an_exhausted_key_is_refused(self):
        key = DiscountKey.objects.create(
            code=generate_code(), max_redemptions=1, redemption_count=1,
        )
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )
        self.assertEqual(response.status_code, 400)

    def test_a_deactivated_key_is_refused(self):
        key = DiscountKey.objects.create(code=generate_code(), is_active=False)
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )
        self.assertEqual(response.status_code, 400)


class UnpaidWhitelistTests(TestCase):
    """
    The endpoints an expired account must still reach.

    Each one is the backend half of a screen on the frontend's unpaid whitelist. Miss any and
    the account is stranded with no route out except an admin editing the database.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.CANCELED,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_core_app_endpoints_are_blocked(self):
        for path in ('/inventory/products/', '/inventory/orders/', '/inventory/analytics/'):
            self.assertEqual(self.client.get(path).status_code, 403, path)

    def test_the_escape_hatches_are_open(self):
        for path in ('/accounts/subscription/', '/billing/config/', '/auth/users/me/'):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_redeeming_is_reachable_while_locked_out(self):
        key = DiscountKey.objects.create(code=generate_code(), grants=DiscountKey.LIFETIME)
        response = self.client.post(
            '/billing/redeem-key/', {'code': key.code}, format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['subscription_live'])

    def test_logging_out_is_reachable_while_locked_out(self):
        refresh = RefreshToken.for_user(self.user)
        client = APIClient()
        client.force_authenticate(self.user)
        response = client.post(
            '/auth/jwt/blacklist/', {'refresh': str(refresh)}, format='json',
        )
        # Not 403 — an account that cannot log out is an account that cannot switch users.
        self.assertNotEqual(response.status_code, 403)


class SubscriptionPayloadContractTests(TestCase):
    """
    The wire shape both /accounts/subscription/ and /auth/users/me/ commit to.

    Pinned as a contract because four separate frontend concerns read it — the router, the
    trial banner, the settings card and the plan screen — and a silently renamed field breaks
    all four in different, hard-to-trace ways.
    """

    EXPECTED_FIELDS = {
        'id', 'subscription_status', 'plan_type', 'expires_at', 'trial_ends_at',
        'subscription_live', 'is_trial', 'trial_days_remaining', 'payment_method',
        'registration_expires_at', 'registration_session_expired',
        'business_name', 'phone', 'email',
    }

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(name='Acme', phone='+961 70 000 000')
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_the_status_endpoint_returns_exactly_the_contract(self):
        response = self.client.get('/accounts/subscription/')
        self.assertEqual(set(response.data), self.EXPECTED_FIELDS)

    def test_users_me_carries_the_same_projection(self):
        activate_account(self.account, plan_type=Account.ANNUAL)
        response = self.client.get('/auth/users/me/')

        self.assertEqual(response.status_code, 200)
        self.assertIn('subscription', response.data)
        self.assertEqual(set(response.data['subscription']), self.EXPECTED_FIELDS)
        # Same projection, not a second one that can drift.
        self.assertEqual(
            response.data['subscription'],
            self.client.get('/accounts/subscription/').data,
        )

    def test_liveness_is_computed_not_read_from_the_column(self):
        activate_account(self.account, plan_type=Account.MONTHLY)
        self.account.expires_at = timezone.now() - timedelta(days=1)
        self.account.save(update_fields=['expires_at'])

        data = self.client.get('/accounts/subscription/').data
        # The stored column still says active; only the computed field tells the truth.
        self.assertEqual(data['subscription_status'], Account.ACTIVE)
        self.assertFalse(data['subscription_live'])

    def test_a_superadmin_gets_the_contract_with_nulls_not_an_error(self):
        admin_user = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        client = APIClient()
        client.force_authenticate(admin_user)

        for path in ('/accounts/subscription/', '/auth/users/me/'):
            response = client.get(path)
            payload = response.data.get('subscription', response.data)
            self.assertEqual(set(payload), self.EXPECTED_FIELDS, path)
            self.assertIsNone(payload['subscription_status'], path)
            # True, but from being the platform owner — not from a subscription.
            self.assertTrue(payload['subscription_live'], path)

    # --- payment_method -------------------------------------------------------------------

    def test_payment_method_reports_a_trial(self):
        start_trial(self.account)
        self.assertEqual(
            self.client.get('/accounts/subscription/').data['payment_method'], 'trial',
        )

    def test_payment_method_reports_a_card_once_the_webhook_has_written_ids(self):
        activate_account(self.account, plan_type=Account.MONTHLY)
        self.account.paddle_customer_id = 'ctm_1'
        self.account.save(update_fields=['paddle_customer_id'])
        self.assertEqual(
            self.client.get('/accounts/subscription/').data['payment_method'], 'card',
        )

    def test_payment_method_reports_manual_for_a_key_or_cash_activation(self):
        activate_account(self.account, plan_type=Account.ONE_TIME)
        self.assertEqual(
            self.client.get('/accounts/subscription/').data['payment_method'], 'manual',
        )

    def test_payment_method_is_blank_for_an_unpaid_account(self):
        self.assertEqual(self.client.get('/accounts/subscription/').data['payment_method'], '')


class AdminOverrideSyncTests(TestCase):
    """
    A superadmin's manual change must show up on the customer's next fetch.

    There is no cache and no denormalised copy of subscription state anywhere, which is what
    makes this hold — the test exists to keep it that way, because the obvious "optimisation"
    of caching this payload would silently break every admin override.
    """

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_PAYMENT,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)

        self.admin_client = Client()
        self.admin_client.force_login(self.superuser)

    def as_customer(self):
        """
        A client authenticated as a *freshly loaded* user.

        force_authenticate holds on to one User instance, and Django caches `user.membership`
        and that membership's `account` on it — so a second request through the same client
        reads the Account object from memory and never sees an admin's change. Real requests
        re-authenticate and re-query every time, so reusing the client here would be testing
        an artifact of the test client rather than the behaviour.
        """
        client = APIClient()
        client.force_authenticate(User.objects.get(pk=self.user.pk))
        return client

    def run_action(self, action):
        return self.admin_client.post(
            '/admin/accounts/account/',
            {'action': action, '_selected_action': [str(self.account.pk)]},
            follow=True,
        )

    def payload(self):
        return self.as_customer().get('/accounts/subscription/').data

    def test_activating_in_the_admin_shows_up_on_the_next_fetch(self):
        self.assertFalse(self.payload()['subscription_live'])

        self.run_action('activate_annual')

        after = self.payload()
        self.assertTrue(after['subscription_live'])
        self.assertEqual(after['subscription_status'], Account.ACTIVE)
        self.assertEqual(after['plan_type'], Account.ANNUAL)
        self.assertIsNotNone(after['expires_at'])

    def test_revoking_in_the_admin_locks_the_customer_out_on_the_next_fetch(self):
        self.run_action('activate_annual')
        self.assertTrue(self.payload()['subscription_live'])

        self.run_action('revoke_subscription')

        after = self.payload()
        self.assertFalse(after['subscription_live'])
        self.assertEqual(after['subscription_status'], Account.CANCELED)
        # And the app itself is closed, not just the badge.
        self.assertEqual(self.as_customer().get('/inventory/products/').status_code, 403)

    def test_extending_a_trial_in_the_admin_reopens_the_app(self):
        start_trial(self.account)
        self.account.trial_ends_at = timezone.now() - timedelta(days=1)
        self.account.save(update_fields=['trial_ends_at'])
        self.assertEqual(self.as_customer().get('/inventory/products/').status_code, 403)

        self.run_action('extend_trial')

        after = self.payload()
        self.assertTrue(after['subscription_live'])
        self.assertTrue(after['is_trial'])
        self.assertEqual(after['trial_days_remaining'], Account.TRIAL_DAYS)
        self.assertEqual(self.as_customer().get('/inventory/products/').status_code, 200)

    def test_a_hand_edited_expiry_takes_effect_immediately(self):
        # The admin form allows editing expires_at directly for a dated cash sale.
        activate_account(self.account, plan_type=Account.MONTHLY)
        self.assertTrue(self.payload()['subscription_live'])

        Account.objects.filter(pk=self.account.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        self.assertFalse(self.payload()['subscription_live'])
        self.assertEqual(self.as_customer().get('/inventory/products/').status_code, 403)
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
        with patch.object(EmailMultiAlternatives, 'send', side_effect=SMTPException('nope')):
            self.assertFalse(emails.send_password_reset_code(self.user, '123456'))

    def test_a_user_with_no_address_cannot_be_sent_one(self):
        self.user.email = ''
        self.user.save(update_fields=['email'])
        self.assertFalse(emails.send_password_reset_code(self.user, '123456'))


class SingleTrialPolicyTests(TestCase):
    """One free trial per account, latched on `has_used_trial`."""

    def setUp(self):
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_VERIFICATION,
        )

    def test_the_first_trial_latches_the_flag(self):
        self.assertFalse(self.account.has_used_trial)
        start_trial(self.account)
        self.account.refresh_from_db()
        self.assertTrue(self.account.has_used_trial)

    def test_a_second_trial_is_refused(self):
        start_trial(self.account)
        with self.assertRaises(TrialAlreadyUsed):
            start_trial(self.account)

    def test_a_refused_trial_changes_nothing(self):
        start_trial(self.account)
        activate_account(self.account, plan_type=Account.MONTHLY)
        before = self.account.trial_ends_at

        with self.assertRaises(TrialAlreadyUsed):
            start_trial(self.account)

        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.ACTIVE)
        self.assertEqual(self.account.trial_ends_at, before)

    def test_revoking_does_not_hand_back_a_trial(self):
        # revoke_subscription clears trial_ends_at, so the flag is the only thing standing
        # between a revoked account and a fresh fortnight.
        start_trial(self.account)
        Account.objects.filter(pk=self.account.pk).update(
            subscription_status=Account.CANCELED, expires_at=None, trial_ends_at=None,
        )
        self.account.refresh_from_db()

        self.assertTrue(self.account.has_used_trial)
        with self.assertRaises(TrialAlreadyUsed):
            start_trial(self.account)

    def test_force_is_the_deliberate_override(self):
        start_trial(self.account)
        start_trial(self.account, force=True)
        self.account.refresh_from_db()
        self.assertEqual(self.account.subscription_status, Account.TRIALING)
        self.assertTrue(self.account.has_active_subscription)


class SingleTrialOnboardingTests(TestCase):
    """The policy as the signup and verification flow sees it."""

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(
            name='Acme', subscription_status=Account.PENDING_VERIFICATION,
        )
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def test_verifying_starts_the_one_trial(self):
        _, code = verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(response.data['subscription_status'], Account.TRIALING)
        self.account.refresh_from_db()
        self.assertTrue(self.account.has_used_trial)

    def test_re_verifying_a_spent_trial_lands_on_the_paywall_not_a_500(self):
        # An admin can put an account back to pending_verification. That must not 500, and
        # must not hand out a second free fortnight.
        self.account.has_used_trial = True
        self.account.save(update_fields=['has_used_trial'])

        _, code = verification.issue_code(self.user)
        response = self.client.post('/accounts/verify-email/', {'code': code}, format='json')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['subscription_status'], Account.PENDING_PAYMENT)
        self.account.refresh_from_db()
        self.assertFalse(self.account.has_active_subscription)

    def test_signup_leaves_the_flag_clear_until_verification(self):
        # The clock is stamped at signup but the trial has not been *taken* yet — latching
        # here would deny the trial to anyone who verified a day later.
        response = APIClient().post('/auth/users/', {
            'email': 'new@example.com', 'password': 'sup3r-s3cret-pw',
            'phone': '+961 70 111 222', 'business_name': 'New Co',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)

        account = Account.objects.get(name='New Co')
        self.assertFalse(account.has_used_trial)
        self.assertIsNotNone(account.trial_ends_at)


# Django forces DEBUG=False under the test runner, and crypto.get_fernet() refuses to fall
# back to a SECRET_KEY-derived key in that case — deliberately, so production cannot store
# records under a key that vanishes when SECRET_KEY rotates. Tests therefore supply their own.
TEST_FERNET_KEY = Fernet.generate_key().decode()


@override_settings(PAYMENT_ENCRYPTION_KEY=TEST_FERNET_KEY)
class PaymentRecordEncryptionTests(TestCase):
    """Fernet field encryption for UserPaymentRecord."""

    def setUp(self):
        self.account = Account.objects.create(name='Acme')

    def test_details_round_trip(self):
        record = UserPaymentRecord.objects.create(
            account=self.account, method=UserPaymentRecord.WHISH, amount_usd=15,
        )
        record.details = 'Whish ref 88213, paid in the shop'
        record.save()

        reloaded = UserPaymentRecord.objects.get(pk=record.pk)
        self.assertEqual(reloaded.details, 'Whish ref 88213, paid in the shop')

    def test_the_plaintext_is_not_in_the_column(self):
        record = UserPaymentRecord.objects.create(account=self.account)
        record.details = 'Whish ref 88213'
        record.save()

        raw = bytes(UserPaymentRecord.objects.get(pk=record.pk).encrypted_details)
        self.assertNotIn(b'88213', raw)
        self.assertNotIn(b'Whish', raw)
        self.assertTrue(raw.startswith(b'gAAAAA'))  # Fernet's version byte, base64-encoded

    def test_empty_details_stay_empty_rather_than_encrypting_nothing(self):
        record = UserPaymentRecord.objects.create(account=self.account)
        record.details = ''
        record.save()
        self.assertEqual(bytes(record.encrypted_details), b'')
        self.assertEqual(UserPaymentRecord.objects.get(pk=record.pk).details, '')

    def test_two_writes_of_the_same_text_differ(self):
        # Fernet includes a random IV, so identical notes must not produce identical
        # ciphertext — otherwise the column leaks which accounts paid the same way.
        first = UserPaymentRecord.objects.create(account=self.account)
        first.details = 'cash'
        first.save()
        second = UserPaymentRecord.objects.create(account=self.account)
        second.details = 'cash'
        second.save()
        self.assertNotEqual(bytes(first.encrypted_details), bytes(second.encrypted_details))

    def test_a_wrong_key_reports_rather_than_raising(self):
        # One unreadable row must not 500 a changelist showing fifty.
        record = UserPaymentRecord.objects.create(account=self.account)
        record.details = 'secret'
        record.save()

        other_key = Fernet.generate_key().decode()
        with override_settings(PAYMENT_ENCRYPTION_KEY=other_key):
            self.assertEqual(
                UserPaymentRecord.objects.get(pk=record.pk).details, UNREADABLE,
            )

    def test_a_configured_key_is_used_over_the_debug_fallback(self):
        key = Fernet.generate_key().decode()
        with override_settings(PAYMENT_ENCRYPTION_KEY=key):
            token = encrypt_text('hello')
        self.assertEqual(Fernet(key.encode()).decrypt(token).decode(), 'hello')

    @override_settings(PAYMENT_ENCRYPTION_KEY='not-a-valid-fernet-key')
    def test_a_malformed_key_fails_loudly(self):
        with self.assertRaises(ImproperlyConfigured):
            encrypt_text('hello')

    @override_settings(PAYMENT_ENCRYPTION_KEY='', DEBUG=False)
    def test_production_refuses_to_store_without_a_key(self):
        # Never silently fall back to a SECRET_KEY-derived key in production: rotating
        # SECRET_KEY would then destroy every record at once with no error to trace it to.
        with self.assertRaises(ImproperlyConfigured):
            encrypt_text('hello')


@override_settings(PAYMENT_ENCRYPTION_KEY=TEST_FERNET_KEY)
class PaymentRecordAdminTests(TestCase):
    """Only superusers may read the payment log."""

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        self.staff = User.objects.create_user(
            username='staff', email='staff@example.com', password='pw-12345', is_staff=True,
        )
        self.staff.user_permissions.set(Permission.objects.all())
        self.account = Account.objects.create(name='Acme')
        self.record = UserPaymentRecord.objects.create(account=self.account)
        self.record.details = 'Whish ref 88213'
        self.record.save()

    def client_for(self, user):
        client = Client()
        client.force_login(user)
        return client

    def test_a_superuser_can_reach_the_payment_log(self):
        client = self.client_for(self.superuser)
        self.assertEqual(client.get('/admin/accounts/userpaymentrecord/').status_code, 200)
        self.assertEqual(
            client.get(f'/admin/accounts/userpaymentrecord/{self.record.pk}/change/')
            .status_code,
            200,
        )

    def test_staff_cannot_reach_it_even_with_every_permission(self):
        client = self.client_for(self.staff)
        for path in (
            '/admin/accounts/userpaymentrecord/',
            f'/admin/accounts/userpaymentrecord/{self.record.pk}/change/',
            '/admin/accounts/userpaymentrecord/add/',
        ):
            self.assertIn(client.get(path).status_code, (302, 403), path)

    def test_the_changelist_does_not_print_the_decrypted_note(self):
        # A list view is what gets left open on a shared screen.
        body = self.client_for(self.superuser).get(
            '/admin/accounts/userpaymentrecord/',
        ).content.decode()
        self.assertNotIn('88213', body)
        self.assertIn('Encrypted', body)

    def test_the_change_form_shows_the_decrypted_note(self):
        body = self.client_for(self.superuser).get(
            f'/admin/accounts/userpaymentrecord/{self.record.pk}/change/',
        ).content.decode()
        self.assertIn('88213', body)

    def test_saving_through_the_admin_form_encrypts(self):
        self.client_for(self.superuser).post(
            f'/admin/accounts/userpaymentrecord/{self.record.pk}/change/',
            {
                'account': str(self.account.pk),
                'method': UserPaymentRecord.CASH,
                'amount_usd': '20.00',
                'reference': 'R-1',
                'details': 'cash handed over at the counter',
            },
            follow=True,
        )
        self.record.refresh_from_db()
        self.assertEqual(self.record.details, 'cash handed over at the counter')
        self.assertNotIn(b'counter', bytes(self.record.encrypted_details))


class UserAdminPasswordTests(TestCase):
    """Superadmins can set a user's password; staff cannot."""

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        self.staff = User.objects.create_user(
            username='staff', email='staff@example.com', password='pw-12345', is_staff=True,
        )
        self.staff.user_permissions.set(Permission.objects.all())
        self.target = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='old-pw-12345',
        )

    def client_for(self, user):
        client = Client()
        client.force_login(user)
        return client

    def test_a_superuser_can_set_a_password(self):
        client = self.client_for(self.superuser)
        url = f'/admin/auth/user/{self.target.pk}/password/'
        self.assertEqual(client.get(url).status_code, 200)

        client.post(
            url, {'password1': 'brand-new-pw-99', 'password2': 'brand-new-pw-99'}, follow=True,
        )
        self.target.refresh_from_db()
        self.assertTrue(self.target.check_password('brand-new-pw-99'))

    def test_staff_cannot_set_another_users_password(self):
        # Setting a password is a full account takeover, so it is superuser-only regardless
        # of what model permissions a group hands out.
        client = self.client_for(self.staff)
        response = client.post(
            f'/admin/auth/user/{self.target.pk}/password/',
            {'password1': 'attacker-pw-99', 'password2': 'attacker-pw-99'},
            follow=True,
        )
        self.assertIn(response.status_code, (200, 302, 403))
        self.target.refresh_from_db()
        self.assertTrue(self.target.check_password('old-pw-12345'))

    def test_the_user_page_shows_which_account_they_belong_to(self):
        account = Account.objects.create(name='Corner Shop')
        Membership.objects.create(user=self.target, account=account, is_owner=True)
        body = self.client_for(self.superuser).get('/admin/auth/user/').content.decode()
        self.assertIn('Corner Shop', body)


class EmailConfigTests(TestCase):
    """The settings-level bug that stopped verification codes from sending."""

    def test_use_tls_accepts_the_spellings_people_actually_write(self):
        # `os.environ.get(...) == 'True'` read every one of these as False, which attempts
        # port 587 in the clear and fails every send with nothing in the UI to say so.
        from ims.settings import _env_flag

        for value in ('true', 'True', 'TRUE', '1', 'yes', 'on', ' true '):
            with patch.dict('os.environ', {'EMAIL_USE_TLS': value}):
                self.assertTrue(_env_flag('EMAIL_USE_TLS'), value)

    def test_falsey_spellings_stay_false(self):
        from ims.settings import _env_flag

        for value in ('false', 'False', '0', 'no', 'off', ''):
            with patch.dict('os.environ', {'EMAIL_USE_TLS': value}):
                self.assertFalse(_env_flag('EMAIL_USE_TLS'), value)

    def test_a_send_timeout_is_configured(self):
        # The send runs inline on the request thread; without a timeout a wedged SMTP server
        # holds signup open until the dyno kills it.
        from django.conf import settings as django_settings

        self.assertTrue(getattr(django_settings, 'EMAIL_TIMEOUT', None))

    def test_a_failed_send_is_logged_and_reported_not_swallowed(self):
        user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        with patch.object(EmailMultiAlternatives, 'send', side_effect=SMTPException('boom')):
            with self.assertLogs('accounts.emails', level='ERROR') as captured:
                sent = emails.send_verification_code(user, '123456')

        self.assertFalse(sent)
        self.assertTrue(any('Failed to send' in line for line in captured.output))


class SendTestEmailCommandTests(TestCase):
    """The diagnostic command operators reach for when codes stop arriving."""

    def run_command(self, *args, **kwargs):
        out, err = StringIO(), StringIO()
        call_command('send_test_email', *args, stdout=out, stderr=err, **kwargs)
        return out.getvalue(), err.getvalue()

    @override_settings(
        EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
        DEFAULT_FROM_EMAIL='support@example.com',
    )
    def test_a_working_backend_reports_success_and_actually_sends(self):
        out, _ = self.run_command('owner@example.com')
        self.assertIn('Sent.', out)
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].from_email, 'support@example.com')
        self.assertEqual(mail.outbox[0].to, ['owner@example.com'])

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
    def test_it_warns_that_a_non_smtp_backend_delivers_nothing(self):
        # The silent-success trap: locmem and console accept everything and deliver none of
        # it, so a "working" send proves nothing about production.
        out, _ = self.run_command('owner@example.com', show_config=True)
        self.assertIn('nothing will actually be delivered', out)

    @override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
    def test_the_config_dump_masks_the_password(self):
        with override_settings(EMAIL_HOST_PASSWORD='xsmtpsib-supersecret-value-here'):
            out, _ = self.run_command('owner@example.com', show_config=True)
        self.assertNotIn('supersecret', out)
        self.assertIn('EMAIL_HOST_PASSWORD', out)

    def test_an_smtp_rejection_becomes_a_command_error_with_a_hint(self):
        # 525 reads like a credential problem and is not one — it is Brevo's IP allowlist.
        # The mapped hint is what stops the next operator rotating a perfectly good SMTP key.
        error = smtplib.SMTPAuthenticationError(525, b'5.7.1 Unauthorized IP address')
        with patch(
            'accounts.management.commands.send_test_email.send_verification_code',
            side_effect=error,
        ):
            with self.assertRaises(CommandError):
                self.run_command('owner@example.com')

    def test_a_zero_send_without_an_exception_is_still_a_failure(self):
        # send_mail returning 0 means nothing left the process, which a bare "no exception"
        # check would read as success.
        with patch(
            'accounts.management.commands.send_test_email.send_verification_code',
            return_value=False,
        ):
            with self.assertRaises(CommandError):
                self.run_command('owner@example.com')


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class HtmlEmailTests(TestCase):
    """
    Both bodies, every time.

    A single-part HTML mail with no plain-text alternative is one of the oldest spam signals
    there is, so the multipart structure is asserted rather than assumed.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            username='owner@example.com', email='owner@example.com', password='pw-12345',
        )
        self.account = Account.objects.create(name='Corner Shop')
        Membership.objects.create(user=self.user, account=self.account, is_owner=True)

    def sent(self):
        self.assertEqual(len(mail.outbox), 1)
        return mail.outbox[0]

    def html_of(self, message):
        alternatives = {mimetype: body for body, mimetype in message.alternatives}
        self.assertIn('text/html', alternatives)
        return alternatives['text/html']

    # --- structure ------------------------------------------------------------------------

    def test_a_verification_email_carries_both_bodies(self):
        emails.send_verification_code(self.user, '123456')
        message = self.sent()

        # The text part is the real content, not a "please enable HTML" stub — worth as
        # little to a filter as it is to someone reading on a watch.
        self.assertIn('123456', message.body)
        self.assertIn('Confirm your email address', message.body)
        self.assertIn('123456', self.html_of(message))

    def test_a_password_reset_email_carries_both_bodies(self):
        emails.send_password_reset_code(self.user, '654321')
        message = self.sent()
        self.assertIn('654321', message.body)
        self.assertIn('654321', self.html_of(message))
        self.assertIn('Reset your password', message.body)

    def test_the_html_part_is_declared_as_html(self):
        emails.send_verification_code(self.user, '123456')
        self.assertEqual(self.sent().alternatives[0][1], 'text/html')

    # --- headers --------------------------------------------------------------------------

    def test_the_from_header_carries_a_display_name(self):
        with override_settings(DEFAULT_FROM_EMAIL='IMS Support <support@example.com>'):
            emails.send_verification_code(self.user, '123456')
        self.assertEqual(self.sent().from_email, 'IMS Support <support@example.com>')

    def test_subjects_are_branded_and_distinct(self):
        emails.send_verification_code(self.user, '123456')
        emails.send_password_reset_code(self.user, '654321')

        verification_subject, reset_subject = (m.subject for m in mail.outbox)
        self.assertTrue(verification_subject.startswith('[IMS] '))
        self.assertTrue(reset_subject.startswith('[IMS] '))
        # Distinct, or the two land in one Gmail thread and the reader opens the wrong code.
        self.assertNotEqual(verification_subject, reset_subject)

    # --- rendering ------------------------------------------------------------------------

    def test_the_html_names_the_business_and_the_expiry(self):
        emails.send_verification_code(self.user, '123456')
        html = self.html_of(self.sent())
        self.assertIn('Corner Shop', html)
        self.assertIn('Valid for 10 minutes', html)

    def test_an_account_less_user_still_renders(self):
        # Superadmins and half-provisioned users have no membership; the template must not
        # render "None's IMS account".
        orphan = User.objects.create_user(
            username='orphan@example.com', email='orphan@example.com', password='pw-12345',
        )
        emails.send_verification_code(orphan, '123456')
        html = self.html_of(self.sent())
        # No possessive dangling off nothing, and no literal "None".
        self.assertNotIn('None', html)
        self.assertNotIn('&rsquo;s IMS', html)
        self.assertIn('automated message from IMS', html)

    def test_the_expiry_line_is_singular_at_one_minute(self):
        with patch.object(verification, 'CODE_TTL', timedelta(minutes=1)):
            emails.send_verification_code(self.user, '123456')
        self.assertIn('Valid for 1 minute.', self.html_of(self.sent()))

    def test_the_html_has_no_remote_content(self):
        # A code email that fetches remote images shows "images not displayed" warnings,
        # adds filter weight, and delays the one thing the reader wants.
        emails.send_verification_code(self.user, '123456')
        html = self.html_of(self.sent())
        self.assertNotIn('<img', html.lower())
        self.assertNotIn('http://', html)
        self.assertNotIn('https://', html)

    def test_the_html_uses_inline_styles_not_a_style_block(self):
        # Outlook renders through Word, which drops <style> blocks entirely.
        emails.send_verification_code(self.user, '123456')
        html = self.html_of(self.sent())
        self.assertNotIn('<style', html.lower())
        self.assertIn('style="', html)

    def test_the_preheader_is_hidden_but_present(self):
        emails.send_verification_code(self.user, '123456')
        html = self.html_of(self.sent())
        self.assertIn('mso-hide:all', html)
        self.assertIn('Your IMS verification code', html)

    def test_the_code_is_escaped_like_any_other_context(self):
        emails.send_verification_code(self.user, '<script>x</script>')
        self.assertNotIn('<script>', self.html_of(self.sent()))


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class SendTestEmailTemplateTests(TestCase):
    """The CLI probe must send what users actually get, or it proves the wrong half."""

    def test_the_probe_sends_the_real_template(self):
        out = StringIO()
        call_command('send_test_email', 'someone@example.com', stdout=out, stderr=StringIO())

        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual(message.subject, '[IMS] Your verification code')
        self.assertIn('123456', message.body)
        self.assertIn('123456', message.alternatives[0][0])
        self.assertEqual(message.alternatives[0][1], 'text/html')

    def test_the_sample_code_is_overridable(self):
        call_command(
            'send_test_email', 'someone@example.com', code='999111',
            stdout=StringIO(), stderr=StringIO(),
        )
        self.assertIn('999111', mail.outbox[0].body)

    def test_the_probe_writes_no_user_row(self):
        # A diagnostic that writes to the database is one nobody runs against production.
        before = User.objects.count()
        call_command('send_test_email', 'someone@example.com', stdout=StringIO(), stderr=StringIO())
        self.assertEqual(User.objects.count(), before)


class RegistrationSessionTests(TestCase):
    """
    The lifetime rules for an unverified sign-up, tested against the module rather than
    through HTTP — the destructive half of this feature deserves its guard tested directly.
    """

    def make_pending(self, *, email='pending@example.com', minutes_left=30):
        user = User.objects.create_user(
            username=email, email=email, password='pw-12345',
        )
        account = Account.objects.create(
            name='Pending Shop',
            subscription_status=Account.PENDING_VERIFICATION,
            trial_ends_at=timezone.now() + timedelta(days=Account.TRIAL_DAYS),
            registration_expires_at=timezone.now() + timedelta(minutes=minutes_left),
        )
        Membership.objects.create(user=user, account=account, is_owner=True)
        return user, account

    def test_the_session_window_is_an_hour(self):
        # Pinned rather than left implicit: it has to stay above the resend budget in
        # accounts.verification, or a user is cut off with codes still owed to them.
        self.assertEqual(registration.REGISTRATION_SESSION_TTL, timedelta(minutes=60))
        self.assertGreater(
            registration.REGISTRATION_SESSION_TTL,
            verification.CODE_TTL * verification.MAX_SENDS_PER_HOUR / 2,
        )

    def test_a_fresh_registration_is_live(self):
        _, account = self.make_pending()
        self.assertTrue(registration.is_pending_registration(account))
        self.assertFalse(registration.is_expired(account))
        self.assertFalse(account.registration_session_expired)

    def test_an_elapsed_registration_reads_expired(self):
        _, account = self.make_pending(minutes_left=-1)
        self.assertTrue(registration.is_expired(account))
        self.assertTrue(account.registration_session_expired)

    def test_a_verified_account_is_never_a_pending_registration(self):
        # The timestamp is cleared at verification, and that is what makes the hard delete
        # safe forever after.
        _, account = self.make_pending(minutes_left=-1)
        account.registration_expires_at = None
        account.subscription_status = Account.TRIALING
        account.save()

        self.assertFalse(registration.is_pending_registration(account))
        self.assertFalse(registration.is_expired(account))
        self.assertFalse(account.registration_session_expired)

    def test_an_admin_reset_to_pending_verification_is_not_swept(self):
        """
        The failure this whole design is shaped around.

        An admin can put a real, paying customer back to pending_verification. If the
        deadline were derived from created_at, that account would read as an hour-old
        registration and be deleted along with the customer's login.
        """
        _, account = self.make_pending()
        account.registration_expires_at = None
        account.subscription_status = Account.ACTIVE
        account.save()
        activate_account(account, plan_type=Account.MONTHLY)

        account.subscription_status = Account.PENDING_VERIFICATION
        account.save(update_fields=['subscription_status'])

        self.assertFalse(registration.is_expired(account))
        with self.assertRaises(registration.NotDiscardable):
            registration.discard(account, reason='test')
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_discarding_removes_the_user_the_membership_and_the_account(self):
        user, account = self.make_pending()
        verification.issue_code(user)
        user_pk, account_pk = user.pk, account.pk

        registration.discard(account, reason='test')

        self.assertFalse(User.objects.filter(pk=user_pk).exists())
        self.assertFalse(Account.objects.filter(pk=account_pk).exists())
        self.assertFalse(Membership.objects.filter(account_id=account_pk).exists())
        # The outstanding code dies with its user, so an emailed code cannot outlive the
        # registration it was issued for.
        self.assertFalse(EmailVerification.objects.filter(user_id=user_pk).exists())

    def test_a_live_account_refuses_to_be_discarded(self):
        _, account = self.make_pending()
        account.subscription_status = Account.ACTIVE
        account.save(update_fields=['subscription_status'])

        with self.assertRaises(registration.NotDiscardable):
            registration.discard(account, reason='test')
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_billing_history_refuses_to_be_discarded(self):
        # Belt and braces over the status check: a row that has taken money is not a
        # registration whatever its status column says.
        _, account = self.make_pending()
        account.has_used_trial = True
        account.save(update_fields=['has_used_trial'])

        with self.assertRaises(registration.NotDiscardable):
            registration.discard(account, reason='test')

    def test_discard_if_expired_is_a_no_op_while_the_session_is_live(self):
        _, account = self.make_pending(minutes_left=30)
        self.assertFalse(registration.discard_if_expired(account))
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_discard_if_expired_closes_out_an_elapsed_session(self):
        _, account = self.make_pending(minutes_left=-1)
        self.assertTrue(registration.discard_if_expired(account))
        self.assertFalse(Account.objects.filter(pk=account.pk).exists())


@override_settings(EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend')
class RegistrationSessionEndpointTests(TestCase):
    """The sign-up session as a user meets it: verify, resend, and backing out."""

    SIGNUP = {
        'email': 'owner@example.com',
        'password': 'sTr0ng-pw-2026',
        'phone': '+961 70 123 456',
        'business_name': 'Corner Shop',
    }

    def setUp(self):
        # The abandon throttle is keyed on the client address, not the user, so its bucket
        # is shared by every test in this process. Clearing keeps one test from 429ing the
        # next for reasons that have nothing to do with what it asserts.
        cache.clear()
        self.client = APIClient()
        mail.outbox = []

    def signup(self, **overrides):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(
                '/auth/users/', {**self.SIGNUP, **overrides}, format='json',
            )

    def authed(self, user):
        client = APIClient()
        client.force_authenticate(User.objects.get(pk=user.pk))
        return client

    def register(self, **overrides):
        """Sign up and return (user, account, authenticated client, plaintext code)."""
        self.signup(**overrides)
        user = User.objects.get(email__iexact=overrides.get('email', self.SIGNUP['email']))
        account = user.membership.account
        return user, account, self.authed(user)

    def current_code(self, user):
        """
        The plaintext code, read out of the message that was actually sent.

        The database holds only an HMAC, so the email is the one place the plaintext exists —
        and it is the right place for a test to read it from anyway, since it is the code the
        user receives rather than one the test was handed. The hash comparison is what makes
        this an assertion and not just a convenience: the emailed code *is* the stored code.
        """
        message = next(sent for sent in reversed(mail.outbox) if sent.to == [user.email])
        found = re.search(r'\b(\d{6})\b', message.body)
        self.assertIsNotNone(found, 'no six-digit code in the message body')
        code = found.group(1)
        row = EmailVerification.objects.filter(user=user, consumed_at__isnull=True).first()
        self.assertEqual(verification.hash_code(code), row.code_hash)
        return code

    # --- the code itself ---------------------------------------------------------------

    def test_the_emailed_code_is_generated_not_fixed(self):
        """
        No fixed sample, no fallback: the code in the inbox is the one in the database, and
        it is drawn from `secrets`.
        """
        codes = set()
        for index in range(5):
            email = f'owner{index}@example.com'
            self.signup(email=email)
            user = User.objects.get(email=email)
            code = self.current_code(user)
            self.assertRegex(code, r'^\d{6}$')
            self.assertIn(code, mail.outbox[-1].body)
            codes.add(code)
        # Five identical codes would be a 1-in-10^24 accident, so this fails loudly if a
        # constant is ever reintroduced.
        self.assertGreater(len(codes), 1)

    def test_a_valid_code_verifies_and_is_consumed(self):
        user, account, client = self.register()
        code = self.current_code(user)

        response = client.post('/accounts/verify-email/', {'code': code}, format='json')

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['subscription_status'], Account.TRIALING)
        row = EmailVerification.objects.get(user=user)
        self.assertIsNotNone(row.consumed_at)
        # Spending it twice must not work, whatever the code says.
        again = client.post('/accounts/verify-email/', {'code': code}, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertEqual(again.data['code'], 'no_code')

    def test_verification_closes_the_session_for_good(self):
        user, account, client = self.register()
        client.post(
            '/accounts/verify-email/', {'code': self.current_code(user)}, format='json',
        )

        account.refresh_from_db()
        self.assertIsNone(account.registration_expires_at)
        self.assertFalse(account.is_pending_registration)

    # --- session expiry ------------------------------------------------------------------

    def test_signup_stamps_an_hour_long_session(self):
        _, account, _ = self.register()
        remaining = account.registration_expires_at - timezone.now()
        self.assertAlmostEqual(
            remaining.total_seconds(),
            registration.REGISTRATION_SESSION_TTL.total_seconds(),
            delta=30,
        )

    def expire_session(self, account):
        account.registration_expires_at = timezone.now() - timedelta(seconds=1)
        account.save(update_fields=['registration_expires_at'])

    def test_a_correct_code_is_refused_once_the_session_has_closed(self):
        user, account, client = self.register()
        code = self.current_code(user)
        self.expire_session(account)

        response = client.post('/accounts/verify-email/', {'code': code}, format='json')

        # 410, not 400: the account this request was about has been destroyed, which is a
        # different thing from a code that was mistyped.
        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.data['code'], 'registration_expired')
        self.assertIn('start the sign-up process again', response.data['detail'])
        self.assertFalse(User.objects.filter(pk=user.pk).exists())
        self.assertFalse(Account.objects.filter(pk=account.pk).exists())

    def test_resending_after_the_session_has_closed_discards_it_too(self):
        user, account, client = self.register()
        self.expire_session(account)
        mail.outbox = []

        response = client.post('/accounts/resend-code/')

        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.data['code'], 'registration_expired')
        # No new code goes out for an account that is being deleted in the same request.
        self.assertEqual(mail.outbox, [])
        self.assertFalse(Account.objects.filter(pk=account.pk).exists())

    def test_the_address_is_free_again_after_the_session_closes(self):
        """The point of hard-deleting: 'start over from scratch' has to actually work."""
        user, account, client = self.register()
        self.expire_session(account)
        client.post('/accounts/verify-email/', {'code': '000000'}, format='json')

        response = self.signup()

        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(User.objects.filter(email__iexact='owner@example.com').count(), 1)

    def test_an_expired_code_inside_a_live_session_is_recoverable(self):
        """
        A code that timed out is *not* an expired session. It asks for a new code and the
        sign-up carries on — collapsing the two would throw away a registration over a
        ten-minute-old email, which is the opposite of the intent.
        """
        user, account, client = self.register()
        code = self.current_code(user)
        EmailVerification.objects.filter(user=user).update(
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        response = client.post('/accounts/verify-email/', {'code': code}, format='json')

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['code'], 'code_expired')
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_the_status_payload_reports_the_session(self):
        user, account, client = self.register()

        live = client.get('/accounts/subscription/').data
        self.assertIsNotNone(live['registration_expires_at'])
        self.assertFalse(live['registration_session_expired'])

        self.expire_session(account)
        # Reading the status must not delete anything — only the endpoints that act on the
        # registration do that, or a poll would destroy the account under the screen.
        expired = self.authed(user).get('/accounts/subscription/').data
        self.assertTrue(expired['registration_session_expired'])
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    # --- back to sign up -----------------------------------------------------------------

    def test_abandoning_discards_the_registration(self):
        user, account, client = self.register()

        response = client.post('/accounts/abandon-registration/')

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(User.objects.filter(pk=user.pk).exists())
        self.assertFalse(Account.objects.filter(pk=account.pk).exists())

    def test_abandoning_frees_the_email_to_sign_up_again(self):
        # The typo case, which is the reason the button exists.
        _, _, client = self.register(email='typo@example.com')
        client.post('/accounts/abandon-registration/')

        response = self.signup(email='typo@example.com')

        self.assertEqual(response.status_code, 201, response.data)

    def test_abandoning_works_on_a_session_that_has_already_lapsed(self):
        user, account, client = self.register()
        self.expire_session(account)

        response = client.post('/accounts/abandon-registration/')

        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(Account.objects.filter(pk=account.pk).exists())

    def test_a_verified_account_cannot_be_abandoned(self):
        """
        The endpoint deletes accounts, so its guard is the security control. Being
        authenticated must never be enough to destroy an account that has been through
        verification.
        """
        user, account, client = self.register()
        client.post(
            '/accounts/verify-email/', {'code': self.current_code(user)}, format='json',
        )

        response = self.authed(user).post('/accounts/abandon-registration/')

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.data['code'], 'not_pending_registration')
        self.assertTrue(User.objects.filter(pk=user.pk).exists())
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_a_paying_account_cannot_be_abandoned(self):
        user, account, client = self.register()
        client.post(
            '/accounts/verify-email/', {'code': self.current_code(user)}, format='json',
        )
        account.refresh_from_db()
        activate_account(account, plan_type=Account.ANNUAL)

        response = self.authed(user).post('/accounts/abandon-registration/')

        self.assertEqual(response.status_code, 409)
        self.assertTrue(Account.objects.filter(pk=account.pk).exists())

    def test_abandoning_needs_authentication(self):
        response = APIClient().post('/accounts/abandon-registration/')
        self.assertEqual(response.status_code, 401)

    def test_one_account_cannot_abandon_another(self):
        """Scoping, stated as a test: the endpoint takes no id and reads only the caller's."""
        _, victim_account, _ = self.register(email='victim@example.com')
        _, _, attacker = self.register(email='attacker@example.com')

        attacker.post('/accounts/abandon-registration/')

        self.assertTrue(Account.objects.filter(pk=victim_account.pk).exists())


class PurgeExpiredRegistrationsCommandTests(TestCase):
    """Housekeeping for rows nobody comes back to. Enforcement lives in the endpoints."""

    def make(self, *, email, minutes_left, status=Account.PENDING_VERIFICATION, stamped=True):
        user = User.objects.create_user(username=email, email=email, password='pw-12345')
        account = Account.objects.create(
            name=email,
            subscription_status=status,
            registration_expires_at=(
                timezone.now() + timedelta(minutes=minutes_left) if stamped else None
            ),
        )
        Membership.objects.create(user=user, account=account, is_owner=True)
        return account

    def run_command(self, *args):
        out = StringIO()
        call_command('purge_expired_registrations', *args, stdout=out, stderr=StringIO())
        return out.getvalue()

    def test_it_discards_only_the_expired_registrations(self):
        stale = self.make(email='stale@example.com', minutes_left=-5)
        fresh = self.make(email='fresh@example.com', minutes_left=30)
        verified = self.make(
            email='paid@example.com', minutes_left=-500,
            status=Account.ACTIVE, stamped=False,
        )

        self.run_command()

        self.assertFalse(Account.objects.filter(pk=stale.pk).exists())
        self.assertTrue(Account.objects.filter(pk=fresh.pk).exists())
        self.assertTrue(Account.objects.filter(pk=verified.pk).exists())
        self.assertFalse(User.objects.filter(email='stale@example.com').exists())

    def test_dry_run_deletes_nothing(self):
        stale = self.make(email='stale@example.com', minutes_left=-5)

        output = self.run_command('--dry-run')

        self.assertIn('would discard', output)
        self.assertTrue(Account.objects.filter(pk=stale.pk).exists())

    def test_it_is_quiet_when_there_is_nothing_to_do(self):
        self.assertIn('No expired registrations', self.run_command())


class SuperuserOnlyAdminSiteTests(TestCase):
    """
    /admin/ is closed to everyone but active superusers.

    Django gates the admin on `is_staff`, which under this app's role model means "platform
    support", while the admin exposes every account's business data and the actions that
    decide what a customer has paid for. The site-level check is the boundary; the per-model
    gates in AdminPermissionBoundaryTests are the layer underneath it.
    """

    def setUp(self):
        self.superuser = User.objects.create_superuser(
            username='root', email='root@example.com', password='pw-12345',
        )
        self.staff = User.objects.create_user(
            username='staff', email='staff@example.com', password='pw-12345', is_staff=True,
        )
        # Every permission the permission system can express — the strongest possible
        # non-superuser. If this one is out, no staff configuration gets in.
        self.staff.user_permissions.set(Permission.objects.all())
        self.subscriber = User.objects.create_user(
            username='shop', email='shop@example.com', password='pw-12345',
        )

    def client_for(self, user):
        client = Client()
        client.force_login(user)
        return client

    def test_a_superuser_reaches_the_admin_index(self):
        self.assertEqual(self.client_for(self.superuser).get('/admin/').status_code, 200)

    def test_staff_are_turned_away_from_the_admin(self):
        response = self.client_for(self.staff).get('/admin/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, '/admin/login/?next=/admin/')

    def test_an_ordinary_subscriber_is_turned_away_from_the_admin(self):
        self.assertEqual(self.client_for(self.subscriber).get('/admin/').status_code, 302)

    def test_an_authenticated_non_superuser_lands_on_the_dashboard_not_a_login_form(self):
        # admin_view bounces to the login view; the login view sends an already-authenticated
        # caller to the SPA. Without the second hop a logged-in staff user is shown a login
        # form for the session they are already in, which reads as a loop rather than a
        # boundary. Asserted here rather than with follow=True so the assertion is about the
        # admin, not about whether the SPA bundle happens to be built in this checkout.
        for user in (self.staff, self.subscriber):
            with self.subTest(user=user.username):
                response = self.client_for(user).get('/admin/login/?next=/admin/')
                self.assertEqual(response.status_code, 302)
                self.assertEqual(response.url, '/')

    def test_a_deactivated_superuser_is_refused(self):
        self.superuser.is_active = False
        self.superuser.save()
        client = Client()
        client.force_login(self.superuser)
        self.assertEqual(client.get('/admin/').status_code, 302)

    def test_an_anonymous_visitor_still_gets_the_login_form(self):
        # Not redirected to the SPA — an anonymous caller may yet be a superuser who has not
        # logged in, and taking the form away would leave no way to reach the admin at all.
        response = Client().get('/admin/', follow=True)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'name="username"')

    def test_every_admin_url_is_closed_to_staff_not_just_the_index(self):
        # has_permission is what admin_view calls, so this holds for views added later too.
        # Sampled across an app index, a changelist, an add form and the password change.
        for path in (
            '/admin/accounts/',
            '/admin/accounts/account/',
            '/admin/inventory/product/',
            '/admin/inventory/product/add/',
            '/admin/auth/user/',
            '/admin/password_change/',
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client_for(self.staff).get(path).status_code, 302)

    def test_the_admin_site_class_is_the_restricted_one(self):
        # AdminConfig.default_site is read before autodiscover(), so every
        # admin.site.register in the codebase lands on this site. If the INSTALLED_APPS entry
        # is ever reverted to 'django.contrib.admin', nothing else in this class would
        # necessarily fail loudly — is_staff users would simply be let back in.
        from ims.admin_site import SuperuserOnlyAdminSite

        self.assertIsInstance(admin.site, SuperuserOnlyAdminSite)


class LockoutResponseTests(TestCase):
    """
    A lockout must not look like a wrong password.

    django-axes rejects in AxesStandaloneBackend, which sits *first* in
    AUTHENTICATION_BACKENDS — before credentials, before is_active, before anything the
    Django admin can toggle. With no AXES_LOCKOUT_CALLABLE configured the rejection came back
    as a bare 401, identical to a bad password, so a locked-out user was told to check
    credentials that were already correct and an admin flipping is_active saw no effect and
    no explanation. That is the whole defect: not that axes locks people out, which is the
    point of it, but that it did so silently.
    """

    LIMIT = settings.AXES_FAILURE_LIMIT

    def setUp(self):
        # axes keys its counters per username+IP; a stale counter from another test would
        # start this one already part-way to the limit.
        cache.clear()
        self.user = User.objects.create_user(
            username='locktarget@example.com', email='locktarget@example.com',
            password='correct-horse-battery',
        )
        self.client = APIClient()

    def tearDown(self):
        cache.clear()

    def fail_login(self, times):
        for _ in range(times):
            self.client.post(
                '/auth/jwt/create/',
                {'username': self.user.username, 'password': 'wrong-password'},
            )

    def attempt(self, password):
        return self.client.post(
            '/auth/jwt/create/', {'username': self.user.username, 'password': password},
        )

    def test_a_wrong_password_below_the_limit_is_a_plain_401(self):
        response = self.attempt('wrong-password')
        self.assertEqual(response.status_code, 401)
        self.assertNotEqual(response.json().get('code'), 'account_locked')

    def test_a_lockout_is_429_and_says_so(self):
        self.fail_login(self.LIMIT)
        response = self.attempt('correct-horse-battery')

        self.assertEqual(response.status_code, 429)
        body = response.json()
        self.assertEqual(body['code'], 'account_locked')
        self.assertIn('too many', body['detail'].lower())

    def test_the_lockout_response_carries_a_retry_after_header(self):
        # The correct HTTP semantic for "come back later", and what tells the caller how long
        # the cooloff actually is rather than making them guess.
        self.fail_login(self.LIMIT)
        response = self.attempt('correct-horse-battery')

        self.assertIn('Retry-After', response)
        self.assertEqual(int(response['Retry-After']), int(settings.AXES_COOLOFF_TIME * 3600))

    def test_a_locked_out_user_is_refused_even_with_the_right_password(self):
        # The behaviour itself is unchanged and must stay that way — this pins that making
        # the lockout visible did not make it toothless.
        self.fail_login(self.LIMIT)
        self.assertNotEqual(self.attempt('correct-horse-battery').status_code, 200)

    def test_activating_the_user_in_admin_does_not_lift_a_lockout(self):
        """
        The reported symptom, pinned as expected behaviour rather than fixed.

        Axes rejects before the credential check, so is_active is never consulted — toggling
        it cannot and should not clear a brute-force lockout. The fix is that the caller is
        now told this instead of being shown a password error.
        """
        self.fail_login(self.LIMIT)
        self.user.is_active = True
        self.user.save(update_fields=['is_active'])

        response = self.attempt('correct-horse-battery')
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json()['code'], 'account_locked')

    def test_axes_reset_username_clears_the_lockout(self):
        # The documented operator remedy. If this ever stops working there is no way back in
        # for a locked-out customer short of waiting out the cooloff.
        self.fail_login(self.LIMIT)
        self.assertEqual(self.attempt('correct-horse-battery').status_code, 429)

        call_command('axes_reset_username', self.user.username)
        self.assertEqual(self.attempt('correct-horse-battery').status_code, 200)


class SignupEmailFailureTests(TestCase):
    """
    A failing OTP email must leave a clean, usable account behind.

    Verified rather than changed: `UserCreateWithAccountSerializer.create` is already
    @transaction.atomic and already sends through transaction.on_commit, so the send happens
    after the rows are committed and cannot roll them back — and `emails._send_code` catches
    everything and returns False rather than raising. These tests exist because that is a
    designed behaviour nobody had pinned, and it is one refactor away from becoming an
    orphaned-row bug.
    """

    PAYLOAD = {
        'email': 'newsignup@example.com', 'password': 'sufficiently-long-pw-42',
        'phone': '+961 70 123 456', 'business_name': 'Test Shop',
    }

    def setUp(self):
        cache.clear()
        self.client = APIClient()

    def post_signup(self, **overrides):
        return self.client.post('/auth/users/', {**self.PAYLOAD, **overrides})

    def test_signup_succeeds_when_the_mail_server_is_unreachable(self):
        # The exact production failure: ConnectionRefusedError from smtplib because no mail
        # host was configured on the dyno.
        with patch(
            'accounts.emails.EmailMultiAlternatives.send',
            side_effect=ConnectionRefusedError(111, 'Connection refused'),
        ):
            response = self.post_signup()

        self.assertEqual(response.status_code, 201, response.content)

    def test_the_account_is_complete_and_usable_after_a_failed_send(self):
        with patch(
            'accounts.emails.EmailMultiAlternatives.send',
            side_effect=SMTPException('525 Unauthorized IP address'),
        ):
            self.post_signup()

        user = User.objects.get(username='newsignup@example.com')
        account = get_account(user)
        # Not a half-built row: the membership and the account both exist, so the user can
        # sign in and reach the verify screen to ask for another code.
        self.assertIsNotNone(account)
        self.assertEqual(account.subscription_status, Account.PENDING_VERIFICATION)
        self.assertIsNotNone(account.registration_expires_at)
        # And a code was issued, so a resend is a resend rather than a first send.
        self.assertTrue(
            EmailVerification.objects.filter(
                user=user, purpose=EmailVerification.EMAIL_VERIFICATION,
            ).exists()
        )

    def test_a_failed_send_does_not_block_re_registration(self):
        # The address must not end up permanently taken by a sign-up that never completed.
        # Abandoning it frees the address; that is the designed recovery, and the purge
        # command does the same thing on a timer.
        with patch(
            'accounts.emails.EmailMultiAlternatives.send',
            side_effect=SMTPException('525 Unauthorized IP address'),
        ):
            self.post_signup()

        user = User.objects.get(username='newsignup@example.com')
        registration.discard(get_account(user), reason='abandoned')

        self.assertFalse(User.objects.filter(username='newsignup@example.com').exists())
        with patch('accounts.emails.EmailMultiAlternatives.send', return_value=1):
            self.assertEqual(self.post_signup().status_code, 201)

    def test_a_signup_that_fails_after_the_user_row_leaves_nothing_behind(self):
        # The atomicity half. issue_code runs inside create()'s transaction, so a failure
        # there must take the user, account and membership with it.
        before = User.objects.count()
        with patch('accounts.serializers.issue_code', side_effect=RuntimeError('boom')):
            with self.assertRaises(RuntimeError):
                self.post_signup()

        self.assertEqual(User.objects.count(), before)
        self.assertFalse(Account.objects.filter(name='Test Shop').exists())
        self.assertFalse(Membership.objects.filter(user__username='newsignup@example.com').exists())
