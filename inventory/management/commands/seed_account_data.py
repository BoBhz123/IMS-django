"""
Seed realistic demo data into ONE existing account, identified by its owner's email.

Separate from `seed_data` rather than another flag on it, because the two have opposite
safety properties. `seed_data` builds a demo world: it resolves the account by *name* and
creates it — and its owner login — when missing, which is right for a scratch database and
wrong for production, where a typo silently conscripts a new empty account.

This command never creates an account, a user or a membership. It resolves the account from
the user, and refuses to do anything at all if that lookup does not land on exactly one
account. Every row it writes carries that account's id.

It also keeps stock honest, which `seed_data` deliberately does not bother with: there,
products get a random stock_quantity and the transactions are decoration, so the number on
the shelf has no relationship to the movements behind it. Here, products open at zero, every
purchase adds units and every sale removes them, and the closing stock_quantity is exactly
what those movements leave behind. Analytics, COGS and stock levels then agree with each
other, which is the whole point of looking at seeded data.
"""

import random
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from accounts.models import Membership
from inventory.models import (
    Category, Customer, Expense, ExpenseCategory, Order, OrderItem, Product, Purchase,
    PurchaseItem, Supplier,
)

# Real product names per category rather than faker's word salad: the point of seeded data is
# to look at a dashboard and judge whether it reads correctly, and "Sleek Granite Chair" does
# not help with that. Each entry is (name, cost_price_usd).
CATALOGUE = {
    'Electronics': [
        ('Logitech MX Master 3S Mouse', 62), ('Anker 65W USB-C Charger', 28),
        ('Samsung T7 1TB SSD', 78), ('Sony WH-1000XM5 Headphones', 240),
        ('Xiaomi 20000mAh Power Bank', 19),
    ],
    'Office Supplies': [
        ('A4 Copy Paper (500 sheets)', 4), ('Pilot G2 Gel Pens (12pk)', 7),
        ('Stapler Heavy Duty 50-sheet', 11), ('Whiteboard Markers (8pk)', 6),
        ('Lever Arch Files (10pk)', 14),
    ],
    'Components': [
        ('Arduino Uno R4 Board', 21), ('Raspberry Pi 5 8GB', 74),
        ('Breadboard 830-point', 3), ('Jumper Wire Set (120pc)', 5),
        ('NEMA 17 Stepper Motor', 12),
    ],
    'Accessories': [
        ('USB-C to HDMI Cable 2m', 9), ('Laptop Stand Aluminium', 23),
        ('Monitor Arm Single', 34), ('Desk Mat Felt 90x40', 13),
        ('Cable Management Sleeve', 6),
    ],
}

SUPPLIERS = [
    ('Beirut Tech Distribution', '+961 1 234 567'),
    ('Levant Office Wholesale', '+961 3 987 654'),
    ('Hamra Electronics Import', '+961 71 445 221'),
]

CUSTOMERS = [
    ('Rami Haddad', 'Hamra, Beirut', '+961 70 111 222'),
    ('Layal Nassar', 'Achrafieh, Beirut', '+961 71 333 444'),
    ('Karim Aoun', 'Jounieh', '+961 76 555 666'),
    ('Nour Khoury', 'Tripoli', '+961 78 777 888'),
    ('Ziad Mansour', 'Saida', '+961 3 999 000'),
]


