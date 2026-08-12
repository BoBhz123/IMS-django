from datetime import timedelta

from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from djoser.serializers import UserCreateSerializer, UserSerializer
from rest_framework import serializers

from .emails import send_verification_code
from .models import Account, Membership, get_account
from .verification import issue_code


class UserCreateWithAccountSerializer(UserCreateSerializer):
    """
    Registration provisions the user's isolated workspace in the same transaction that
    creates the user — a half-provisioned user (no account) can authenticate but sees
    nothing and cannot be repaired without admin intervention.

    Deliberately a serializer override rather than a post_save signal on User: a signal
    would also fire for createsuperuser, giving platform admins a workspace they should not
    have. Provisioning belongs to the registration endpoint, not to user creation generally.

    `username` is derived from the email rather than collected. AUTH_USER_MODEL is not
    swapped — that is a now-or-never migration against live users, and nothing here needs it
    — so `username` remains the field simplejwt authenticates against, and the frontend
    simply posts the email into it at login.
    """

    email = serializers.EmailField(required=True, max_length=150)
    phone = serializers.CharField(required=True, max_length=32, write_only=True)
    business_name = serializers.CharField(
        required=False, allow_blank=True, write_only=True, max_length=255,
    )

    class Meta(UserCreateSerializer.Meta):
        model = User
        fields = ('id', 'email', 'password', 'phone', 'business_name')

    def validate_email(self, value):
        email = value.strip().lower()
        if len(email) > 150:
            # username is a 150-char column. Longer addresses are legal but effectively
            # nonexistent; failing loudly beats silently truncating someone's login.
            raise serializers.ValidationError('This email address is too long.')
        # The database has a case-insensitive unique index as the real backstop — two
        # concurrent posts can both pass this check. This exists so the normal case gets a
        # field error instead of a 500.
        if User.objects.filter(email__iexact=email).exists():
            raise serializers.ValidationError('An account with this email already exists.')
        return email

    def validate_phone(self, value):
        phone = ' '.join(value.split())
        Account._meta.get_field('phone').run_validators(phone)
        return phone

    def validate(self, attrs):
        # djoser's validate() runs `User(**attrs)` to feed Django's password validators, so
        # anything that is not a User column has to be lifted out for that call and put back
        # for create(). username is injected here because create_user() requires it.
        extras = {key: attrs.pop(key) for key in ('phone', 'business_name') if key in attrs}
        attrs['username'] = attrs['email']
        attrs = super().validate(attrs)
        attrs.update(extras)
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        phone = validated_data.pop('phone')
        business_name = (validated_data.pop('business_name', '') or '').strip()

        user = super().create(validated_data)
        account = Account.objects.create(
            name=business_name or user.email,
            phone=phone,
            # The trial clock starts at signup, but the status does *not*: the account stays
            # pending_verification until the emailed code is entered. Setting `trialing` here
            # would make the trial a way around email verification, since trialing grants
            # access. VerifyEmailView promotes it, and restamps the clock so nobody loses
            # trial days to a slow inbox.
            subscription_status=Account.PENDING_VERIFICATION,
            trial_ends_at=timezone.now() + timedelta(days=Account.TRIAL_DAYS),
        )
        Membership.objects.create(user=user, account=account, is_owner=True)

        _, code = issue_code(user)
        # on_commit, not inline: a send failure must not roll back a perfectly good account,
        # and the email must not go out if the transaction is about to fail. The user resends.
        transaction.on_commit(lambda: send_verification_code(user, code))
        return user


class VerifyEmailSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=12, trim_whitespace=True)


