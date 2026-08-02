from django.shortcuts import render
from django.db.models import Prefetch,F
from django.db.models.aggregates import Sum
from django.http import HttpResponse
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter,OrderingFilter
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet
from .filters import ProductFilter,PurchaseFilter,OrderFilter
from .pagination import DefaultPagination
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order
from .serializers import *
# Create your views here.




class ProductViewSet(ModelViewSet):
   queryset = Product.objects.all()
   serializer_class = ProductSerializer
   filter_backends = [DjangoFilterBackend,SearchFilter,OrderingFilter]
   filterset_class = ProductFilter
   pagination_class = DefaultPagination
   search_fields = ['name','description']
   ordering_fields = ['name','default_sell_price']
   
    

class  CategoryViewSet(ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']

class CustomerViewSet(ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']
    
class SupplierViewSet(ModelViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']
    
class PurchaseViewSet(ModelViewSet):
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']
    queryset = Purchase.objects.select_related('supplier').prefetch_related(
        Prefetch(
            'items', 
            queryset=PurchaseItem.objects.select_related('product')
        )
    ).annotate(
        annotated_total=Sum(F('items__quantity') * F('items__unit_price'))
    )
    
    serializer_class = PurchaseSerializer
    filterset_class = PurchaseFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    ordering_fields = ['annotated_total', 'placed_at']
    
    
    
    
class OrderViewSet(ModelViewSet):
    queryset = Order.objects.select_related('customer').prefetch_related(
        Prefetch(
            'items', 
            queryset=OrderItem.objects.select_related('product')
        )
    ).all()
    serializer_class = OrderSerializer
    filterset_class = OrderFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    ordering_fields = ['annotated_total', 'placed_at']
    