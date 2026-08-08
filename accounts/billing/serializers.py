from rest_framework import serializers

from .base import PLAN_KEYS


class RedeemKeySerializer(serializers.Serializer):
    # Generous max_length: the user may paste the dashed display form, which is longer than
    # what gets stored after normalization.
    code = serializers.CharField(max_length=64, trim_whitespace=True)


class CreateCheckoutSerializer(serializers.Serializer):
    # A key, never an amount. The server maps it to a configured price; accepting a price,
    # a currency, or a total means somebody edits the request to one cent.
    plan = serializers.ChoiceField(choices=PLAN_KEYS)
