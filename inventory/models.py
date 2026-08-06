from django.db import models
import uuid
from django.core.validators import MinValueValidator
from .fields import ExternalOrLocalImageField
from .validators import validate_file_size


class Supplier(models.Model):
    id = models.AutoField(primary_key=True,
                          null=False,editable=False)
    name = models.CharField(max_length=255,unique=True,null = False)
    phone_number= models.CharField(max_length=255,blank=True,null=True)
    def __str__(self):
        return self.name
    
class Category(models.Model):
    id = models.AutoField(primary_key=True,
                              null=False)
    name = models.CharField(max_length=255,unique=True,null=False)
        
    def __str__(self):
            return self.name
    
    
class Product(models.Model):
    id = models.AutoField(primary_key=True,
                          null=False,editable=False)
   
    name = models.CharField(max_length=255,unique=True,null=False)
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
    
    def __str__(self):
            return self.name

    class Meta:
        ordering = ['name']
        indexes = [
            # The products list is almost always "filter by category, sorted by name"
            # (ProductFilter + the default ordering above). Leading with category_id lets one
            # index serve both halves; name alone is already indexed via its unique constraint.
            models.Index(fields=['category', 'name'], name='product_category_name_idx'),
        ]



class ProductImage(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='images')
    image = ExternalOrLocalImageField(upload_to='inventory/images', validators=[validate_file_size])
    
class Purchase(models.Model):
    id = models.UUIDField(default=uuid.uuid4,primary_key=True,null=False)
    placed_at= models.DateTimeField(auto_now_add=True,db_index=True)
    supplier= models.ForeignKey(Supplier,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)
    @property
    def total_price(self):
        return sum(item.quantity * item.unit_price for item in self.items.all())

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
    name = models.CharField(max_length=255,unique=True)
    location = models.CharField(max_length=255,null=True,blank=True)
    phone_number = models.CharField(max_length=255,blank=True,null= True)  
    def __str__(self):
            return self.name
      
    
    
class Order(models.Model):
    id = models.UUIDField(primary_key=True,null=False,default=uuid.uuid4)
    placed_at= models.DateTimeField(auto_now_add=True,db_index=True)
    customer= models.ForeignKey(Customer,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)
    @property
    def total_price(self):
        return sum(item.quantity * item.unit_price for item in self.items.all())
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
     @property
     def profit(self):
         if not self.product_id:
             return None
         return (self.unit_price - self.product.cost_price) * self.quantity * self.unit_multiplier