class PasswordResetConfirmSerializer(serializers.Serializer):
    """
    The code and the new password arrive together, deliberately.

    A three-screen flow invites a three-endpoint design where step two verifies the code and
    step three sets the password on the strength of being authenticated. That makes the code
    decorative: anyone holding a borrowed session skips to step three. Here the only endpoint
    that changes anything requires the code in the same request, so the decision is made once.

    `code` is required, so an omitted one is a 400 from the field rather than a reset that
    quietly succeeds.
    """

    code = serializers.CharField(max_length=12, trim_whitespace=True)
    new_password = serializers.CharField(write_only=True, trim_whitespace=False)
    confirm_password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        if attrs['new_password'] != attrs['confirm_password']:
            raise serializers.ValidationError(
                {'confirm_password': 'The two passwords do not match.'}
            )
        return attrs

    def validate_new_password(self, value):
        # Django's configured AUTH_PASSWORD_VALIDATORS, not a hand-rolled length check, so
        # this flow cannot become the one way into the app that accepts '12345'. The user is
        # passed so the similarity validator can do its job.
        try:
            validate_password(value, user=self.context.get('user'))
        except DjangoValidationError as error:
            raise serializers.ValidationError(list(error.messages))
        return value


class SubscriptionStatusSerializer(serializers.ModelSerializer):
    """
    Read-only projection of onboarding/billing state. The single source of truth for what the
    SPA knows about a subscription — the router, the trial banner, the settings card and the
    plan screen all read this one shape, so they cannot disagree with each other.

    `subscription_live` and `is_trial` are the *computed* properties, not the stored columns.
    That distinction is the whole design: nothing sweeps `subscription_status` on a schedule,
    so an `active` row whose `expires_at` has passed still reads `active` in the database.
    Anything branching on the bare status is wrong, including in the browser.
    """

    business_name = serializers.CharField(source='name', read_only=True)
    # Named for what enforcement actually asks. `has_active_subscription` is the model
    # property; `subscription_live` is the wire name, and the two are deliberately the same
    # value under different names rather than two independently computed answers.
    subscription_live = serializers.BooleanField(
        source='has_active_subscription', read_only=True,
    )
    is_trial = serializers.BooleanField(source='is_trialing', read_only=True)
    # Computed server-side so the banner counts down against the same clock the permission
    # class enforces. Sending trial_ends_at alone and subtracting in the browser would drift
    # with the device's system time — a wrong clock would show a trial as live when the API
    # has already stopped serving it.
    trial_days_remaining = serializers.IntegerField(read_only=True, allow_null=True)
    # 'card' | 'manual' | 'trial' | '' — inferred, see Account.payment_method.
    payment_method = serializers.CharField(read_only=True)
    email = serializers.SerializerMethodField()

    class Meta:
        model = Account
        fields = [
            'id', 'subscription_status', 'plan_type', 'expires_at', 'trial_ends_at',
            'subscription_live', 'is_trial', 'trial_days_remaining', 'payment_method',
            'business_name', 'phone', 'email',
        ]

    def get_email(self, account):
        membership = account.memberships.first()
        return membership.user.email if membership else ''


def subscription_payload(user):
    """
    The subscription projection for a user, including the no-account case.

    A superadmin has no Membership and neither does a user whose provisioning failed. Both
    must come back as "not a subscriber" rather than "unpaid" — reporting the platform owner
    as unpaid redirects them to a paywall for a subscription they were never meant to have.
    Shared by the status endpoint and the /auth/users/me/ payload so the two cannot drift.
    """
    account = get_account(user)
    if account is not None:
        return SubscriptionStatusSerializer(account).data
    return {
        'id': None,
        'subscription_status': None,
        'plan_type': '',
        'expires_at': None,
        'trial_ends_at': None,
        'subscription_live': bool(user.is_superuser),
        'is_trial': False,
        'trial_days_remaining': None,
        'payment_method': '',
        'business_name': '',
        'phone': '',
        'email': user.email,
    }


class UserWithSubscriptionSerializer(UserSerializer):
    """
    djoser's /auth/users/me/, plus the subscription state.

    Nested under one key rather than flattened onto the user: these are facts about the
    *account*, not the person, and flattening would collide `id` and `email` with the user's
    own. It reuses SubscriptionStatusSerializer rather than restating the fields, so there is
    exactly one definition of this payload in the codebase.
    """

    subscription = serializers.SerializerMethodField()

    class Meta(UserSerializer.Meta):
        fields = tuple(UserSerializer.Meta.fields) + ('subscription',)

    def get_subscription(self, user):
        return subscription_payload(user)
