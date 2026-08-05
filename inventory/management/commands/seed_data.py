import random
import urllib.parse
import urllib.request
from datetime import timedelta
from decimal import Decimal
from io import BytesIO
from urllib.error import URLError

from PIL import Image, ImageDraw
from django.contrib.auth.models import Permission, User
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from django_tenants.utils import tenant_context
from faker import Faker

from inventory.models import (
    Category,
    Customer,
    Order,
    OrderItem,
    Product,
    ProductImage,
    Purchase,
    PurchaseItem,
    Supplier,
)
from tenants.models import Domain, Tenant

fake = Faker()

CATEGORY_PRODUCTS = {
    "Electronics": [
        "Wireless Mouse", "Mechanical Keyboard", "27-inch Monitor", "USB-C Hub",
        "Bluetooth Speaker", "Noise-Cancelling Headphones", "Portable SSD 1TB",
        "Smartphone Charger", "Webcam 1080p", "Power Bank 20000mAh",
    ],
    "Home & Kitchen": [
        "Non-Stick Frying Pan", "Electric Kettle", "Coffee Maker", "Blender",
        "Cutlery Set", "Ceramic Dinner Plates", "Toaster Oven", "Air Fryer",
        "Vacuum Flask", "Cutting Board Set",
    ],
    "Clothing": [
        "Men's Cotton T-Shirt", "Women's Denim Jacket", "Running Shoes",
        "Wool Sweater", "Leather Belt", "Summer Dress", "Cargo Pants",
        "Baseball Cap", "Winter Coat", "Sports Socks 3-Pack",
    ],
    "Beauty": [
        "Moisturizing Cream", "Shampoo 500ml", "Perfume 100ml", "Lipstick Set",
        "Sunscreen SPF50", "Hair Dryer", "Electric Shaver", "Nail Polish Kit",
    ],
    "Stationery": [
        "A4 Notebook", "Ballpoint Pen Pack", "Desk Organizer", "Whiteboard Markers",
        "Sticky Notes Pack", "Backpack", "Stapler", "Highlighter Set",
    ],
    "Groceries": [
        "Extra Virgin Olive Oil 1L", "Basmati Rice 5kg", "Roasted Coffee Beans 1kg",
        "Honey Jar 500g", "Pasta 1kg", "Canned Tomatoes", "Dark Chocolate Bar",
        "Green Tea Box",
    ],
    "Toys": [
        "Building Blocks Set", "Remote Control Car", "Puzzle 1000pcs",
        "Plush Teddy Bear", "Board Game", "Action Figure",
    ],
    "Sports": [
        "Yoga Mat", "Adjustable Dumbbells", "Football", "Cycling Helmet",
        "Resistance Bands Set", "Water Bottle 1L",
    ],
}

SUPPLIER_NAMES = [
    "Cedar Trading Co.", "Beirut Wholesale Group", "Levant Import Export",
    "Phoenicia Distributors", "Orient Supply Chain", "Mediterranean Goods Ltd.",
    "Atlas Commercial Partners", "Golden Coast Trading",
]

PLACEHOLDER_COLORS = [
    (0, 122, 255), (52, 199, 89), (255, 149, 0), (255, 45, 85),
    (175, 82, 222), (90, 200, 250), (255, 204, 0), (88, 86, 214),
]


