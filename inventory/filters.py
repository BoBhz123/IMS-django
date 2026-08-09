from django_filters.rest_framework import FilterSet
from .models import Product,Category,Purchase,Order,Expense
from django.db import models
from django_filters import filters
class ProductFilter(FilterSet):
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
        }
     
     
class OrderFilter(FilterSet):
    class Meta:
        model = Order
        fields = {
            'id':['exact'],
            'customer':['exact'],
            'placed_at': ['exact', 'year', 'month', 'day'],
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
