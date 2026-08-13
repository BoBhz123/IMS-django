"""
The Paddle notification endpoint.

This is the only code path that turns a card payment into access, and it is the only
unauthenticated endpoint in the app that can grant a subscription. Everything here exists to
make that safe:

* the signature is verified against the **raw** body before the JSON is parsed at all;
* the event id is claimed with a unique insert, so Paddle's retries cannot double-extend an
  expiry;
* an unrecognised price or a missing account is logged and acknowledged, never guessed at.

It answers 200 for anything it has genuinely finished with — including events it chooses to
ignore — because a non-2xx tells Paddle to retry, and retrying an event we will never handle
just fills the log. It answers 4xx only when the request itself is wrong.
"""

import json
import logging

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import Account, ProcessedWebhookEvent
from .activation import activate_account
from .paddle import plan_for_price_id, verify_signature

logger = logging.getLogger(__name__)

# Renewal notifications can arrive late — a retry after an outage, or simply a queue backing
# up. Locking a paying customer out at midnight over the gateway's timing is the kind of
# failure that generates a support ticket and a refund request.
RENEWAL_GRACE_DAYS = 1

# Events that grant or extend access.
GRANTING_EVENTS = {'transaction.completed', 'subscription.activated', 'subscription.updated'}
# Events that end it. Note past_due is not here: a failed payment starts a dunning cycle, and
# Paddle retries the card for days. Cutting access on the first failure would lock out
# customers whose payment succeeds on the second attempt.
REVOKING_EVENTS = {'subscription.canceled', 'subscription.paused'}


