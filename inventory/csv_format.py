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


# Excel, LibreOffice and Sheets all execute a cell that opens with one of these.
_FORMULA_LEAD = ('=', '+', '-', '@', '\t', '\r')


def text(value):
    """
    A user-controlled string, defused so a spreadsheet will not run it as a formula.

    Prefixing with an apostrophe is the standard mitigation: the cell displays unchanged and
    the value is preserved, but it is read as text. Dropping or stripping the character
    instead would hide which record the row is about, which is the one thing the owner
    exports the file to find out.

    **Apply this to text cells only.** `-` is in the lead set and `money()` renders a
    negative line profit as `-6.00`; running that through here emits `'-6.00`, which turns
    the numeric columns back into text and silently undoes the export redesign that made
    them summable. `money()` and `iso()` output is generated here, never user input, and
    must not be passed through this function.
    """
    if isinstance(value, str) and value.startswith(_FORMULA_LEAD):
        return "'" + value
    return value