class Command(BaseCommand):
    help = (
        "Seed demo categories, products, purchases, orders and expenses into the existing "
        "account owned by --email. Never creates an account or a user."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--email', required=True,
            help="Owner's login/email. The account is resolved through this user's "
                 "Membership; nothing is created if the lookup fails.",
        )
        parser.add_argument('--categories', type=int, default=4)
        parser.add_argument('--products', type=int, default=12)
        parser.add_argument('--purchases', type=int, default=6)
        parser.add_argument('--orders', type=int, default=8)
        parser.add_argument('--expenses', type=int, default=6)
        parser.add_argument(
            '--days', type=int, default=120,
            help='Spread transactions over this many days back from today.',
        )
        parser.add_argument(
            '--dry-run', action='store_true',
            help='Roll the transaction back at the end. Everything is still executed, so '
                 'constraint violations surface exactly as they would for real.',
        )

    def handle(self, *args, **options):
        account = self._resolve_account(options['email'])

        # One transaction for the whole seed: a run that dies halfway through would
        # otherwise leave products with stock that no purchase accounts for.
        try:
            with transaction.atomic():
                summary = self._seed(account, options)
                if options['dry_run']:
                    raise _DryRun(summary)
        except _DryRun as rollback:
            self._report(account, rollback.summary, options['email'], rolled_back=True)
            return

        self._report(account, summary, options['email'], rolled_back=False)

    # --- account resolution --------------------------------------------------------------

    def _resolve_account(self, email):
        """
        The account this data belongs to, or a hard stop.

        Deliberately unforgiving. Every alternative to failing here — creating the missing
        user, falling back to the first account, matching on a name — writes rows into
        somebody else's workspace when the input is slightly wrong, and this command exists
        to be run against production.
        """
        email = email.strip().lower()
        # Registration lowercases the email into username, but a superuser made with
        # createsuperuser may not have, so match either field case-insensitively.
        users = list(User.objects.filter(username__iexact=email) | User.objects.filter(email__iexact=email))
        if not users:
            raise CommandError(f"No user with email or username '{email}'.")
        if len(users) > 1:
            raise CommandError(
                f"'{email}' matches {len(users)} users ({', '.join(u.username for u in users)}). "
                f"Refusing to guess which account to seed."
            )

        user = users[0]
        membership = Membership.objects.filter(user=user).select_related('account').first()
        if membership is None:
            raise CommandError(
                f"'{email}' has no Membership, so it owns no account. A platform superuser "
                f"has no workspace to seed — sign up through the app first."
            )

        self.stdout.write(
            f"Target: account #{membership.account_id} '{membership.account.name}' "
            f"(owner {user.username})"
        )
        return membership.account

    # --- seeding -------------------------------------------------------------------------

    def _seed(self, account, options):
        categories = self._seed_categories(account, options['categories'])
        suppliers = self._seed_suppliers(account)
        customers = self._seed_customers(account)
        products = self._seed_products(account, categories, suppliers, options['products'])

        # Purchases land in the older half of the window and sales in the newer half, so no
        # sale predates the delivery that supplied it. Stock correctness does not depend on
        # this — the running pool below guarantees that — but a dashboard where March's sales
        # precede April's first delivery looks wrong to anyone reading it.
        days = options['days']
        stock = self._seed_purchases(
            account, products, suppliers, options['purchases'], days, days // 2,
        )
        orders = self._seed_orders(
            account, products, customers, options['orders'], stock, days // 2, 0,
        )
        expenses = self._seed_expenses(account, options['expenses'], days)

        # Closing stock is opening (0) + purchased - sold, per product. Written once at the
        # end rather than mutated per transaction: these rows are built directly, not through
        # the serializers that normally maintain stock, so nothing else is keeping it true.
        for product in products:
            product.stock_quantity = stock[product.id]
            product.save(update_fields=['stock_quantity'])

        return {
            'categories': len(categories), 'suppliers': len(suppliers),
            'customers': len(customers), 'products': len(products),
            'purchases': options['purchases'], 'orders': orders, 'expenses': expenses,
        }

    def _when(self, newest_days_ago, oldest_days_ago):
        """A random instant between the two offsets, as a timezone-aware datetime."""
        low, high = sorted((newest_days_ago, oldest_days_ago))
        return timezone.now() - timedelta(
            seconds=random.randint(low * 86400, max(high * 86400, low * 86400 + 1))
        )

    def _seed_categories(self, account, count):
        names = list(CATALOGUE)[:count]
        categories = {}
        for name in names:
            # get_or_create, not create: Category has a per-account unique name, and this
            # command is expected to be run more than once against the same account.
            categories[name], _ = Category.objects.get_or_create(name=name, account=account)
        return categories

    def _seed_suppliers(self, account):
        suppliers = []
        for name, phone in SUPPLIERS:
            supplier, _ = Supplier.objects.get_or_create(
                name=name, account=account, defaults={'phone_number': phone},
            )
            suppliers.append(supplier)
        return suppliers

    def _seed_customers(self, account):
        customers = []
        for name, location, phone in CUSTOMERS:
            customer, _ = Customer.objects.get_or_create(
                name=name, account=account,
                defaults={'location': location, 'phone_number': phone},
            )
            customers.append(customer)
        return customers

    def _seed_products(self, account, categories, suppliers, count):
        taken_names = set(
            Product.objects.for_account(account).values_list('name', flat=True)
        )
        taken_barcodes = set(
            Product.objects.for_account(account)
            .exclude(barcode__isnull=True).values_list('barcode', flat=True)
        )

        # Only the categories actually created — --categories may have trimmed the list, and
        # drawing a product from a category that was not created would fail the FK.
        pool = [
            (name, cost, category_name)
            for category_name in categories
            for name, cost in CATALOGUE[category_name]
        ]
        random.shuffle(pool)

        products = []
        for name, cost, category_name in pool:
            if len(products) >= count:
                break
            if name in taken_names:
                continue
            taken_names.add(name)

            cost_price = Decimal(str(cost))
            # 1.25x–1.9x markup, rounded to cents. Realistic retail spread, and it keeps
            # gross profit positive so the dashboard's margin tiles show something sane.
            sell_price = (cost_price * Decimal(str(round(random.uniform(1.25, 1.9), 2)))
                          ).quantize(Decimal('0.01'))

            barcode = None
            if random.random() > 0.2:
                # Unique per account, and the field is optional — leave a fifth of them
                # blank so the UI's "no barcode" path is represented too.
                while barcode is None or barcode in taken_barcodes:
                    barcode = str(random.randint(1000000000000, 9999999999999))
                taken_barcodes.add(barcode)

            products.append(Product.objects.create(
                account=account,
                name=name,
                description=f'{name} — {category_name.lower()} stock item.',
                cost_price=cost_price,
                default_sell_price=sell_price,
                # Opens at zero; the purchases below are what put units on the shelf.
                stock_quantity=0,
                category=categories[category_name],
                supplier=random.choice(suppliers),
                barcode=barcode,
            ))
        return products

    def _seed_purchases(self, account, products, suppliers, count, oldest, newest):
        """Creates the purchases and returns {product_id: units received}."""
        stock = {product.id: 0 for product in products}

        for _ in range(count):
            purchase = Purchase.objects.create(
                account=account,
                supplier=random.choice(suppliers),
                exchange_rate=random.randint(88000, 90000),
            )
            for product in random.sample(products, k=min(len(products), random.randint(2, 4))):
                quantity = random.randint(4, 25)
                multiplier = random.choice([1, 1, 1, 6, 12])
                PurchaseItem.objects.create(
                    purchase_order=purchase,
                    product=product,
                    quantity=quantity,
                    unit_multiplier=multiplier,
                    # Slight variation around the product's cost — a real supplier price
                    # moves, and a flat cost makes every margin identical.
                    unit_price=(product.cost_price * Decimal(
                        str(round(random.uniform(0.92, 1.08), 2))
                    )).quantize(Decimal('0.01')),
                )
                stock[product.id] += quantity * multiplier

            # placed_at is auto_now_add, which ignores any value assigned before save().
            # A queryset .update() writes straight to the column, bypassing pre_save().
            Purchase.objects.filter(pk=purchase.pk).update(
                placed_at=self._when(newest, oldest)
            )
        return stock

    def _seed_orders(self, account, products, customers, count, stock, oldest, newest):
        """Creates sales, drawing down `stock` in place. Returns how many were created."""
        created = 0
        for _ in range(count):
            # Only products that actually have units left can be sold. Phase 1's rule is that
            # stock is consumed as quantity * unit_multiplier, so the pool is in units and
            # the line is built to fit what is left.
            available = [p for p in products if stock[p.id] > 0]
            if not available:
                break

            order = Order.objects.create(
                account=account,
                customer=random.choice(customers),
                exchange_rate=random.randint(88000, 90000),
            )
            lines = 0
            for product in random.sample(available, k=min(len(available), random.randint(1, 3))):
                units = stock[product.id]
                if units < 1:
                    continue
                # Never the whole shelf: leave something on hand so the products screen has
                # stock to show, and so a sale is a sale rather than a liquidation.
                take = max(1, min(units, random.randint(1, max(1, units // 3))))
                OrderItem.objects.create(
                    order=order,
                    product=product,
                    quantity=take,
                    unit_multiplier=1,
                    unit_price=(product.default_sell_price * Decimal(
                        str(round(random.uniform(0.95, 1.05), 2))
                    )).quantize(Decimal('0.01')),
                    # Explicit, not left to OrderItem.save()'s fallback: this is the cost as
                    # it stood at the sale, and it is what every profit figure reads.
                    unit_cost_price=product.cost_price,
                )
                stock[product.id] -= take
                lines += 1

            if lines == 0:
                # An order with no items would break the "at least one item" contract the
                # API enforces, and totals to zero on every report.
                order.delete()
                continue

            Order.objects.filter(pk=order.pk).update(placed_at=self._when(newest, oldest))
            created += 1
        return created

    def _seed_expenses(self, account, count, days):
        descriptions = {
            'rent': 'Shop rent', 'utilities': 'Electricity and water',
            'salaries': 'Staff wages', 'marketing': 'Instagram ads',
            'software': 'Accounting software', 'transport': 'Delivery fuel',
        }
        keys = list(descriptions)
        for index in range(count):
            category = keys[index % len(keys)]
            Expense.objects.create(
                account=account,
                description=descriptions[category],
                amount=Decimal(str(round(random.uniform(40, 700), 2))),
                category=category,
                # spent_at is default=timezone.now, not auto_now_add, so it takes a value
                # directly and needs no follow-up UPDATE.
                spent_at=self._when(0, days),
            )
        return count

    # --- reporting -----------------------------------------------------------------------

    def _report(self, account, summary, email, rolled_back):
        scoped = lambda model: model.objects.for_account(account).count()

        self.stdout.write('')
        self.stdout.write(
            f"Created {summary['categories']} categories, {summary['products']} products, "
            f"{summary['purchases']} purchases and {summary['orders']} orders "
            f"({summary['purchases'] + summary['orders']} transactions), "
            f"{summary['customers']} customers, {summary['suppliers']} suppliers and "
            f"{summary['expenses']} expenses for {email}."
        )
        self.stdout.write(
            f"Account #{account.id} '{account.name}' now holds — "
            f"categories={scoped(Category)} suppliers={scoped(Supplier)} "
            f"customers={scoped(Customer)} products={scoped(Product)} "
            f"purchases={scoped(Purchase)} orders={scoped(Order)} expenses={scoped(Expense)}"
        )
        if rolled_back:
            self.stdout.write(self.style.WARNING(
                'DRY RUN — everything above was rolled back; nothing was written.'
            ))
        else:
            self.stdout.write(self.style.SUCCESS('Seed complete.'))


class _DryRun(Exception):
    """Rolls the atomic block back while carrying the summary out with it."""

    def __init__(self, summary):
        super().__init__('dry run')
        self.summary = summary
