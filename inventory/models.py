from django.db import models
import uuid
from django.core.validators import MinValueValidator
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
    cost_price = models.DecimalField(max_digits=7,decimal_places=2,null=False,validators=[MinValueValidator(0)])
    default_sell_price = models.DecimalField(max_digits=7,decimal_places=2,null=False,validators=[MinValueValidator(0)])
    stock_quantity = models.IntegerField(default=1,blank=False)
    supplier = models.ForeignKey(Supplier,on_delete=models.PROTECT,blank=True,null=True)
    category= models.ForeignKey(Category,on_delete=models.PROTECT,related_name='products')
    
    def __str__(self):
            return self.name
    
    class Meta:
        ordering = ['name']
        
        
        
class ProductImage(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='images')
    image = models.ImageField(upload_to='inventory/images', validators=[validate_file_size])
    
class Purchase(models.Model):
    id = models.UUIDField(default=uuid.uuid4,primary_key=True,null=False)
    placed_at= models.DateTimeField(auto_now_add=True)
    supplier= models.ForeignKey(Supplier,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)
    @property
    def total_price(self):
        return sum(item.quantity * item.unit_price for item in self.items.all())
    
        
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
    placed_at= models.DateTimeField(auto_now_add=True)
    customer= models.ForeignKey(Customer,on_delete=models.SET_NULL,
                                    null=True)
    exchange_rate = models.IntegerField(default=89000,blank=True)
    @property
    def total_price(self):
        return sum(item.quantity * item.unit_price for item in self.items.all())
        
class OrderItem(models.Model):
     order = models.ForeignKey(Order ,on_delete=models.CASCADE,related_name='items')
     product = models.ForeignKey( Product, 
                                 on_delete=models.
                                 PROTECT, related_name='orderitems',blank=True)
     quantity = models.PositiveSmallIntegerField(default=1)
     unit_price = models.DecimalField(max_digits=9, decimal_places=2, validators=[MinValueValidator(0)])
     unit_multiplier = models.PositiveSmallIntegerField(default=1)
     
     
     