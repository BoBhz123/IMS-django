from django.shortcuts import render
from django.db.models import Prefetch
from django.http import HttpResponse
from .serializers import *
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet

# Create your views here.




class ProductViewSet(ModelViewSet):
   queryset = Product.objects.all()
   serializer_class = ProductSerializer
    

class  CategoryViewSet(ModelViewSet):
    queryset = Category.objects.all()
    serializer_class = CategorySerializer

class CustomerViewSet(ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    
class SupplierViewSet(ModelViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    
class PurchaseViewSet(ModelViewSet):
    queryset = Purchase.objects.select_related('supplier').prefetch_related(
        Prefetch(
            'items', 
            queryset=PurchaseItem.objects.select_related('product')
        )
    ).all()     
    serializer_class = PurchaseSerializer
    
    
class OrderViewSet(ModelViewSet):
    queryset = Order.objects.select_related('customer').prefetch_related(
        Prefetch(
            'items', 
            queryset=OrderItem.objects.select_related('product')
        )
    ).all()
    serializer_class = OrderSerializer