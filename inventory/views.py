from django.shortcuts import get_object_or_404, render
from django.db.models import Prefetch,F,Q,DateField,ProtectedError
from django.db.models.aggregates import Sum,Count
from rest_framework import status
from django.db.models.functions import TruncDate,TruncWeek,TruncMonth,TruncYear
from django.http import HttpResponse
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter,OrderingFilter
from rest_framework.parsers import MultiPartParser,FormParser
from rest_framework.decorators import api_view, action
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet
from rest_framework.views import APIView
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.permissions import AllowAny
from django.conf import settings
from .filters import ProductFilter,PurchaseFilter,OrderFilter,ExpenseFilter
from .pagination import DefaultPagination
from .models import Product,Category,Supplier,Customer,Purchase,PurchaseItem,OrderItem,Order,Expense,LINE_TOTAL,LINE_COGS,generate_share_token
from .csv_format import iso as _iso, money as _money, text as _csv_safe
from .reporting import DateWindow, settlement_totals, with_settlement
from .serializers import *
import csv

from accounts.audit import log_event
from accounts.mixins import AccountScopedMixin
from accounts.models import get_account


class ProductImageViewSet(AccountScopedMixin, ModelViewSet):
    # ProductImage has no account column — it is owned through its product.
    account_lookup = 'product__account'

    queryset = ProductImage.objects.all()
    serializer_class = ProductImageSerializer
    parser_classes = [MultiPartParser, FormParser]

    def get_serializer_context(self):
        return {**super().get_serializer_context(), 'product_id': self.kwargs['product_pk']}

    def get_queryset(self):
        # Chained through super() deliberately. This used to be a bare
        # `ProductImage.objects.filter(product_id=...)`, which silently discarded
        # AccountScopedMixin's filter and left the nested route unscoped — `account_lookup`
        # above was declared but never reached. Any authenticated subscriber could then list,
        # replace or delete another account's product images by guessing a product id.
        # Found by the Phase 8 isolation matrix.
        return super().get_queryset().filter(product_id=self.kwargs['product_pk'])

    def get_product_or_404(self):
        # 404 rather than 403: a 403 would confirm the product exists while belonging to
        # someone else, which is an existence oracle across the tenant boundary.
        return get_object_or_404(
            Product.objects.filter(account=self.account), pk=self.kwargs['product_pk'],
        )

    def perform_create(self, serializer):
        # Not AccountScopedMixin's save(account=...): there is no such field to stamp. The
        # ownership check therefore has to happen explicitly — the queryset scoping above
        # governs reads only, and the parent product id comes straight off the URL.
        self.get_product_or_404()
        serializer.save()



class ProductViewSet(AccountScopedMixin, ModelViewSet):
   queryset = Product.objects.select_related('category', 'supplier').prefetch_related('images')
   serializer_class = ProductSerializer
   filter_backends = [DjangoFilterBackend,SearchFilter,OrderingFilter]
   filterset_class = ProductFilter
   pagination_class = DefaultPagination
   # barcode is here so a scanned code finds its product through the same ?search= the list
   # already uses, rather than needing a second endpoint.
   search_fields = ['name','description','barcode']
   ordering_fields = ['name','default_sell_price']
   
    

class ProtectedDeleteMixin:
    """Turn a PROTECT foreign key into a 409 instead of an uncaught 500.

    `Product.category` and `Product.supplier` are both `on_delete=PROTECT`, so deleting one that
    still has products raises `ProtectedError` straight out of the view. DRF has no handler for
    it, so the browser gets a 500 and the user gets no idea what to do about it.
    """

    protected_delete_message = 'This record is still in use and cannot be deleted.'

    def destroy(self, request, *args, **kwargs):
        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {'detail': self.protected_delete_message},
                status=status.HTTP_409_CONFLICT,
            )


class  CategoryViewSet(ProtectedDeleteMixin, AccountScopedMixin, ModelViewSet):
    # product_count drives the Categories screen: it shows how many products a category holds
    # and disables its delete button, so the 409 below is the backstop rather than the norm.
    queryset = Category.objects.annotate(product_count=Count('products'))
    serializer_class = CategorySerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']
    protected_delete_message = (
        'This category still has products in it. Move those products to another category first.'
    )

