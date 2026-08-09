"""
Cell formatting shared by every CSV export.

There are four exporters — two API views in `views.py` and two admin actions in `admin.py`
with near-identical names — and they already differ on which columns they carry. Formatting
is the one thing they must not also differ on, so it lives here rather than being retyped
in each.
"""


def money(value):
    """
    A bare number for a CSV cell — no '$', no thousands separators.

    Spreadsheets and BI tools read "$1,234.00" as text and silently refuse to sum the
    column, which defeats the point of exporting. The separator is the worse half: a comma
    inside an unquoted numeric cell splits it in two and shifts every column after it.
    """
    return f'{value:.2f}'


def iso(value):
    """
    ISO 8601 to the second — the format every spreadsheet and BI tool parses as a date.

    Rendered from the stored (UTC) value, exactly as the previous "%Y-%m-%d %H:%M" did; this
    changed the format, not the timezone.
    """
    return value.strftime('%Y-%m-%dT%H:%M:%S')
