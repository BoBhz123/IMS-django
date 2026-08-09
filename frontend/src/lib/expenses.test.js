import { describe, expect, it } from 'vitest'
import {
  EXPENSE_CATEGORIES,
  categoryLabel,
  toSpentAtISO,
  todayForInput,
} from '@/lib/expenses'

describe('EXPENSE_CATEGORIES', () => {
  it('matches the keys the API accepts', () => {
    expect(EXPENSE_CATEGORIES.map((c) => c.value)).toEqual([
      'rent', 'utilities', 'salaries', 'marketing', 'software',
      'transport', 'maintenance', 'taxes_fees', 'other',
    ])
  })
})

describe('categoryLabel', () => {
  it('renders a known key', () => {
    expect(categoryLabel('taxes_fees')).toBe('Taxes & Fees')
  })

  it('falls back to the raw key rather than showing nothing', () => {
    expect(categoryLabel('helicopters')).toBe('helicopters')
  })

  it('survives null', () => {
    expect(categoryLabel(null)).toBe('—')
  })
})

describe('todayForInput', () => {
  it('is a yyyy-mm-dd string a date input accepts', () => {
    expect(todayForInput()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('toSpentAtISO', () => {
  it('turns a date input value into an ISO timestamp', () => {
    expect(toSpentAtISO('2026-03-15')).toMatch(/^2026-03-15T/)
  })

  it('returns null for empty input so the server default applies', () => {
    expect(toSpentAtISO('')).toBeNull()
  })
})