class CustomerViewSet(AccountScopedMixin, ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']
    
class SupplierViewSet(ProtectedDeleteMixin, AccountScopedMixin, ModelViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    filter_backends = [SearchFilter,OrderingFilter]
    ordering_fields= ['name']
    search_fields = ['name']
    protected_delete_message = (
        'This supplier still has products assigned to it. Reassign those products first.'
    )
    
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


class PurchaseViewSet(AccountScopedMixin, _TotalAnnotationMixin, ModelViewSet):
    http_method_names = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
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
        # PUT/PATCH belong on the write serializer too. Left on PurchaseSerializer they
        # appear to work and do almost nothing: its `items` and `supplier` are read-only
        # representations, so an edit would silently drop every line change and save only
        # the exchange rate — a 200 that discarded the request.
        if self.request.method in ('POST', 'PUT', 'PATCH'):
            return CreatePurchaseSerializer
        return PurchaseSerializer



class OrderViewSet(AccountScopedMixin, _TotalAnnotationMixin, ModelViewSet):
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
        # See PurchaseViewSet.get_serializer_class — OrderSerializer's `items` is
        # read_only=True, so editing through it would return 200 having changed nothing.
        if self.request.method in ('POST', 'PUT', 'PATCH'):
            return CreateOrderSerializer
        return OrderSerializer

    @action(detail=True, methods=['post', 'delete'], url_path='share')
    def share(self, request, pk=None):
        """
        Mint (POST) or revoke (DELETE) this order's public invoice link.

        Reached through the account-scoped queryset, so an order belonging to another account
        is a 404 here exactly as it is everywhere else — `get_object()` chains through
        AccountScopedMixin and never sees it.

        POST is idempotent: re-sharing an already-shared order returns the same token rather
        than minting a second one, so a customer who was sent the link yesterday is not
        silently cut off because somebody pressed Share again.
        """
        order = self.get_object()

        if request.method == 'DELETE':
            # Destroy the token rather than flag it. The token IS the capability — a
            # `revoked` boolean would leave a working secret in the database, one forgotten
            # filter away from still opening the door.
            order.share_token = None
            order.save(update_fields=['share_token'])
            log_event(
                'invoice_share_revoked', user=request.user, account=self.account,
                order=str(order.id),
            )
            return Response(status=status.HTTP_204_NO_CONTENT)

        if not order.share_token:
            order.share_token = generate_share_token()
            order.save(update_fields=['share_token'])
            log_event(
                'invoice_share_created', user=request.user, account=self.account,
                order=str(order.id),
            )

        return Response({
            'share_token': order.share_token,
            # Built server-side from SITE_URL so the link a customer receives is the canonical
            # domain, not whichever host the staff member happened to be using.
            'share_url': f'{settings.SITE_URL}/i/{order.share_token}',
        })


class PublicInvoiceView(APIView):
    """
    An invoice, readable by anyone holding its share token. **No authentication.**

    This is the only unauthenticated data endpoint in the application, so the constraints are
    worth stating plainly:

    * The token is 32 bytes from `secrets` (43 urlsafe characters). It is not enumerable, and
      it is the entire access-control story — there is nothing behind it.
    * The response comes from PublicInvoiceSerializer, which lists its fields explicitly and
      omits `unit_cost_price`, `profit` and `total_profit`. Publishing those would tell every
      recipient what the business pays its suppliers.
    * `authentication_classes = []` so a stray session or JWT cannot change what is returned —
      the response must depend on the token and nothing else.
    * Throttled per client address: the token is unguessable, but an endpoint that runs a
      database query for any string handed to it is still worth a limit.
    * Revocation is immediate, because revoking nulls the column this looks up.
    """

    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'public_invoice'

    def get(self, request, token):
        order = get_object_or_404(
            Order.objects.select_related('account', 'customer').prefetch_related(
                Prefetch('items', queryset=OrderItem.objects.select_related('product'))
            ),
            # Guarding against '' and None explicitly: a bug elsewhere that stored an empty
            # token must not turn into "GET /i/ returns somebody's invoice".
            share_token=token or '\x00',
        )
        return Response(PublicInvoiceSerializer(order).data)



GROUP_BY_TRUNC = {
    'day': TruncDate,
    'week': TruncWeek,
    'month': TruncMonth,
    'year': TruncYear,
}

class AnalyticsView(APIView):
    # Deliberately not IsAdminUser. The dashboard calls this on every load, so admin-only
    # would force every subscriber to be is_staff — which now means platform admin over
    # every account. The default IsAuthenticated + HasActiveSubscription is the right gate.

    def get(self, request):
        account = get_account(request.user)
        purchases = Purchase.objects.for_account(account)
        orders = Order.objects.for_account(account)
        products = (
            OrderItem.objects.filter(order__account=account)
            if account else OrderItem.objects.none()
        )
        expenses = Expense.objects.for_account(account)

        group_by = request.query_params.get('group_by')

        window = DateWindow.from_query_params(request.query_params)
        orders = window.apply(orders, 'placed_at')
        purchases = window.apply(purchases, 'placed_at')
        products = window.apply(products, 'order__placed_at')
        expenses = window.apply(expenses, 'spent_at')

        # One aggregate call over `orders`: both expressions traverse the same `items` join,
        # so there is no fan-out between them.
        order_totals = orders.aggregate(
            total_revenue=Sum(LINE_TOTAL),
            total_cogs=Sum(LINE_COGS),
        )
        outlays = purchases.aggregate(total=Sum(LINE_TOTAL))['total'] or 0
        expense_total = expenses.aggregate(total=Sum('amount'))['total'] or 0

        # Separate queries, deliberately — see reporting.line_total_subquery. paid_amount is a
        # column on the transaction, and summing it in the aggregate above (which joins
        # `items`) would multiply it by each transaction's line count.
        order_cash = settlement_totals(orders)
        purchase_cash = settlement_totals(purchases)

        revenue = order_totals['total_revenue'] or 0
        cogs = order_totals['total_cogs'] or 0
        gross_profit = revenue - cogs

        best_seller_query = products.values('product__name').annotate(
            total_sold=Sum(F('quantity'))
        ).order_by('-total_sold')[:5]

        data = {
            # Profit and loss.
            "total_revenue": revenue,
            "total_cogs": cogs,
            "gross_profit": gross_profit,
            "total_expenses": expense_total,
            "net_profit": gross_profit - expense_total,
            # Cash flow, deliberately outside the P&L above. Stock bought this month is not
            # a cost of what was sold this month; mixing them makes margin swing with
            # restocking timing. Named inventory_outlays rather than total_costs so it
            # cannot be misread as total_cogs.
            "inventory_outlays": outlays,
            # Cash and settlement. These are the figures that move when a payment status
            # changes; the P&L above deliberately does not.
            #
            # This app's books are accrual: a sale is revenue when it is placed, and its COGS
            # is snapshotted at the same moment (OrderItem.unit_cost_price). Recognising
            # revenue on collection instead would pair a partially collected order against
            # its *whole* COGS and report a loss on a sale that was profitable — the cost is
            # per line and known at once, the cash is per transaction and arrives later.
            # Splitting the two into separate figures is what lets both be honest.
            #
            # collected + outstanding == total_revenue exactly, by construction.
            "revenue_collected": order_cash['collected'],
            "revenue_outstanding": order_cash['outstanding'],
            "outlays_paid": purchase_cash['collected'],
            "outlays_outstanding": purchase_cash['outstanding'],
            # Cash actually in and out over the window. Expenses have no settlement state —
            # an Expense row *is* money already spent — so they count in full.
            "net_cash_flow": (
                order_cash['collected'] - purchase_cash['collected'] - expense_total
            ),
            "top_products": best_seller_query,
            # Catalog size, deliberately NOT date-filtered — it's "how many products exist",
            # not "how many were sold in this window". Served here so the dashboard's
            # "Products in catalog" tile doesn't need a second round trip to /products/
            # (which returned a full serialized page, nested images and all, for one number).
            "products_count": Product.objects.for_account(account).count(),
        }

        if group_by in GROUP_BY_TRUNC:
            data["series"] = self._build_series(
                orders, purchases, expenses, GROUP_BY_TRUNC[group_by],
            )

        return Response(data)

    def _build_series(self, orders, purchases, expenses, trunc):
        def totals_by_period(queryset, field, **expressions):
            """
            One grouped query per queryset. Multiple Sums in a single annotate() is
            deliberate: revenue and COGS both traverse the `items` join, and splitting them
            into two annotate() calls on the same queryset makes each multiply the other's
            row count.
            """
            rows = (
                queryset
                .annotate(period=trunc(field, output_field=DateField()))
                .values('period')
                .annotate(**{name: Sum(expr) for name, expr in expressions.items()})
            )
            return {
                row['period']: {name: row[name] or 0 for name in expressions}
                for row in rows if row['period']
            }

        order_rows = totals_by_period(
            orders, 'placed_at', total_revenue=LINE_TOTAL, total_cogs=LINE_COGS,
        )
        purchase_rows = totals_by_period(purchases, 'placed_at', total_costs=LINE_TOTAL)
        expense_rows = totals_by_period(expenses, 'spent_at', total_expenses='amount')

        # Their own passes, for the same reason the summary splits them: these sum a column on
        # the transaction, and the two queries above are fanned out across the `items` join.
        order_cash_rows = totals_by_period(
            with_settlement(orders), 'placed_at',
            revenue_collected='settled_collected',
            revenue_outstanding='settled_outstanding',
        )
        purchase_cash_rows = totals_by_period(
            with_settlement(purchases), 'placed_at', outlays_paid='settled_collected',
        )

        periods = sorted(
            set(order_rows) | set(purchase_rows) | set(expense_rows)
            | set(order_cash_rows) | set(purchase_cash_rows)
        )

        series = []
        for period in periods:
            revenue = order_rows.get(period, {}).get('total_revenue', 0)
            cogs = order_rows.get(period, {}).get('total_cogs', 0)
            spent = expense_rows.get(period, {}).get('total_expenses', 0)
            gross_profit = revenue - cogs
            collected = order_cash_rows.get(period, {}).get('revenue_collected', 0)
            paid_out = purchase_cash_rows.get(period, {}).get('outlays_paid', 0)
            series.append({
                "period": period.isoformat(),
                "total_revenue": revenue,
                # The purchases line. Keeps its Phase 3 name: the chart already reads it, and
                # unlike the summary tile it sits nowhere near a COGS figure.
                "total_costs": purchase_rows.get(period, {}).get('total_costs', 0),
                "total_cogs": cogs,
                "gross_profit": gross_profit,
                "total_expenses": spent,
                # Allowed to be negative. A month with rent and no sales is a loss, and that
                # is the month most worth seeing on a chart.
                "net_profit": gross_profit - spent,
                # The cash half, mirroring the summary. Bucketed by the transaction's own
                # date, not by when the money arrived — this app records a settlement, not a
                # dated payment ledger, so "collected" here means "collected against orders
                # placed in this period". Enough to see whether a period's sales are actually
                # being paid for; not enough to reconcile a bank statement, which would need
                # a Payment model.
                "revenue_collected": collected,
                "revenue_outstanding": order_cash_rows.get(period, {}).get(
                    'revenue_outstanding', 0,
                ),
                "outlays_paid": paid_out,
                "net_cash_flow": collected - paid_out - spent,
            })
        return series


     
     
class ExportProductsCSVView(APIView):
    # Scoped throttle rather than the project default (there is none): these three are
    # the only endpoints whose cost grows with the account's entire history.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'exports'

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

        products = Product.objects.for_account(
            get_account(request.user)
        ).select_related('category', 'supplier')

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
    # Scoped throttle rather than the project default (there is none): these three are
    # the only endpoints whose cost grows with the account's entire history.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'exports'

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="orders_detailed_export.csv"'
        
        writer = csv.writer(response)

        account = get_account(request.user)
        # The exchange rate is a currency *conversion* detail, so it follows the account's
        # dual-currency setting: an account operating in one currency exports one currency.
        # The column is dropped from the file entirely rather than blanked, because a
        # permanently empty column is something a spreadsheet user has to ask about.
        # The Purchase/Order.exchange_rate row data is still stored either way — this is a
        # reporting choice, not a change to what is recorded.
        include_rate = account.enable_dual_currency if account else True

        header = [
            'Order ID',
            'Customer Name',
            'Date Placed',
            *(['Exchange Rate (LBP)'] if include_rate else []),
            'Product Name',
            'Barcode',
            # Since unit_multiplier was removed (2026-08-24) this IS the physical count, so
            # it is summable and is summed in the TOTALS row. The old 'Unit Multiplier' and
            # 'Total Units' columns are gone: the first no longer exists, and the second was
            # only ever quantity * multiplier, which is now just quantity.
            'Quantity',
            'Sell Price (USD)',
            'Cost Price (USD)',
            'Line Total (USD)',
            # This line's own profit. There is deliberately no per-order profit column: it
            # repeated the whole order's profit on every one of its lines, so any tool that
            # summed the column multiplied each order's profit by its line count.
            'Line Profit (USD)',
        ]
        writer.writerow(header)
        items = OrderItem.objects.select_related(
            'order', 'order__customer', 'product'
        ).filter(order__account=account) if account else OrderItem.objects.none()
        
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

        # Accumulated in the loop that already walks the items rather than re-queried, so the
        # totals row costs no extra queries — this export's constant-query-count guarantee
        # predates it and has a test.
        total_units = 0
        total_line_value = 0
        total_line_profit = 0

        for item in items:
            units = item.quantity
            line_total = units * item.unit_price
            # The snapshot on the line, not product.cost_price: a re-export of last year
            # must reproduce last year's figures even after a cost correction.
            cost_price = item.unit_cost_price
            line_profit = (item.unit_price - cost_price) * units

            total_units += units
            total_line_value += line_total
            total_line_profit += line_profit

            writer.writerow([
                item.order.id,
                _csv_safe(item.order.customer.name if item.order.customer else "No Customer"),
                _iso(item.order.placed_at),
                *([item.order.exchange_rate] if include_rate else []),
                _csv_safe(item.product.name if item.product else "Unknown Product"),
                _csv_safe(item.product.barcode or '' if item.product else ''),
                units,
                _money(item.unit_price),
                _money(cost_price),
                _money(line_total),
                _money(line_profit),
            ])

        # Positioned by column name rather than by counting blanks. The old form was a literal
        # run of '' whose length had to be recounted by hand every time a column moved, and the
        # rate column now appears or disappears per account, so counting is no longer possible.
        totals_row = [''] * len(header)
        totals_row[0] = 'TOTALS'
        totals_row[header.index('Quantity')] = total_units
        totals_row[header.index('Line Total (USD)')] = _money(total_line_value)
        totals_row[header.index('Line Profit (USD)')] = _money(total_line_profit)
        writer.writerow(totals_row)

        return response
    
    
class ExportPurchasesCSVView(APIView):
    # Scoped throttle rather than the project default (there is none): these three are
    # the only endpoints whose cost grows with the account's entire history.
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'exports'

    def get(self, request):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="purchases_detailed_export.csv"'
        
        writer = csv.writer(response)

        # Query PurchaseItems directly for the row-by-row breakdown
        account = get_account(request.user)
        # See ExportOrdersCSVView — the rate column follows the account's dual-currency setting.
        include_rate = account.enable_dual_currency if account else True

        header = [
            'Purchase ID',
            'Supplier Name',
            'Date Placed',
            *(['Exchange Rate (LBP)'] if include_rate else []),
            'Product Name',
            'Barcode',
            # See ExportOrdersCSVView — quantity is the physical count now that
            # unit_multiplier is gone, so 'Unit Multiplier' and 'Total Units' are dropped and
            # this column is the one totalled.
            'Quantity',
            'Unit Cost Price (USD)',
            'Line Total (USD)',
        ]
        writer.writerow(header)
        items = PurchaseItem.objects.select_related(
            'purchase_order', 'purchase_order__supplier', 'product'
        ).filter(purchase_order__account=account) if account else PurchaseItem.objects.none()
        
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

        # See ExportOrdersCSVView: accumulated in the existing loop, not a second query.
        total_units = 0
        total_line_value = 0

        for item in items:
            units = item.quantity
            line_total = units * item.unit_price
            total_units += units
            total_line_value += line_total

            writer.writerow([
                item.purchase_order.id,
                _csv_safe(
                    item.purchase_order.supplier.name
                    if item.purchase_order.supplier else "No Supplier"
                ),
                _iso(item.purchase_order.placed_at),
                *([item.purchase_order.exchange_rate] if include_rate else []),
                _csv_safe(item.product.name if item.product else "Unknown Product"),
                _csv_safe(item.product.barcode or '' if item.product else ''),
                units,
                _money(item.unit_price),
                _money(line_total),
            ])

        totals_row = [''] * len(header)
        totals_row[0] = 'TOTALS'
        totals_row[header.index('Quantity')] = total_units
        totals_row[header.index('Line Total (USD)')] = _money(total_line_value)
        writer.writerow(totals_row)

        return response

class ExpenseViewSet(AccountScopedMixin, ModelViewSet):
    queryset = Expense.objects.all()
    serializer_class = ExpenseSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_class = ExpenseFilter
    search_fields = ['description']
    ordering_fields = ['spent_at', 'amount', 'category']
    ordering = ['-spent_at']
    pagination_class = DefaultPagination
