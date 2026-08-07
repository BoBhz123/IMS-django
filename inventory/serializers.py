from collections import defaultdict

from rest_framework import serializers
from django.db import transaction
from django.db.models import F
from .models import Product , Category,Purchase,PurchaseItem,Order,OrderItem,Supplier,ProductImage,Customer
import uuid


def _units_by_product_id(items_data):
    """
    Units each product gives up (or gains), keyed by product id.

    Aggregating by id — rather than walking items one at a time — is what makes duplicate
    lines for the same product behave. DRF also hands back a *separate* Product instance
    per item, so any per-item read-modify-write of stock_quantity operates on a stale copy.
    """
    totals = defaultdict(int)
    for item in items_data:
        totals[item['product'].id] += item['quantity'] * item.get('unit_multiplier', 1)
    return totals


def _insufficient_stock_errors(units_by_id, products):
    return [
        f"Insufficient stock for '{product.name}': "
        f"requested {units_by_id[product.id]}, available {product.stock_quantity}."
        for product in products
        if units_by_id[product.id] > product.stock_quantity
    ]

class ProductImageSerializer(serializers.ModelSerializer):
    def create(self, validated_data):
        product_id = self.context['product_id']
        return ProductImage.objects.create(product_id=product_id, **validated_data)

    class Meta:
        model = ProductImage
        fields = ['id', 'image']





class ProductSerializer(serializers.ModelSerializer):
    images = ProductImageSerializer(many=True, read_only=True)
    class Meta():
        model = Product
        fields = ['id','name','category','supplier','description','cost_price','default_sell_price','profit','stock_quantity','images']
        
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
        items_data = validated_data.pop('items', [])
        units_by_id = _units_by_product_id(items_data)

        purchase = Purchase.objects.create(**validated_data)
        PurchaseItem.objects.bulk_create(
            [PurchaseItem(purchase_order=purchase, **item_data) for item_data in items_data]
        )

        # Purchases have no ceiling to validate against, but they have the same
        # stale-instance problem as orders when one product appears on two lines.
        for product_id, units in units_by_id.items():
            Product.objects.filter(id=product_id).update(
                stock_quantity=F('stock_quantity') + units
            )
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
        fields = ['product','quantity','unit_multiplier','unit_price','profit']
        
        
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
        
    def validate_items(self, items):
        if not items:
            raise serializers.ValidationError("An order must contain at least one item.")

        units_by_id = _units_by_product_id(items)
        products = Product.objects.filter(id__in=units_by_id)
        errors = _insufficient_stock_errors(units_by_id, products)
        if errors:
            raise serializers.ValidationError(errors)
        return items

    @transaction.atomic
    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        units_by_id = _units_by_product_id(items_data)

        # validate_items ran outside this transaction, so two orders placed at the same
        # instant can both pass it and both deduct. Re-reading under a row lock and
        # re-checking makes the second one fail instead of driving stock negative.
        locked = Product.objects.select_for_update().filter(id__in=units_by_id)
        errors = _insufficient_stock_errors(units_by_id, locked)
        if errors:
            raise serializers.ValidationError({'items': errors})

        order = Order.objects.create(**validated_data)
        OrderItem.objects.bulk_create(
            [OrderItem(order=order, **item_data) for item_data in items_data]
        )

        # One UPDATE per product, computed in the database, rather than a save() per line.
        for product_id, units in units_by_id.items():
            Product.objects.filter(id=product_id).update(
                stock_quantity=F('stock_quantity') - units
            )
        return order
        
        
            
class OrderSerializer(serializers.ModelSerializer):
    items = OrderItemSerializer(many=True, read_only=True)
    id = serializers.UUIDField(read_only=True)
    customer = serializers.StringRelatedField()

    class Meta():
        model = Order
        fields = ['id','customer','placed_at','exchange_rate','items','total_price','total_profit']  