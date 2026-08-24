"""
Remove `unit_multiplier` from OrderItem and PurchaseItem, without changing a single number.

`unit_multiplier` expressed "3 packs of 12". Every figure in the application multiplied it
back out:

    line total   = quantity * unit_multiplier * unit_price
    stock moved  = quantity * unit_multiplier
    line profit  = (unit_price - unit_cost_price) * quantity * unit_multiplier

So simply dropping the column would divide all three by the multiplier. On the development
database that was 1,154 of 2,840 line items carrying a multiplier of 6 or 12 — i.e. roughly
41% of the history would silently have had its revenue, COGS, profit and analytics rewritten,
with no error raised anywhere.

This migration instead FOLDS the multiplier into the quantity before dropping the column:

    quantity := quantity * unit_multiplier

which leaves all three expressions numerically identical, because each of them contained
exactly one `quantity * unit_multiplier` factor:

    quantity_new * unit_price                          == quantity * unit_multiplier * unit_price
    quantity_new                                       == quantity * unit_multiplier
    (unit_price - unit_cost_price) * quantity_new      == (…) * quantity * unit_multiplier

What is lost is only the *presentation* of the split — a line that read "3 x 12" now reads
"36". That is exactly what the change asked for, and no monetary or stock value moves.

Overflow was checked before writing this: `quantity` is a PositiveSmallIntegerField (max
32767) and the largest folded value in the development data is 500.

REVERSIBILITY: this is a one-way migration and is declared as such. The multiplier cannot be
recovered once folded — 36 could have been 3x12, 6x6, or 36x1, and nothing records which.
`reverse_code` restores the column with its default of 1, which keeps every total correct
(quantity 36 x 1) but does not restore the original pack breakdown.
"""

from django.db import migrations, models


def fold_multiplier_into_quantity(apps, schema_editor):
    OrderItem = apps.get_model('inventory', 'OrderItem')
    PurchaseItem = apps.get_model('inventory', 'PurchaseItem')

    # An F() expression, so this is a single UPDATE per table rather than a row-by-row
    # read/modify/write — these tables grow with every transaction the business records.
    for model in (OrderItem, PurchaseItem):
        model.objects.update(
            quantity=models.F('quantity') * models.F('unit_multiplier')
        )


def unfold_is_not_possible(apps, schema_editor):
    """
    Deliberately a no-op beyond letting the column come back with its default of 1.

    Splitting 36 back into 3 x 12 is not possible — the factorisation was not recorded. Every
    total stays correct at quantity 36 x multiplier 1, which is the honest reconstruction.
    """


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0005_unique_product_barcode'),
    ]

    operations = [
        # Order matters: fold while the column still exists, then drop it.
        migrations.RunPython(fold_multiplier_into_quantity, unfold_is_not_possible),
        migrations.RemoveField(model_name='orderitem', name='unit_multiplier'),
        migrations.RemoveField(model_name='purchaseitem', name='unit_multiplier'),
    ]
