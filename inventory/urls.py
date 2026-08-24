from django.urls import path
from django.urls.conf import include
from rest_framework_nested import routers
from . import views

router = routers.DefaultRouter()
router.register('products', views.ProductViewSet, basename='products')
router.register('categories', views.CategoryViewSet)
router.register('purchases', views.PurchaseViewSet)
router.register('orders', views.OrderViewSet)
router.register('suppliers', views.SupplierViewSet)
router.register('customers', views.CustomerViewSet)
router.register('expenses', views.ExpenseViewSet, basename='expenses')

# Image nested routing
products_router = routers.NestedDefaultRouter(router, 'products', lookup='product')
products_router.register('images', views.ProductImageViewSet, basename='product-images')

urlpatterns = [
    path('analytics/', views.AnalyticsView.as_view(), name='analytics'),
    # The only unauthenticated data route in the project. Deliberately outside the router so
    # it cannot inherit a viewset's default permissions by accident — see PublicInvoiceView.
    path(
        'public/invoice/<str:token>/',
        views.PublicInvoiceView.as_view(),
        name='public-invoice',
    ),
    path('orders/export/csv/', views.ExportOrdersCSVView.as_view(), name='export-orders-csv'),
    path('purchases/export/csv/', views.ExportPurchasesCSVView.as_view(), name='export-purchases-csv'),
    path('products/export/csv/', views.ExportProductsCSVView.as_view(), name='export-products-csv'),
] + router.urls + products_router.urls