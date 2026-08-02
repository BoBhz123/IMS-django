from django_filters.rest_framework import FilterSet
from .models import Product,Category,Purchase,Order
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
       
     
    