from django.shortcuts import render
from django.db.models import Prefetch,F,Q,DateField
from django.db.models.aggregates import Sum
from django.db.models.functions import TruncDate,TruncWeek,TruncMonth,TruncYear
from django.http import HttpResponse
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter,OrderingFilter
from rest_framework.parsers import MultiPartParser,FormParser
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet
from rest_framework.views import APIView
from .filters import ProductFilter,PurchaseFilter,OrderFilter
from .pagination import DefaultPagination
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order,LINE_TOTAL
from .serializers import *
from datetime import date, timedelta
from django.utils import timezone
from rest_framework.permissions import IsAdminUser
import csv


class ProductImageViewSet(ModelViewSet):
    serializer_class = ProductImageSerializer
    parser_classes = [MultiPartParser, FormParser]

    def get_serializer_context(self):
        return {'product_id': self.kwargs['product_pk']}

    def get_queryset(self):
        return ProductImage.objects.filter(product_id=self.kwargs['product_pk'])



class ProductViewSet(ModelViewSet):
   queryset = Product.objects.select_related('category', 'supplier').prefetch_related('images')
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
    
class _TotalAnnotationMixin:
    """
    Adds `annotated_total` only for requests that actually sort by it.

    The annotation is a Sum over the reverse `items` relation, so it forces a JOIN plus a
    GROUP BY across the whole filtered table on *every* list request — work the DB cannot
    skip just because we only want ten rows. The serializers read the in-Python
    `total_price` property off prefetched items, not this annotation, so for the common
    `?ordering=-placed_at` case it was pure overhead.
    """

    def get_queryset(self):
        queryset = super().get_queryset()
        if 'annotated_total' in self.request.query_params.get('ordering', ''):
            queryset = queryset.annotate(annotated_total=Sum(LINE_TOTAL))
        return queryset


class PurchaseViewSet(_TotalAnnotationMixin, ModelViewSet):
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']
    queryset = Purchase.objects.select_related('supplier').prefetch_related(
        Prefetch(
            'items',
            queryset=PurchaseItem.objects.select_related('product')
        )
    )

    filterset_class = PurchaseFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    pagination_class = DefaultPagination
    ordering_fields = ['annotated_total', 'placed_at']

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return CreatePurchaseSerializer
        return PurchaseSerializer



class OrderViewSet(_TotalAnnotationMixin, ModelViewSet):
    queryset = Order.objects.select_related('customer').prefetch_related(
            Prefetch(
                'items',
                queryset=OrderItem.objects.select_related('product')
            )
        )
    filterset_class = OrderFilter
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    pagination_class = DefaultPagination
    ordering_fields = ['annotated_total', 'placed_at']

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return CreateOrderSerializer
        return OrderSerializer



GROUP_BY_TRUNC = {
    'day': TruncDate,
    'week': TruncWeek,
    'month': TruncMonth,
    'year': TruncYear,
}

# 'all_time' is intentionally absent: it means "no date filtering", the existing default behavior.
PERIOD_WINDOW_DAYS = {
    'last_month': 30,
    'last_year': 365,
}


class AnalyticsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        purchases = Purchase.objects.all()
        orders = Order.objects.all()
        products = OrderItem.objects.all()

        year = request.query_params.get('year')
        month = request.query_params.get('month')
        start_date = request.query_params.get('start_date')
        end_date = request.query_params.get('end_date')
        group_by = request.query_params.get('group_by')
        period = request.query_params.get('period')

        if period in PERIOD_WINDOW_DAYS:
            cutoff = timezone.now() - timedelta(days=PERIOD_WINDOW_DAYS[period])
            orders = orders.filter(placed_at__gte=cutoff)
            purchases = purchases.filter(placed_at__gte=cutoff)
            products = products.filter(order__placed_at__gte=cutoff)

        if year:
            orders = orders.filter(placed_at__year=year)
            purchases = purchases.filter(placed_at__year=year)
            products = products.filter(order__placed_at__year=year)

        if month:
            orders = orders.filter(placed_at__month=month)
            purchases = purchases.filter(placed_at__month=month)
            products = products.filter(order__placed_at__month=month)

        if start_date:
            orders = orders.filter(placed_at__date__gte=start_date)
            purchases = purchases.filter(placed_at__date__gte=start_date)
            products = products.filter(order__placed_at__date__gte=start_date)

        if end_date:
            orders = orders.filter(placed_at__date__lte=end_date)
            purchases = purchases.filter(placed_at__date__lte=end_date)
            products = products.filter(order__placed_at__date__lte=end_date)

        revenue_query = orders.aggregate(
            total_revenue=Sum(LINE_TOTAL)
        )
        cost_query = purchases.aggregate(
            total_cost=Sum(LINE_TOTAL)
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
            "top_products": best_seller_query,
            # Catalog size, deliberately NOT date-filtered — it's "how many products exist",
            # not "how many were sold in this window". Served here so the dashboard's
            # "Products in catalog" tile doesn't need a second round trip to /products/
            # (which returned a full serialized page, nested images and all, for one number).
            "products_count": Product.objects.count(),
        }

        if group_by in GROUP_BY_TRUNC:
            data["series"] = self._build_series(orders, purchases, GROUP_BY_TRUNC[group_by])

        return Response(data)

    def _build_series(self, orders, purchases, trunc):
        revenue_rows = (
            orders
            .annotate(period=trunc('placed_at', output_field=DateField()))
            .values('period')
            .annotate(total=Sum(LINE_TOTAL))
        )
        cost_rows = (
            purchases
            .annotate(period=trunc('placed_at', output_field=DateField()))
            .values('period')
            .annotate(total=Sum(LINE_TOTAL))
        )

        revenue_by_period = {row['period']: row['total'] or 0 for row in revenue_rows if row['period']}
        cost_by_period = {row['period']: row['total'] or 0 for row in cost_rows if row['period']}

        periods = sorted(set(revenue_by_period) | set(cost_by_period))

        return [
            {
                "period": period.isoformat(),
                "total_revenue": revenue_by_period.get(period, 0),
                "total_costs": cost_by_period.get(period, 0),
            }
            for period in periods
        ]


     
     
def _csv_safe(value):
    if isinstance(value, str) and value.startswith(('=', '+', '-', '@', '\t', '\r')):
        return "'" + value
    return value


class ExportProductsCSVView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="products_export.csv"'

        writer = csv.writer(response)
        writer.writerow([
            'Product Name',
            'Category',
            'Supplier',
            'Stock Quantity',
            'Cost Price (USD)',
            'Sell Price (USD)',
            'Profit (USD)',
        ])

        products = Product.objects.select_related('category', 'supplier').all()

        search = request.query_params.get('search')
        category_id = request.query_params.get('category_id')
        supplier_id = request.query_params.get('supplier_id')
        min_price = request.query_params.get('default_sell_price__gt')
        max_price = request.query_params.get('default_sell_price__lt')

        if search:
            products = products.filter(Q(name__icontains=search) | Q(description__icontains=search))
        if category_id:
            products = products.filter(category_id=category_id)
        if supplier_id:
            products = products.filter(supplier_id=supplier_id)
        if min_price:
            products = products.filter(default_sell_price__gt=min_price)
        if max_price:
            products = products.filter(default_sell_price__lt=max_price)

        for product in products:
            writer.writerow([
                _csv_safe(product.name),
                _csv_safe(product.category.name if product.category else 'Uncategorized'),
                _csv_safe(product.supplier.name if product.supplier else 'No Supplier'),
                product.stock_quantity,
                f"${product.cost_price:.2f}",
                f"${product.default_sell_price:.2f}",
                f"${product.profit:.2f}",
            ])

        return response


