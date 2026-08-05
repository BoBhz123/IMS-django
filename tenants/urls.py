from django.urls import path

from .views import TenantOnboardingView

urlpatterns = [
    path('onboard/', TenantOnboardingView.as_view(), name='tenant-onboard'),
]
