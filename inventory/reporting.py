"""
Date windowing and settlement arithmetic for the reporting endpoints.

Deliberately free of DRF and HTTP: the window is the piece that has to be identical across
every queryset a report touches, so it is testable directly rather than only through a view.
A window applied to orders but not to expenses misstates net profit and raises nothing.
"""

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from django.db.models import DecimalField, F, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce, Greatest, Least
from django.utils import timezone

# 'all_time' is intentionally absent: it means "no date filtering", the default behaviour.
PERIOD_WINDOW_DAYS = {
    'last_month': 30,
    'last_year': 365,
}


@dataclass(frozen=True)
class DateWindow:
    """
    The date filter a report was asked for, applicable to any queryset.

    `apply` takes the field name because the same window has to reach `Order.placed_at`,
    `Expense.spent_at`, and `OrderItem.order__placed_at`.
    """

    year: str | None = None
    month: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    period: str | None = None

    @classmethod
    def from_query_params(cls, params):
        # `or None` rather than a bare .get(): the SPA sends ?year= with an empty value when
        # its selects are cleared, and filtering on '' raises rather than matching everything.
        return cls(
            year=params.get('year') or None,
            month=params.get('month') or None,
            start_date=params.get('start_date') or None,
            end_date=params.get('end_date') or None,
            period=params.get('period') or None,
        )

    def apply(self, queryset, field):
        if self.period in PERIOD_WINDOW_DAYS:
            cutoff = timezone.now() - timedelta(days=PERIOD_WINDOW_DAYS[self.period])
            queryset = queryset.filter(**{f'{field}__gte': cutoff})
        if self.year:
            queryset = queryset.filter(**{f'{field}__year': self.year})
        if self.month:
            queryset = queryset.filter(**{f'{field}__month': self.month})
        if self.start_date:
            queryset = queryset.filter(**{f'{field}__date__gte': self.start_date})
        if self.end_date:
            queryset = queryset.filter(**{f'{field}__date__lte': self.end_date})
        return queryset


# Wider than the per-unit columns for the same reason paid_amount is: these hold sums over a
# whole account's history, not a single line's price.
MONEY = DecimalField(max_digits=14, decimal_places=2)
ZERO = Value(Decimal('0.00'), output_field=MONEY)


def line_total_subquery(model):
    """
    Each transaction's own total, as a correlated subquery rather than a join.

    This exists because of a trap that produces no error and no obvious wrongness:

        orders.aggregate(revenue=Sum(LINE_TOTAL), collected=Sum('paid_amount'))

    LINE_TOTAL traverses `items`, so the query fans out to one row per line — and
    `paid_amount`, which lives on the order itself, is then counted once per line. A
    three-line order that was paid $100 reports $300 collected. Revenue stays correct, so
    the figure is wrong only in the column nobody has a second source for, and it is wrong
    by a factor that changes with basket size. Nothing raises.

    Both Purchase and Order name the reverse relation `items`, so the child model and its FK
    are read off the relation instead of being passed in — one helper covers both, and it
    cannot be pointed at the wrong child table by a typo.
    """
    relation = model._meta.get_field('items')
    child, fk = relation.related_model, relation.field.name
    return Coalesce(
        Subquery(
            child.objects
            .filter(**{fk: OuterRef('pk')})
            .values(fk)
            .annotate(total=Sum(F('quantity') * F('unit_price'), output_field=MONEY))
            .values('total'),
            output_field=MONEY,
        ),
        # A transaction with no lines is worth 0, not NULL — otherwise it poisons every sum
        # it takes part in.
        ZERO,
    )


def with_settlement(queryset):
    """
    Annotate `settled_total`, `settled_collected` and `settled_outstanding` per transaction.

    Both derived figures are clamped per row, never across the queryset:

    * `settled_collected` is capped at the transaction's own total. Overpayment is routine
      here (a cash sale rounded up), but the excess is a customer credit, not revenue — and
      capping is what keeps `collected + outstanding == total` exactly, which is the only
      reason the dashboard tiles can be read as adding up.
    * `settled_outstanding` floors at zero, matching `PaymentTrackedTransaction.remaining_amount`.
      Subtracting the totals globally instead would let one overpaid order silently cancel
      out another customer's real debt.
    """
    return (
        queryset
        .annotate(settled_total=line_total_subquery(queryset.model))
        .annotate(
            settled_collected=Least(F('paid_amount'), F('settled_total'), output_field=MONEY),
            settled_outstanding=Greatest(
                F('settled_total') - F('paid_amount'), ZERO, output_field=MONEY,
            ),
        )
    )


def settlement_totals(queryset):
    """Account-wide collected/outstanding for a window. One query, no fan-out."""
    totals = with_settlement(queryset).aggregate(
        collected=Sum('settled_collected'),
        outstanding=Sum('settled_outstanding'),
    )
    return {key: value or Decimal('0.00') for key, value in totals.items()}
