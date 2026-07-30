from django.contrib import admin,messages
from . import models
from django.db.models.aggregates import Count
from django.db.models import Sum, F
from django.http import HttpResponse
from django.urls import reverse
from django.utils.html import format_html, urlencode
from django.utils import timezone
from datetime import timedelta
import csv


#admin models register



@admin.register(models.Product)
class ProductAdmin(admin.ModelAdmin):
    actions = ['clear_stock']
    list_display = ['name','category','description','stock_quantity','default_sell_price']
    list_per_page= 10
    list_editable= ['default_sell_price']
    search_fields = ['name']
    list_filter=['category']
    autocomplete_fields = ['category','supplier']
    
    def category(self,product):
        return product.category.name
    @admin.action(description='Clear stock')
    def clear_stock(self,request,queryset):
        updated_stock_quantity = queryset.update(stock_quantity = 0)
        self.message_user(
            request,
            f'{updated_stock_quantity} products were successfully updated.',
            messages.ERROR
        )
@admin.register(models.Category)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ['name']
    search_fields = ['name']
   
   
class PurchaseItemInline(admin.TabularInline):
    model = models.PurchaseItem 
    extra = 0
      
    
@admin.register(models.Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    list_display = ['id','supplier_name','exchange_rate','get_total','placed_at']
    list_select_related = ['supplier']
    list_filter = ['supplier']
    inlines = [PurchaseItemInline]
    
    def supplier_name(self,purchase):
        url =(  reverse('admin:inventory_supplier_changelist')
        +'?'
        +urlencode({
            'purchase__id':str(purchase.id)
        }))
        return format_html('<a href="`{}">{}</a>',url,purchase.supplier.name)
    
    
    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs.annotate(annotated_total=Sum(F('items__quantity') * F('items__unit_price')))

    @admin.display(description='Total Value', ordering='annotated_total')
    def get_total(self, obj):
        total = getattr(obj, 'annotated_total', obj.total_price)
        return f"${total:.2f}" if total else "$0.00"
    

class PlacedAtFilter(admin.SimpleListFilter):
    title = 'date'
    parameter_name = 'placed_at'

    def lookups(self, request, model_admin):
        current_year = timezone.now().year
        
        return [
            ('today', 'Today'),
            ('7_days', 'Past 7 Days'),
            ('1_month', 'Past Month'),
            ('6_months', 'Past 6 Months'),
            ('1_year', 'Past Year'),
            (str(current_year), f'Year {current_year}'),
            (str(current_year - 1), f'Year {current_year - 1}'),
        ]

    def queryset(self, request, queryset):
        if not self.value():
            return queryset
            
        now = timezone.now()
        
        if self.value() == 'today':
            return queryset.filter(placed_at__date=now.date())
        elif self.value() == '7_days':
            return queryset.filter(placed_at__gte=now - timedelta(days=7))
        elif self.value() == '1_month':
            return queryset.filter(placed_at__gte=now - timedelta(days=30))
        elif self.value() == '6_months':
            return queryset.filter(placed_at__gte=now - timedelta(days=180))
        elif self.value() == '1_year':
            return queryset.filter(placed_at__gte=now - timedelta(days=365))
        elif self.value().isdigit():
            return queryset.filter(placed_at__year=int(self.value()))


@admin.action(description='Export selected orders to CSV')
def export_orders_to_csv(modeladmin, request, queryset):
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="orders_export.csv"'
    writer = csv.writer(response)    
    writer.writerow(['Order ID', 'Customer Name', 'Date Placed', 'Exchange Rate (LBP)', 'Total Value (USD)'])

    # Annotate the queryset to calculate the math
    annotated_queryset = queryset.annotate(
        total_value=Sum(F('items__quantity') * F('items__unit_price'))
    )

    for order in annotated_queryset:
        calculated_total = order.total_value if order.total_value is not None else 0
        writer.writerow([
            order.id, 
            order.customer.name if order.customer else "No Customer", 
            order.placed_at.strftime("%Y-%m-%d %H:%M"), 
            order.exchange_rate,
            f"${calculated_total:.2f}" # Added the formatted total
        ])

    return response    
    
@admin.action(description='Export selected purchases to CSV')
def export_purchases_to_csv(modeladmin, request, queryset):
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="purchases_export.csv"'
    writer = csv.writer(response)
    
    writer.writerow(['Purchase ID', 'Supplier Name', 'Date Placed', 'Total Cost (USD)'])

    annotated_queryset = queryset.annotate(
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

class OrderItemInline(admin.TabularInline):
    model = models.OrderItem
    extra = 0

        


@admin.register(models.Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ['id','customer','exchange_rate','get_total','placed_at']
    list_select_related = ['customer']
    list_filter = ['customer',PlacedAtFilter]
    inlines = [OrderItemInline]
    search_fields = ['customer__name']
    actions = [export_orders_to_csv]    
    
    def customer(self,order):
        return order.customer.name
    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs.annotate(annotated_total=Sum(F('items__quantity') * F('items__unit_price')))
    
    @admin.display(description='Total Cost', ordering='annotated_total')
    def get_total(self, obj):
        total = getattr(obj, 'annotated_total', obj.total_price)
        return f"${total:.2f}" if total else "$0.00"
  
  

@admin.register(models.Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ['name','phone_number']
    list_per_page = 10
    ordering = ['name']
    search_fields=['name']
    
    
    
@admin.register(models.Customer)
class CustomerAdmin(admin.ModelAdmin):
    list_display = ['id','name','phone_number','location',]
    list_per_page = 10
    ordering = ['name']
    search_fields=['name']
    
    
    
