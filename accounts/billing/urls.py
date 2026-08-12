from django.urls import path

from .views import BillingConfigView, CreateCheckoutView, RedeemKeyView
from .webhooks import PaddleWebhookView

urlpatterns = [
    path('config/', BillingConfigView.as_view(), name='billing-config'),
    path('checkout/', CreateCheckoutView.as_view(), name='billing-checkout'),
    path('redeem-key/', RedeemKeyView.as_view(), name='billing-redeem-key'),
    path('webhook/paddle/', PaddleWebhookView.as_view(), name='billing-paddle-webhook'),
]
