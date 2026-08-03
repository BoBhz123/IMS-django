from rest_framework import serializers
from django.db import transaction
from .models import Product , Category,Purchase,PurchaseItem,Order,OrderItem,Supplier,Customer
import uuid
class ProductSerializer(serializers.ModelSerializer):
    
    class Meta():
        model = Product
        fields = ['id','name','category','description','cost_price','default_sell_price','stock_quantity']
        
class SimpleProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'name', 'default_sell_price']    
        
class CategorySerializer(serializers.ModelSerializer):
    class Meta():
        model = Category
        fields = ['id','name']
        
        
class CreatePurchaseItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = PurchaseItem
        fields = ['product', 'quantity', 'unit_multiplier', 'unit_price']   


class PurchaseItemSerializer(serializers.ModelSerializer):
    total_price = serializers.SerializerMethodField()
    product = serializers.StringRelatedField()
    
    def get_total_price(self,obj):
        return obj.quantity * obj.unit_multiplier * obj.unit_price 
    
    class Meta():
        model = PurchaseItem
        fields = ['product','quantity','unit_multiplier','unit_price','total_price']    
    
        
class PurchaseSerializer(serializers.ModelSerializer):
    items = PurchaseItemSerializer(many = True)
    id = serializers.UUIDField(read_only=True)
    supplier = serializers.StringRelatedField()
    class Meta():
        model = Purchase
        fields = ['id','placed_at','supplier','exchange_rate','items','total_price']
        
class CreatePurchaseSerializer(serializers.ModelSerializer):
    id = serializers.UUIDField(read_only = True)
    items = CreatePurchaseItemSerializer(many=True)
    supplier = serializers.PrimaryKeyRelatedField(
        queryset=Supplier.objects.all(),
        required=False,
        allow_null=True
    )
    class Meta:
        model = Purchase
        fields = ['id','supplier', 'exchange_rate', 'items']

    @transaction.atomic 
    def create(self, validated_data):
        items_data = validated_data.pop('items')
        
        purchase = Purchase.objects.create(**validated_data)
        
        purchase_items_to_create = []
        for item_data in items_data:
            product = item_data['product']
            quantity = item_data['quantity']
            multiplier = item_data.get('unit_multiplier', 1)
            
            product.stock_quantity += (quantity * multiplier)
            product.save()
            purchase_items_to_create.append(
                PurchaseItem(purchase_order=purchase, **item_data)
            )

        PurchaseItem.objects.bulk_create(purchase_items_to_create)
        return purchase
    
class SupplierSerializer(serializers.ModelSerializer):
   class Meta():
        model = Supplier
        fields = ['id','name','phone_number']
        
class CustomerSerializer(serializers.ModelSerializer):
    class Meta():
        model = Customer
        fields = ['id','name','phone_number','location']
        
        
class CreateOrderItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = OrderItem
        fields = ['product', 'quantity', 'unit_multiplier', 'unit_price']
 
        
class OrderItemSerializer(serializers.ModelSerializer):
    class Meta():
        model =OrderItem
        fields = ['product','quantity','unit_multiplier','unit_price']
        
        
class CreateOrderSerializer(serializers.ModelSerializer):
    items = CreateOrderItemSerializer(many = True)
    id = serializers.UUIDField(read_only=True)
    customer = serializers.PrimaryKeyRelatedField(
        queryset=Customer.objects.all(),
        required=False,
        allow_null=True
    )
    class Meta:
        model = Order
        fields = ['id','customer','exchange_rate','items']
        
    @transaction.atomic  
    def create(self, validated_data):
        items_data = validated_data.pop('items',[])
        order = Order.objects.create(**validated_data)
        
        order_items_to_create = []
        for item_data in items_data:
            product = item_data['product']
            quantity = item_data['quantity']
            multiplier = item_data.get('unit_multiplier', 1)
            
            product.stock_quantity -= (quantity * multiplier)
            product.save()
            
            order_items_to_create.append(OrderItem(order=order,**item_data))
            
        OrderItem.objects.bulk_create(order_items_to_create)
        return order               
        
        
            
class OrderSerializer(serializers.ModelSerializer):
    items = OrderItemSerializer(many=True, read_only=True)
    id = serializers.UUIDField(read_only=True)
    customer = serializers.StringRelatedField()

    class Meta():
        model = Order
        fields = ['id','customer','placed_at','exchange_rate','items','total_price']  