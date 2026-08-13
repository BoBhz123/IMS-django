from django.urls import path

from .views import (
    AbandonRegistrationView, PasswordResetConfirmView, PasswordResetRequestView,
    PasswordResetVerifyView, ResendCodeView, SubscriptionStatusView, VerifyEmailView,
)

urlpatterns = [
    path('subscription/', SubscriptionStatusView.as_view(), name='subscription-status'),
    path('verify-email/', VerifyEmailView.as_view(), name='verify-email'),
    path('resend-code/', ResendCodeView.as_view(), name='resend-code'),
    path(
        'abandon-registration/',
        AbandonRegistrationView.as_view(),
        name='abandon-registration',
    ),
    # Three routes for three screens, but only confirm/ changes anything — see the views.
    path(
        'password-reset/request/',
        PasswordResetRequestView.as_view(),
        name='password-reset-request',
    ),
    path(
        'password-reset/verify/',
        PasswordResetVerifyView.as_view(),
        name='password-reset-verify',
    ),
    path(
        'password-reset/confirm/',
        PasswordResetConfirmView.as_view(),
        name='password-reset-confirm',
    ),
]
