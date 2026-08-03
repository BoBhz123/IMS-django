from django.shortcuts import render
from django.db.models import Prefetch,F,Q
from django.db.models.aggregates import Sum
from django.http import HttpResponse
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter,OrderingFilter
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet
from rest_framework.views import APIView
from .filters import ProductFilter,PurchaseFilter,OrderFilter
from .pagination import DefaultPagination
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order
from .serializers import *
from datetime import date
from rest_framework.permissions import IsAdminUser
import csv


class ProductImageViewSet(ModelViewSet):
    serializer_class = ProductImageSerializer

    def get_serializer_context(self):
        return {'product_id': self.kwargs['product_pk']}

    def get_queryset(self):
        return ProductImage.objects.filter(product_id=self.kwargs['product_pk'])



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
    
    filterset_class = PurchaseFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    ordering_fields = ['annotated_total', 'placed_at']
    
    def get_serializer_class(self):
        if self.request.method == 'POST':
            return CreatePurchaseSerializer
        return PurchaseSerializer
    
    
    
class OrderViewSet(ModelViewSet):
    queryset = Order.objects.select_related('customer').prefetch_related(
            Prefetch(
                'items', 
                queryset=OrderItem.objects.select_related('product')
            )
        ).annotate(
            annotated_total=Sum(F('items__quantity') * F('items__unit_price'))
        )
    filterset_class = OrderFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    ordering_fields = ['annotated_total', 'placed_at']
    
    def get_serializer_class(self):
        if self.request.method == 'POST':
            return CreateOrderSerializer
        return OrderSerializer
    
    
    
class AnalyticsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self,request):
         purchases = Purchase.objects.all()
         orders = Order.objects.all()
         products = OrderItem.objects.all()
         
         year = request.query_params.get('year')
         month = request.query_params.get('month')

         if year:
            orders = orders.filter(placed_at__year=year)
            purchases = purchases.filter(placed_at__year=year)
            products = products.filter(order__placed_at__year=year)
        
         if month:
                 orders = orders.filter(placed_at__month=month)
                 purchases = purchases.filter(placed_at__month=month)         
                 products = products.filter(order__placed_at__month=month)   
         
         
         revenue_query = orders.aggregate(
             total_revenue=Sum(F('items__quantity') * F('items__unit_price') * F('items__unit_multiplier'))
         )
         cost_query = purchases.aggregate(
             total_cost=Sum(F('items__quantity') * F('items__unit_price') * F('items__unit_multiplier'))
         )
         
         best_seller_query = products.values('product__name').annotate(
            total_sold=Sum(F('quantity') * F('unit_multiplier'))
        ).order_by('-total_sold')[:5]
         
         
         raw_revenue = revenue_query['total_revenue'] or 0
         raw_cost = cost_query['total_cost'] or 0

         raw_profit = raw_revenue - raw_cost

         
         data = {
             "total_revenue": f"${raw_revenue:,.2f}", 
             "total_costs": f"${raw_cost:,.2f}",
             "net_profit": f"${raw_profit:,.2f}",
             "top_products": best_seller_query  

         }

         return Response(data)
     
     
     
class ExportOrdersCSVView(APIView):
    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="orders_export.csv"'
        
        writer = csv.writer(response)    
        writer.writerow(['Order ID', 'Customer Name', 'Date Placed', 'Exchange Rate (LBP)', 'Total Value (USD)'])

        orders = Order.objects.all()
        
        year = request.query_params.get('year')
        month = request.query_params.get('month')
        
        if year:
            orders = orders.filter(placed_at__year=year)
        if month:
            orders = orders.filter(placed_at__month=month)

        annotated_queryset = orders.annotate(
            total_value=Sum(F('items__quantity') * F('items__unit_price'))
        )

        for order in annotated_queryset:
            calculated_total = order.total_value if order.total_value is not None else 0
            writer.writerow([
                order.id, 
                order.customer.name if order.customer else "No Customer", 
                order.placed_at.strftime("%Y-%m-%d %H:%M"), 
                order.exchange_rate,
                f"${calculated_total:.2f}"
            ])
        return response
    
    
    
    
class ExportPurchasesCSVView(APIView):
    permission_classes = [IsAdminUser] 

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="purchases_export.csv"'
        
        writer = csv.writer(response)    
        writer.writerow(['Purchase ID', 'Supplier Name', 'Date Placed', 'Total Cost (USD)'])

        purchases = Purchase.objects.all()
        
        year = request.query_params.get('year')
        month = request.query_params.get('month')
        
        if year:
            purchases = purchases.filter(placed_at__year=year)
        if month:
            purchases = purchases.filter(placed_at__month=month)

        annotated_queryset = purchases.annotate(
            total_cost=Sum(F('items__quantity') * F('items__unit_price'))
        )

        for purchase in annotated_queryset:
            calculated_total = purchase.total_cost if purchase.total_cost is not None else 0
            writer.writerow([
                purchase.id, 
                purchase.supplier.name if purchase.supplier else "No Supplier", 
                purchase.placed_at.strftime("%Y-%m-%d %H:%M"), 
                f"${calculated_total:.2f}"
            ])
            
        return response