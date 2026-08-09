// Mirrors inventory.models.ExpenseCategory. The values are the stable keys the API stores;
// the labels are display only.
export const EXPENSE_CATEGORIES = [
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'salaries', label: 'Salaries' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'software', label: 'Software' },
  { value: 'transport', label: 'Transport' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'taxes_fees', label: 'Taxes & Fees' },
  { value: 'other', label: 'Other' },
]

const LABELS = new Map(EXPENSE_CATEGORIES.map(({ value, label }) => [value, label]))

/** Falls back to the raw key: a category added server-side should read oddly, not vanish. */
export function categoryLabel(key) {
  if (!key) return '—'
  return LABELS.get(key) ?? key
}

/** yyyy-mm-dd in local time, for a date input's default value. */
export function todayForInput() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * A date input gives a bare yyyy-mm-dd; spent_at is a timestamp. Null when empty so the
 * server's default=timezone.now applies rather than sending an invalid value.
 *
 * Midday rather than midnight, so a timezone offset cannot roll a backdated expense into
 * the neighbouring day and, at a month boundary, the neighbouring month.
 */
export function toSpentAtISO(dateString) {
  if (!dateString) return null
  return new Date(`${dateString}T12:00:00`).toISOString()
}