class Command(BaseCommand):
    help = "Seed the database with fake categories, suppliers, customers, products, purchases and orders."

    def add_arguments(self, parser):
        parser.add_argument(
            "--tenant", type=str, default=None,
            help="Tenant schema name to seed into (e.g. tenant1). Created — along with a "
                 "<schema>.localhost domain — if it doesn't already exist. If omitted, seeds "
                 "whatever schema is already active (the old, pre-multi-tenancy behavior).",
        )
        parser.add_argument(
            "--superuser", type=str, default="admin",
            help="Username to confirm/grant explicit inventory permissions for (superusers "
                 "already bypass permission checks, but this makes access explicit and "
                 "verifiable). Skipped if the user doesn't exist.",
        )
        parser.add_argument(
            "--products", type=int, default=40, help="Number of products to create."
        )
        parser.add_argument(
            "--customers", type=int, default=20, help="Number of customers to create."
        )
        parser.add_argument(
            "--purchases", type=int, default=60, help="Number of purchases to create."
        )
        parser.add_argument(
            "--orders", type=int, default=120, help="Number of orders to create."
        )

    def handle(self, *args, **options):
        Faker.seed()
        random.seed()

        tenant_name = options["tenant"]
        if tenant_name:
            tenant = self._ensure_tenant(tenant_name)
            with tenant_context(tenant):
                self._seed_all(options)
        else:
            self._seed_all(options)

        self._grant_superuser_access(options["superuser"])

    def _ensure_tenant(self, schema_name):
        tenant, created = Tenant.objects.get_or_create(
            schema_name=schema_name, defaults={"name": schema_name.capitalize()}
        )
        if created:
            self.stdout.write(f"Tenant schema created: {schema_name}")
        domain_name = f"{schema_name}.localhost"
        domain, created = Domain.objects.get_or_create(
            domain=domain_name, defaults={"tenant": tenant, "is_primary": True}
        )
        if created:
            self.stdout.write(f"Domain created: {domain_name}")
        return tenant

    def _seed_all(self, options):
        with transaction.atomic():
            categories = self._seed_categories()
            suppliers = self._seed_suppliers()
            customers = self._seed_customers(options["customers"])
            products = self._seed_products(categories, suppliers, options["products"])
            self._seed_purchases(products, suppliers, options["purchases"])
            self._seed_orders(products, customers, options["orders"])

        self.stdout.write(self.style.SUCCESS(
            f"Seed complete — categories={Category.objects.count()} "
            f"suppliers={Supplier.objects.count()} customers={Customer.objects.count()} "
            f"products={Product.objects.count()} purchases={Purchase.objects.count()} "
            f"orders={Order.objects.count()}"
        ))

    def _grant_superuser_access(self, username):
        # auth.User/Permission are SHARED_APPS (public schema) — access isn't tenant-scoped,
        # and a real superuser already bypasses permission checks entirely. This just makes
        # that access explicit and independently verifiable, rather than implicit.
        try:
            user = User.objects.get(username=username)
        except User.DoesNotExist:
            self.stdout.write(self.style.WARNING(
                f"Superuser '{username}' not found — skipping permission grant."
            ))
            return

        permissions = Permission.objects.filter(content_type__app_label="inventory")
        user.user_permissions.add(*permissions)
        self.stdout.write(
            f"Granted {permissions.count()} inventory permissions to '{username}' "
            f"(is_superuser={user.is_superuser})"
        )

    def _seed_categories(self):
        categories = {}
        for name in CATEGORY_PRODUCTS:
            category, _ = Category.objects.get_or_create(name=name)
            categories[name] = category
        self.stdout.write(f"Categories ready: {len(categories)}")
        return categories

    def _seed_suppliers(self):
        suppliers = []
        for name in SUPPLIER_NAMES:
            supplier, _ = Supplier.objects.get_or_create(
                name=name, defaults={"phone_number": fake.phone_number()}
            )
            suppliers.append(supplier)
        self.stdout.write(f"Suppliers ready: {len(suppliers)}")
        return suppliers

    def _seed_customers(self, count):
        customers = []
        existing_names = set(Customer.objects.values_list("name", flat=True))
        attempts = 0
        while len(customers) < count and attempts < count * 5:
            attempts += 1
            name = fake.name()
            if name in existing_names:
                continue
            existing_names.add(name)
            customer = Customer.objects.create(
                name=name,
                location=fake.city(),
                phone_number=fake.phone_number(),
            )
            customers.append(customer)
        self.stdout.write(f"Customers ready: {Customer.objects.count()}")
        return list(Customer.objects.all())

    def _placeholder_image(self, label):
        """
        Direct, single-request CDN placeholder (placehold.co) — no redirect hop and a
        tiny (~2-5KB) webp payload, sized/compressed at the source. Tried two
        photo-CDN alternatives first and both had real problems for a script that
        fetches ~100 images per run: Picsum always 302-redirects to its fastly.
        subdomain regardless of URL pattern (verified against both its /seed/ and /id/
        forms), and Unsplash's real CDN (images.unsplash.com), while redirect-free, took
        10s+ on a first request for a given size/format variant (cold cache) — fine for
        one image, not for a batch. Falls back to a generated colored square if the
        network call fails.
        """
        color = random.choice(PLACEHOLDER_COLORS)
        hex_color = "%02x%02x%02x" % color
        initials = "".join(word[0] for word in label.split()[:2]).upper()
        text = urllib.parse.quote(initials)
        url = f"https://placehold.co/400x400/{hex_color}/ffffff.webp?text={text}&font=roboto"
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                content = response.read()
            return ContentFile(content, name=f"{label.lower().replace(' ', '_')}.webp")
        except (URLError, OSError):
            return self._generated_placeholder_image(label)

    def _generated_placeholder_image(self, label):
        color = random.choice(PLACEHOLDER_COLORS)
        img = Image.new("RGB", (400, 400), color=color)
        draw = ImageDraw.Draw(img)
        initials = "".join(word[0] for word in label.split()[:2]).upper()
        draw.text((150, 180), initials, fill=(255, 255, 255))
        buffer = BytesIO()
        img.save(buffer, format="PNG")
        return ContentFile(buffer.getvalue(), name=f"{label.lower().replace(' ', '_')}.png")

    def _seed_products(self, categories, suppliers, count):
        existing_names = set(Product.objects.values_list("name", flat=True))
        pool = []
        for category_name, names in CATEGORY_PRODUCTS.items():
            for name in names:
                pool.append((name, category_name))
        random.shuffle(pool)

        created = []
        for name, category_name in pool:
            if len(created) >= count:
                break
            if name in existing_names:
                continue
            existing_names.add(name)

            cost_price = Decimal(random.randint(2, 200))
            markup = Decimal(str(round(random.uniform(1.2, 2.6), 2)))
            sell_price = (cost_price * markup).quantize(Decimal("0.01"))

            product = Product.objects.create(
                name=name,
                description=fake.sentence(nb_words=12),
                cost_price=cost_price,
                default_sell_price=sell_price,
                stock_quantity=random.randint(0, 300),
                supplier=random.choice(suppliers) if random.random() > 0.1 else None,
                category=categories[category_name],
            )
            for _ in range(random.randint(1, 3)):
                ProductImage.objects.create(
                    product=product, image=self._placeholder_image(name)
                )
            created.append(product)

        self.stdout.write(f"Products created: {len(created)}")
        return list(Product.objects.all())

    def _random_datetime_within(self, days_back):
        now = timezone.now()
        delta_seconds = random.randint(0, days_back * 24 * 3600)
        return now - timedelta(seconds=delta_seconds)

    def _seed_purchases(self, products, suppliers, count):
        created_ids = []
        for _ in range(count):
            supplier = random.choice(suppliers)
            purchase = Purchase.objects.create(
                supplier=supplier,
                exchange_rate=random.randint(88000, 90000),
            )
            for product in random.sample(products, k=random.randint(1, 4)):
                unit_price = (product.cost_price * Decimal(str(round(random.uniform(0.9, 1.1), 2)))).quantize(Decimal("0.01"))
                PurchaseItem.objects.create(
                    purchase_order=purchase,
                    product=product,
                    quantity=random.randint(1, 20),
                    unit_price=unit_price,
                    unit_multiplier=random.choice([1, 1, 1, 6, 12]),
                )
            created_ids.append(purchase.id)

        # placed_at is auto_now_add on save(); back-date via a bulk UPDATE, which
        # writes the given value directly to the DB instead of going through the
        # field's pre_save() auto_now_add override.
        for purchase_id in created_ids:
            Purchase.objects.filter(pk=purchase_id).update(
                placed_at=self._random_datetime_within(330)
            )
        self.stdout.write(f"Purchases created: {len(created_ids)}")

    def _seed_orders(self, products, customers, count):
        created_ids = []
        for _ in range(count):
            customer = random.choice(customers)
            order = Order.objects.create(
                customer=customer,
                exchange_rate=random.randint(88000, 90000),
            )
            for product in random.sample(products, k=random.randint(1, 4)):
                unit_price = (product.default_sell_price * Decimal(str(round(random.uniform(0.95, 1.05), 2)))).quantize(Decimal("0.01"))
                OrderItem.objects.create(
                    order=order,
                    product=product,
                    quantity=random.randint(1, 10),
                    unit_price=unit_price,
                    unit_multiplier=random.choice([1, 1, 1, 6, 12]),
                )
            created_ids.append(order.id)

        for order_id in created_ids:
            Order.objects.filter(pk=order_id).update(
                placed_at=self._random_datetime_within(330)
            )
        self.stdout.write(f"Orders created: {len(created_ids)}")