class PaddleWebhookView(APIView):
    """
    Unauthenticated by necessity — Paddle has no JWT. The signature *is* the authentication,
    so `permission_classes` being empty here is load-bearing rather than an oversight: the
    project default would 403 every notification.
    """

    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        secret = getattr(settings, 'PADDLE_WEBHOOK_SECRET', '')
        signature = request.headers.get('Paddle-Signature', '')

        # request.body, not request.data: re-serialising the parsed JSON reorders keys and
        # normalises whitespace, and the digest stops matching.
        if not verify_signature(request.body, signature, secret):
            logger.warning('Rejected Paddle webhook with a bad or missing signature.')
            return Response(
                {'detail': 'Invalid signature.'}, status=status.HTTP_403_FORBIDDEN,
            )

        try:
            payload = json.loads(request.body.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return Response(
                {'detail': 'Malformed payload.'}, status=status.HTTP_400_BAD_REQUEST,
            )

        event_id = payload.get('event_id') or ''
        event_type = payload.get('event_type') or ''
        if not event_id:
            return Response(
                {'detail': 'Missing event_id.'}, status=status.HTTP_400_BAD_REQUEST,
            )

        # Claim the event by inserting it, rather than checking whether it exists and then
        # inserting. Two concurrent deliveries of the same retry both pass a check-then-act
        # test and both activate; only one of them can win a unique insert.
        try:
            with transaction.atomic():
                ProcessedWebhookEvent.objects.create(
                    event_id=event_id, event_type=event_type,
                )
        except IntegrityError:
            return Response({'detail': 'Already processed.'})

        self.handle(event_type, payload.get('data') or {})
        return Response({'detail': 'ok'})

    # -- event handling ------------------------------------------------------------------

    def handle(self, event_type, data):
        if event_type in GRANTING_EVENTS:
            self.grant(event_type, data)
        elif event_type in REVOKING_EVENTS:
            self.revoke(data)
        else:
            logger.info('Ignoring unhandled Paddle event %s', event_type)

    def grant(self, event_type, data):
        account = self.resolve_account(data)
        if account is None:
            # Acknowledged, not retried: replaying this will not conjure the account. Logged
            # loudly because it means real money arrived that nobody has been credited for.
            logger.error(
                'Paddle %s could not be matched to an account: %s',
                event_type, self.identifiers(data),
            )
            return

        plan_key = self.resolve_plan(data)
        if plan_key is None:
            logger.error(
                'Paddle %s named a price this deployment does not sell (account %s): %s',
                event_type, account.pk, self.identifiers(data),
            )
            return

        # Stamp the gateway ids first so a later cancellation can find this row even if the
        # activation below is what fails.
        self.record_paddle_ids(account, data)
        activate_account(account, plan_type=plan_key, grace_days=RENEWAL_GRACE_DAYS)
        logger.info('Paddle %s activated account %s on %s', event_type, account.pk, plan_key)

    def revoke(self, data):
        account = self.resolve_account(data)
        if account is None:
            return

        # canceled, not an immediate expiry wipe. Paddle cancellations normally take effect
        # at the end of the paid period, and expires_at already encodes that date — clearing
        # it would refund nothing and cut off service the customer has paid for.
        account.subscription_status = Account.CANCELED
        account.save(update_fields=['subscription_status'])
        logger.info('Paddle cancellation applied to account %s', account.pk)

    # -- payload plumbing ----------------------------------------------------------------

    @staticmethod
    def identifiers(data):
        """A compact, non-sensitive description of an event, for the log."""
        return {
            'customer_id': data.get('customer_id'),
            'subscription_id': data.get('subscription_id') or data.get('id'),
        }

    @staticmethod
    def custom_data(data):
        return data.get('custom_data') or {}

    def resolve_account(self, data):
        """
        Find the account this event belongs to.

        custom_data first, because we put the account id there ourselves at checkout and it
        is the only identifier guaranteed to be present on a first purchase. The gateway ids
        are the fallback for renewals, where custom_data is not always echoed back.
        """
        account_id = self.custom_data(data).get('account_id')
        if account_id:
            account = Account.objects.filter(pk=account_id).first()
            if account:
                return account

        subscription_id = data.get('subscription_id') or data.get('id') or ''
        if subscription_id:
            account = Account.objects.filter(
                paddle_subscription_id=subscription_id,
            ).first()
            if account:
                return account

        customer_id = data.get('customer_id') or ''
        if customer_id:
            return Account.objects.filter(paddle_customer_id=customer_id).first()
        return None

    def resolve_plan(self, data):
        """
        Which plan was bought, from the price ids on the event's line items.

        Trusts the price id over custom_data's `plan`: custom_data is what we *asked* for,
        the line item is what was actually paid for, and if they disagree the money is the
        authority.
        """
        for item in data.get('items') or []:
            price = item.get('price') or {}
            plan_key = plan_for_price_id(price.get('id') or item.get('price_id'))
            if plan_key:
                return plan_key
        # Fall back to what we stamped on the checkout, for events that carry no line items.
        claimed = self.custom_data(data).get('plan')
        return claimed if claimed in dict(Account.PLAN_TYPE_CHOICES) else None

    @staticmethod
    def record_paddle_ids(account, data):
        fields = []
        customer_id = data.get('customer_id') or ''
        subscription_id = data.get('subscription_id') or data.get('id') or ''

        if customer_id and account.paddle_customer_id != customer_id:
            account.paddle_customer_id = customer_id
            fields.append('paddle_customer_id')
        # Only for subscription events: a one-time transaction's `id` is a transaction id and
        # storing it here would make a later subscription lookup match the wrong row.
        if subscription_id and str(subscription_id).startswith('sub_'):
            if account.paddle_subscription_id != subscription_id:
                account.paddle_subscription_id = subscription_id
                fields.append('paddle_subscription_id')

        if fields:
            account.save(update_fields=fields)


def trial_expiry_sweep(now=None):
    """
    Move trials whose clock has run out to pending_payment.

    Not required for enforcement — has_active_subscription already denies an elapsed trial —
    but the stored status is what the admin list and every report reads, and leaving it on
    'trialing' forever makes "how many accounts are actually trialing?" unanswerable.
    Exposed as a function so a management command or the admin can call it.
    """
    now = now or timezone.now()
    return Account.objects.filter(
        subscription_status=Account.TRIALING, trial_ends_at__lte=now,
    ).update(subscription_status=Account.PENDING_PAYMENT)
