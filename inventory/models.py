from django.db import models
import uuid
from django.core.validators import MinValueValidator
from django.utils import timezone

from accounts.managers import AccountScopedManager
from accounts.models import Account

from .fields import ExternalOrLocalImageField
from .validators import validate_file_size


def product_image_path(instance, filename):
    """
    Namespaces uploads per account, replacing the per-schema isolation
    MULTITENANT_RELATIVE_MEDIA_ROOT used to provide. Applied here rather than in the storage
    backend so the account is visible in the stored path instead of being injected
    invisibly at write time.
    """
    return f'inventory/images/{instance.product.account_id}/{filename}'


# The single definition of what a Purchase/Order line is worth:
# quantity * unit_multiplier * unit_price.
#
# This used to be written out by hand in six places (both total_price properties, both item
# serializers, AnalyticsView, both CSV export views, and the admin's list column + CSV
# actions) and had drifted: the total_price properties omitted unit_multiplier while
# everything else included it, so the API's `total_price` disagreed with the per-item
# `total_price`, with the analytics revenue, and with what the UI displayed. Import from here
# rather than re-typing the expression.
#
# Both Purchase and Order name the reverse relation 'items', so this path resolves for either.
# Wrap it at the call site: .annotate(total=Sum(LINE_TOTAL)).
LINE_TOTAL = (
    models.F('items__quantity')
    * models.F('items__unit_multiplier')
    * models.F('items__unit_price')
)


def items_total(items):
    """Python-side equivalent of Sum(LINE_TOTAL), for already-loaded (prefetched) items."""
    return sum(item.quantity * item.unit_multiplier * item.unit_price for item in items)


# The cost half of LINE_TOTAL. Reads the snapshot on the line, never product.cost_price —
# joining out to the product would make every historical figure move the next time somebody
# corrects a cost.
LINE_COGS = (
    models.F('items__quantity')
    * models.F('items__unit_multiplier')
    * models.F('items__unit_cost_price')
)


def items_cogs(items):
    """Python-side equivalent of Sum(LINE_COGS), for already-loaded (prefetched) items."""
    return sum(
        item.quantity * item.unit_multiplier * item.unit_cost_price for item in items
    )


class Supplier(models.Model):
    id = models.AutoField(primary_key=True,
                          null=False,editable=False)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='suppliers')
    name = models.CharField(max_length=255,null = False)
    phone_number= models.CharField(max_length=255,blank=True,null=True)

    objects = AccountScopedManager()

    def __str__(self):
        return self.name

    class Meta:
        ordering = ['name']
        constraints = [
            # Per-account, not global: globally unique names meant the first account to
            # create "Acme Supplies" blocked every other account from ever using it.
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_supplier_account_name'),
        ]

class Category(models.Model):
    id = models.AutoField(primary_key=True,
                              null=False)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='categories')
    name = models.CharField(max_length=255,null=False)

    objects = AccountScopedManager()

    def __str__(self):
            return self.name

    class Meta:
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_category_account_name'),
        ]


class Product(models.Model):
    id = models.AutoField(primary_key=True,
                          null=False,editable=False)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='products')
    name = models.CharField(max_length=255,null=False)
    description = models.TextField(null=True,blank=True)
    # Strict per-unit prices in USD — independent of stock_quantity. Purchase/Order line items carry
    # their own unit_price captured at transaction time; they don't read these live, so changing a
    # product's price here never rewrites historical transactions.
    cost_price = models.DecimalField(max_digits=7,decimal_places=2,null=False,validators=[MinValueValidator(0)],
                                      help_text="Cost of a single unit, independent of stock_quantity.")
    default_sell_price = models.DecimalField(max_digits=7,decimal_places=2,null=False,validators=[MinValueValidator(0)],
                                      help_text="Sell price of a single unit, independent of stock_quantity.")
    @property
    def profit(self):
        return self.default_sell_price - self.cost_price
    stock_quantity = models.IntegerField(default=1,blank=False)
    supplier = models.ForeignKey(Supplier,on_delete=models.PROTECT,blank=True,null=True)
    category= models.ForeignKey(Category,on_delete=models.PROTECT,related_name='products')

    objects = AccountScopedManager()

    def __str__(self):
            return self.name

    class Meta:
        ordering = ['name']
        indexes = [
            # The products list is almost always "filter by category, sorted by name"
            # (ProductFilter + the default ordering above). Leading with category_id lets one
            # index serve both halves; name is covered by the account+name constraint below.
            models.Index(fields=['category', 'name'], name='product_category_name_idx'),
        ]
        constraints = [
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_product_account_name'),
        ]



class ProductImage(models.Model):
    # No `account` field: the owner is reached through product__account. A second copy of the
    # owner on the child row is a consistency bug waiting to happen. Same for OrderItem and
    # PurchaseItem.
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='images')
    image = ExternalOrLocalImageField(upload_to=product_image_path, validators=[validate_file_size])
    
class Purchase(models.Model):
    id = models.UUIDField(default=uuid.uuid4,primary_key=True,null=False)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='purchases')
    placed_at= models.DateTimeField(auto_now_add=True,db_index=True)
    supplier= models.ForeignKey(Supplier,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)

    objects = AccountScopedManager()

    @property
    def total_price(self):
        return items_total(self.items.all())

    class Meta:
        # Newest first — matches how every caller actually reads this table, and gives
        # PageNumberPagination the total ordering it needs for stable page boundaries
        # (without it, "page 2" can repeat or skip rows the DB happened to return twice).
        ordering = ['-placed_at']
        indexes = [
            # The purchases list filters by supplier and sorts by date in the same query;
            # placed_at's own db_index above serves the unfiltered case.
            models.Index(fields=['supplier', '-placed_at'], name='purchase_supplier_date_idx'),
        ]


