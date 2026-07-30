from django.shortcuts import render
from django.http import HttpResponse
from django.db.models.aggregates import Count,Max, Min,Sum
from django.db.models import F,Q
from django.db.models.functions import Concat
from inventory.models import *

def say_hello(request):
    orders = Order.objects.prefetch_related('items__product').annotate(
        total_price=Sum(F('items__quantity') * F('items__unit_price'))
    )
    total_orders_count = orders.count()
    
    return render(request,'hello.html',{'name':'Bob','orders': orders,
        'total_orders': total_orders_count})

