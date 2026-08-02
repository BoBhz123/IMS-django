from rest_framework import serializers
from .models import Product , Category,Purchase,PurchaseItem,Order,OrderItem,Supplier,Customer

class ProductSerializer(serializers.ModelSerializer):
    
    class Meta():
        model = Product
        fields = ['id','name','category','description','cost_price','default_sell_price','stock_quantity']
        
class SimpleProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'title', 'unit_price']
    
        
class CategorySerializer(serializers.ModelSerializer):
    class Meta():
        model = Category
        fields = ['id','name']
    
class PurchaseItemSerializer(serializers.ModelSerializer):
    total_price = serializers.SerializerMethodField()
    product = serializers.StringRelatedField()
    
    def get_total_price(self,obj):
        return obj.quantity * obj.unit_multiplier * obj.unit_price 
    
    class Meta():
        model = PurchaseItem
        fields = ['product','quantity','unit_multiplier','unit_price','total_price']    
    
        
class PurchaseSerializer(serializers.ModelSerializer):
    items = PurchaseItemSerializer(many = True,read_only=True)
    supplier = serializers.StringRelatedField()
    class Meta():
        model = Purchase
        fields = ['id','placed_at','supplier','exchange_rate','items','total_price']
        
    

    
class SupplierSerializer(serializers.ModelSerializer):
   class Meta():
        model = Supplier
        fields = ['id','name','phone_number']
        
class CustomerSerializer(serializers.ModelSerializer):
    class Meta():
        model = Customer
        fields = ['id','name','phone_number','location']
        
        
        
class OrderItemSerializer(serializers.ModelSerializer):
    class Meta():
        model =OrderItem
        fields = ['product','quantity','unit_multiplier','unit_price']
        
        

class OrderSerializer(serializers.ModelSerializer):
    items = OrderItemSerializer(many=True, read_only=True)
    class Meta():
        model = Order
        fields = ['id','customer','placed_at','exchange_rate','items','total_price']  