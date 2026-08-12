"""
Date windowing for the reporting endpoints.

Deliberately free of DRF and HTTP: the window is the piece that has to be identical across
every queryset a report touches, so it is testable directly rather than only through a view.
A window applied to orders but not to expenses misstates net profit and raises nothing.
"""

from dataclasses import dataclass
from datetime import timedelta

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
