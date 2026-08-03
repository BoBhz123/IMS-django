from django.urls import path
from django.urls.conf import include
from rest_framework_nested import  routers
from . import views

router = routers.DefaultRouter()
router.register('products',views.ProductViewSet,basename='products')
router.register('categories',views.CategoryViewSet)
router.register('purchases',views.PurchaseViewSet)
router.register('orders',views.OrderViewSet)
router.register('suppliers',views.SupplierViewSet)
router.register('customers',views.CustomerViewSet
                
                )

products_router = routers.NestedDefaultRouter(
    router, 'products', lookup='product')


urlpatterns = [
    path('analytics/', views.AnalyticsView.as_view(), name='analytics'),
] + router.urls + products_router.urls