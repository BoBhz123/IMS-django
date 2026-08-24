from django_filters.rest_framework import FilterSet
from .models import Product,Category,Purchase,Order,Expense
from django.db import models
from django_filters import filters
class ProductFilter(FilterSet):
    # Exact, unlike the icontains ?search=. A scanner submits a complete code, and a partial
    # or cross-field match would resolve to the wrong product with no way for the user to
    # tell — the scan flows add order lines without confirming each one.
    barcode = filters.CharFilter(field_name='barcode', lookup_expr='exact')

    class Meta:
        model = Product
        fields = {
            'category_id': ['exact'],
            'supplier_id':['exact'],
            'default_sell_price': ['lt','gt'],
        }
        
        

class PurchaseFilter(FilterSet):
    class Meta:
        model = Purchase
        fields = {
            'id':['exact'],
            'supplier':['exact'],
            'placed_at': ['exact', 'year', 'month', 'day'],
            # Filtering on the stored column is safe here, unlike branching on it in code:
            # `_settle_payment` recomputes it from `paid_amount` on every write, so it cannot go
            # stale the way `Account.subscription_status` does (nothing there recomputes on read).
            'payment_status': ['exact'],
        }


class OrderFilter(FilterSet):
    class Meta:
        model = Order
        fields = {
            'id':['exact'],
            'customer':['exact'],
            'placed_at': ['exact', 'year', 'month', 'day'],
            # See PurchaseFilter.
            'payment_status': ['exact'],
        }
       
     
    

class ExpenseFilter(FilterSet):
    # Explicit range filters rather than a `fields` dict: 'spent_after' reads better in a
    # query string than 'spent_at__gte', and the frontend builds these by hand.
    spent_after = filters.DateFilter(field_name='spent_at', lookup_expr='date__gte')
    spent_before = filters.DateFilter(field_name='spent_at', lookup_expr='date__lte')
    min_amount = filters.NumberFilter(field_name='amount', lookup_expr='gte')
    max_amount = filters.NumberFilter(field_name='amount', lookup_expr='lte')

    class Meta:
        model = Expense
        fields = ['category']