class ExportOrdersCSVView(APIView):
    permission_classes = [IsAdminUser] 

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="orders_detailed_export.csv"'
        
        writer = csv.writer(response)    
        writer.writerow([
            'Order ID', 
            'Customer Name', 
            'Date Placed', 
            'Exchange Rate (LBP)', 
            'Product Name', 
            'Quantity', 
            'Unit Multiplier', 
            'Sell Price (USD)', 
            'Cost Price (USD)',
            'Line Total (USD)',
            'Total Profit (USD)'
        ])

        items = OrderItem.objects.select_related('order', 'order__customer', 'product').all()
        
        # Capture all possible filter parameters from the URL
        year = request.query_params.get('year')
        month = request.query_params.get('month')
        date_str = request.query_params.get('date')      # Format: YYYY-MM-DD
        order_id = request.query_params.get('order_id')  # UUID string
        
        if year:
            items = items.filter(order__placed_at__year=year)
        if month:
            items = items.filter(order__placed_at__month=month)
        if date_str:
            items = items.filter(order__placed_at__date=date_str)
        if order_id:
            items = items.filter(order__id=order_id)

        # `item.order.total_profit` is a Python property that walks order.items.all(). Since
        # select_related builds a distinct Order instance per row, nothing was cached: every
        # single CSV line fired its own query for that order's items — a textbook N+1 that
        # made a 2,000-line export 2,000 queries. One grouped aggregate replaces all of them.
        profit_by_order = {
            row['order_id']: row['profit'] or 0
            for row in items.values('order_id').annotate(
                profit=Sum(
                    (F('unit_price') - F('product__cost_price'))
                    * F('quantity')
                    * F('unit_multiplier')
                )
            )
        }

        for item in items:
            line_total = item.quantity * item.unit_multiplier * item.unit_price
            cost_price = item.product.cost_price if item.product else 0

            writer.writerow([
                item.order.id,
                item.order.customer.name if item.order.customer else "No Customer",
                item.order.placed_at.strftime("%Y-%m-%d %H:%M"),
                item.order.exchange_rate,
                item.product.name if item.product else "Unknown Product",
                item.quantity,
                item.unit_multiplier,
                f"${item.unit_price:.2f}",
                f"${cost_price:.2f}",
                f"${line_total:.2f}",
                f"${profit_by_order.get(item.order_id, 0):.2f}"
            ])

        return response
    
    
class ExportPurchasesCSVView(APIView):
    permission_classes = [IsAdminUser] 

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="purchases_detailed_export.csv"'
        
        writer = csv.writer(response)    
        writer.writerow([
            'Purchase ID', 
            'Supplier Name', 
            'Date Placed', 
            'Exchange Rate (LBP)', 
            'Product Name', 
            'Quantity', 
            'Unit Multiplier', 
            'Unit Cost Price (USD)', 
            'Line Total (USD)'
        ])

        # Query PurchaseItems directly for the row-by-row breakdown
        items = PurchaseItem.objects.select_related('purchase_order', 'purchase_order__supplier', 'product').all()
        
        # Capture filter parameters from the URL
        year = request.query_params.get('year')
        month = request.query_params.get('month')
        date_str = request.query_params.get('date')         # Format: YYYY-MM-DD
        purchase_id = request.query_params.get('purchase_id') # UUID string
        
        if year:
            items = items.filter(purchase_order__placed_at__year=year)
        if month:
            items = items.filter(purchase_order__placed_at__month=month)
        if date_str:
            items = items.filter(purchase_order__placed_at__date=date_str)
        if purchase_id:
            items = items.filter(purchase_order__id=purchase_id)

        for item in items:
            line_total = item.quantity * item.unit_multiplier * item.unit_price
            
            writer.writerow([
                item.purchase_order.id, 
                item.purchase_order.supplier.name if item.purchase_order.supplier else "No Supplier", 
                item.purchase_order.placed_at.strftime("%Y-%m-%d %H:%M"), 
                item.purchase_order.exchange_rate,
                item.product.name if item.product else "Unknown Product",
                item.quantity,
                item.unit_multiplier,
                f"${item.unit_price:.2f}",
                f"${line_total:.2f}"
            ])
            
        return response