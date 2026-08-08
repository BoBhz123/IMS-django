from django.db import transaction
from djoser.serializers import UserCreateSerializer
from rest_framework import serializers

from .models import Account, Membership


class UserCreateWithAccountSerializer(UserCreateSerializer):
    """
    Registration provisions the user's isolated workspace in the same transaction that
    creates the user — a half-provisioned user (no account) can authenticate but sees
    nothing and cannot be repaired without admin intervention.

    Deliberately a serializer override rather than a post_save signal on User: a signal
    would also fire for createsuperuser, giving platform admins a workspace they should not
    have. Provisioning belongs to the registration endpoint, not to user creation generally.
    """

    business_name = serializers.CharField(
        required=False, allow_blank=True, write_only=True, max_length=255,
    )

    class Meta(UserCreateSerializer.Meta):
        fields = tuple(UserCreateSerializer.Meta.fields) + ('business_name',)

    def validate(self, attrs):
        # djoser's validate() runs `User(**attrs)` to feed Django's password validators.
        # business_name is not a User column, so it has to be lifted out for that call and
        # put back for create().
        business_name = attrs.pop('business_name', None)
        attrs = super().validate(attrs)
        if business_name is not None:
            attrs['business_name'] = business_name
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        business_name = (validated_data.pop('business_name', '') or '').strip()
        user = super().create(validated_data)

        account = Account.objects.create(
            name=business_name or user.username,
            subscription_status=Account.PENDING_VERIFICATION,
        )
        Membership.objects.create(user=user, account=account, is_owner=True)
        return user