class PurchaseItem(models.Model):
     purchase_order = models.ForeignKey(Purchase ,on_delete=models.CASCADE,related_name='items')
     product = models.ForeignKey( Product, 
                                 on_delete=models.
                                 PROTECT, related_name='purchaseitems')
     quantity = models.PositiveSmallIntegerField(default=1)
     unit_price = models.DecimalField(max_digits=9, decimal_places=2,validators=[MinValueValidator(0)])
     unit_multiplier = models.PositiveSmallIntegerField(default=1)
     
class Customer(models.Model):
    id = models.AutoField(primary_key=True,unique=True)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='customers')
    name = models.CharField(max_length=255)
    location = models.CharField(max_length=255,null=True,blank=True)
    phone_number = models.CharField(max_length=255,blank=True,null= True)

    objects = AccountScopedManager()

    def __str__(self):
            return self.name

    class Meta:
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['account', 'name'], name='uniq_customer_account_name'),
        ]



class Order(models.Model):
    id = models.UUIDField(primary_key=True,null=False,default=uuid.uuid4)
    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='orders')
    placed_at= models.DateTimeField(auto_now_add=True,db_index=True)
    customer= models.ForeignKey(Customer,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)

    objects = AccountScopedManager()

    @property
    def total_price(self):
        return items_total(self.items.all())
    @property
    def total_profit(self):
        return sum((item.profit or 0) for item in self.items.all())

    class Meta:
        # See Purchase.Meta — same reasoning (newest first, and a total order so paginated
        # page boundaries are stable).
        ordering = ['-placed_at']
        indexes = [
            models.Index(fields=['customer', '-placed_at'], name='order_customer_date_idx'),
        ]

class OrderItem(models.Model):
     order = models.ForeignKey(Order ,on_delete=models.CASCADE,related_name='items')
     product = models.ForeignKey( Product,
                                 on_delete=models.
                                 PROTECT, related_name='orderitems',blank=True)
     quantity = models.PositiveSmallIntegerField(default=1)
     unit_price = models.DecimalField(max_digits=9, decimal_places=2, validators=[MinValueValidator(0)])
     unit_multiplier = models.PositiveSmallIntegerField(default=1)
     # What this item cost us at the moment it was sold. Snapshotted, not derived: the
     # product's cost_price is a current figure that gets corrected, and profit computed
     # from it restates history every time it moves.
     unit_cost_price = models.DecimalField(
         max_digits=9, decimal_places=2, validators=[MinValueValidator(0)],
     )

     def save(self, *args, **kwargs):
         # Covers the admin inline and seed_data, which build rows directly. It does NOT
         # cover CreateOrderSerializer — bulk_create bypasses save() — which is why that
         # serializer stamps the cost itself.
         if self.unit_cost_price is None and self.product_id:
             # to_python rather than a bare assignment: an unsaved Product still holds
             # whatever was assigned to it, which may be a str from a fixture or a form
             # rather than a Decimal — and .profit does arithmetic on this value.
             self.unit_cost_price = self._meta.get_field('unit_cost_price').to_python(
                 self.product.cost_price
             )
         super().save(*args, **kwargs)

     @property
     def profit(self):
         return (self.unit_price - self.unit_cost_price) * self.quantity * self.unit_multiplier




class ExpenseCategory(models.TextChoices):
    """
    A fixed list rather than free text. Free text fragments 'Rent', 'rent' and 'Rent ' into
    separate rows in any per-category breakdown, which is the main reason to record a
    category at all. Adding one later is an edit here, not a migration.
    """

    RENT = 'rent', 'Rent'
    UTILITIES = 'utilities', 'Utilities'
    SALARIES = 'salaries', 'Salaries'
    MARKETING = 'marketing', 'Marketing'
    SOFTWARE = 'software', 'Software'
    TRANSPORT = 'transport', 'Transport'
    MAINTENANCE = 'maintenance', 'Maintenance'
    TAXES_FEES = 'taxes_fees', 'Taxes & Fees'
    OTHER = 'other', 'Other'


class Expense(models.Model):
    """
    Operational overhead — rent, salaries, software. Deliberately not inventory: stock
    spend is a cash movement recorded by Purchase, and folding it in here would corrupt the
    margin that gross profit is supposed to measure.

    Amounts are USD, like every other price in this app. LBP is a display toggle.
    """

    account = models.ForeignKey(Account, on_delete=models.CASCADE, related_name='expenses')
    description = models.CharField(max_length=255)
    amount = models.DecimalField(
        max_digits=10, decimal_places=2, validators=[MinValueValidator(0)],
    )
    category = models.CharField(
        max_length=32, choices=ExpenseCategory.choices, default=ExpenseCategory.OTHER,
        db_index=True,
    )
    # When the money was spent, which is not when the row was made. default=timezone.now and
    # never auto_now_add: auto_now_add ignores assignment, so a receipt entered on Friday for
    # a Tuesday spend would land in the wrong month and misstate that month's net profit.
    spent_at = models.DateTimeField(default=timezone.now, db_index=True)
    # When it was entered. An audit trail worth keeping on a money record.
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AccountScopedManager()

    class Meta:
        ordering = ['-spent_at']
        indexes = [
            models.Index(fields=['account', '-spent_at'], name='expense_account_date_idx'),
        ]

    def __str__(self):
        return f'{self.description} (${self.amount})'
