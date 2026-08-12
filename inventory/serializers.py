from collections import defaultdict

from rest_framework import serializers
from django.db import transaction
from django.db.models import F
from .models import Product , Category,Purchase,PurchaseItem,Order,OrderItem,Supplier,ProductImage,Customer,Expense
import uuid


class AccountScopedSerializerMixin:
    """
    Narrows every relational field's queryset to the requesting account.

    Scoping get_queryset protects reads. Without this, a caller can still POST a payload
    referencing another account's row by id and DRF will resolve it happily — the write
    path is where cross-account data actually leaks.

    Applied in get_fields() rather than __init__ because a nested serializer is constructed
    twice before it ever sees a request — once when the class body runs, and again by DRF's
    Field.__deepcopy__ — both times unbound, with an empty context. Reading the account there
    would freeze `product` to .none() permanently and reject every order. get_fields() is
    called lazily on first access to .fields, by which point the child is bound and
    self.context resolves through root to the viewset's context.
    """

    #: field name -> model, for fields whose queryset must be account-scoped.
    account_scoped_fields = {}

    def get_fields(self):
        fields = super().get_fields()
        account = self.context.get('account')
        for field_name, model in self.account_scoped_fields.items():
            field = fields.get(field_name)
            if field is None:
                continue
            field.queryset = (
                model.objects.for_account(account) if account else model.objects.none()
            )
        return fields


class AccountUniqueNameMixin:
    """
    Validates a per-account unique name in the serializer instead of at the database.

    The models carry `UniqueConstraint(fields=['account', 'name'])`, but DRF cannot generate a
    validator for it: `account` is not a serializer field — it is stamped in `perform_create` —
    so DRF sees only `name` and considers it unconstrained. The constraint then fires in the
    database as an `IntegrityError`, which reaches the client as an uncaught 500 rather than a
    400 naming the field. Typing a name that already exists is an everyday user action, not an
    exceptional one.
    """

    #: model whose (account, name) pair must stay unique.
    unique_name_model = None
    unique_name_message = 'You already have one with this name.'

    def validate_name(self, value):
        name = value.strip()
        account = self.context.get('account')
        if account is None or self.unique_name_model is None:
            return name

        clashes = self.unique_name_model.objects.filter(account=account, name__iexact=name)
        if self.instance is not None:
            clashes = clashes.exclude(pk=self.instance.pk)
        if clashes.exists():
            raise serializers.ValidationError(self.unique_name_message)
        return name


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





class ProductSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'category': Category, 'supplier': Supplier}

    images = ProductImageSerializer(many=True, read_only=True)

    def validate_barcode(self, value):
        """
        One code, one product — checked here as well as in the database.

        Same reasoning as AccountUniqueNameMixin: `account` is stamped in perform_create and
        is not a serializer field, so DRF sees `barcode` as unconstrained and the
        UniqueConstraint would surface as an uncaught IntegrityError 500. Scanning the wrong
        box is an everyday mistake and deserves a field error.

        Stripped before comparing because Product.save() strips before storing — otherwise a
        trailing space walks past this check and hits the constraint anyway.
        """
        barcode = (value or '').strip()
        account = self.context.get('account')
        if not barcode or account is None:
            return barcode

        clashes = Product.objects.filter(account=account, barcode=barcode)
        if self.instance is not None:
            clashes = clashes.exclude(pk=self.instance.pk)
        if clashes.exists():
            raise serializers.ValidationError(
                'Another product already uses this barcode.'
            )
        return barcode

    class Meta():
        model = Product
        # allow_blank so the SPA can clear the field by sending '' — Product.save()
        # normalizes that to NULL rather than storing an empty string.
        extra_kwargs = {'barcode': {'allow_blank': True}}
        fields = ['id','name','category','supplier','description','cost_price','default_sell_price','profit','stock_quantity','barcode','images']
        
class SimpleProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'name', 'default_sell_price']    
        
class CategorySerializer(AccountUniqueNameMixin, serializers.ModelSerializer):
    # iexact, so "Drinks" and "drinks" cannot coexist. Deliberately stricter than the database
    # constraint, which is case-sensitive: two categories differing only in case are
    # indistinguishable in a dropdown.
    unique_name_model = Category
    unique_name_message = 'You already have a category with this name.'

    product_count = serializers.SerializerMethodField()

    class Meta():
        model = Category
        fields = ['id','name','product_count']

    def get_product_count(self, category):
        # Annotated by CategoryViewSet for list/retrieve. A category that has just been created
        # or renamed comes back off serializer.save() with no annotation, so fall back rather
        # than raise — 0 is the right answer for a new one anyway.
        count = getattr(category, 'product_count', None)
        return category.products.count() if count is None else count
        
        
class CreatePurchaseItemSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'product': Product}

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
        
class CreatePurchaseSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'supplier': Supplier}

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
        
        
class CreateOrderItemSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'product': Product}

    class Meta:
        model = OrderItem
        fields = ['product', 'quantity', 'unit_multiplier', 'unit_price']
 
        
class OrderItemSerializer(serializers.ModelSerializer):
    class Meta():
        model =OrderItem
        fields = ['product','quantity','unit_multiplier','unit_price','profit']
        
        
class CreateOrderSerializer(AccountScopedSerializerMixin, serializers.ModelSerializer):
    account_scoped_fields = {'customer': Customer}

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

        # bulk_create bypasses OrderItem.save(), so the snapshot is taken here. Read off the
        # rows already locked above rather than re-querying: that is the cost as it stood at
        # the instant this sale was committed.
        cost_by_product_id = {product.id: product.cost_price for product in locked}

        order = Order.objects.create(**validated_data)
        OrderItem.objects.bulk_create([
            OrderItem(
                order=order,
                unit_cost_price=cost_by_product_id[item_data['product'].id],
                **item_data,
            )
            for item_data in items_data
        ])

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

class ExpenseSerializer(serializers.ModelSerializer):
    """
    No AccountScopedSerializerMixin here, and that is not an omission: Expense has no
    relational field other than `account`, so there is nothing to narrow. The account is
    stamped by AccountScopedMixin on the viewset and is not writable.
    """

    category_display = serializers.CharField(source='get_category_display', read_only=True)

    class Meta:
        model = Expense
        fields = [
            'id', 'description', 'amount', 'category', 'category_display',
            'spent_at', 'created_at',
        ]
        read_only_fields = ['id', 'created_at']
