from django.urls import path

from .views import ResendCodeView, SubscriptionStatusView, VerifyEmailView

urlpatterns = [
    path('subscription/', SubscriptionStatusView.as_view(), name='subscription-status'),
    path('verify-email/', VerifyEmailView.as_view(), name='verify-email'),
    path('resend-code/', ResendCodeView.as_view(), name='resend-code'),
]
