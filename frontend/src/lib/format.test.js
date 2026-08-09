import { describe, expect, it } from 'vitest'
import { fillSeriesGaps } from '@/lib/format'

describe('fillSeriesGaps', () => {
  const window = { start: '2026-03-01', end: '2026-03-03', stepDays: 1 }

  it('zero-fills the periods the API had no rows for', () => {
    const filled = fillSeriesGaps(
      [{ period: '2026-03-02', total_revenue: 10, total_costs: 4, total_expenses: 2 }],
      window,
    )
    expect(filled.map((row) => row.period)).toEqual([
      '2026-03-01', '2026-03-02', '2026-03-03',
    ])
    expect(filled[0]).toEqual({
      period: '2026-03-01', total_revenue: 0, total_costs: 0, total_expenses: 0,
    })
  })

  it('carries total_expenses through', () => {
    // Dropping this key silently renders the dashboard's Expenses sparkline as a flat zero
    // line rather than failing — the only signal would be a chart that looks plausible.
    const filled = fillSeriesGaps(
      [{ period: '2026-03-02', total_revenue: 10, total_costs: 4, total_expenses: 7 }],
      window,
    )
    expect(filled[1].total_expenses).toBe(7)
  })

  it('defaults a missing total_expenses to zero rather than undefined', () => {
    const filled = fillSeriesGaps(
      [{ period: '2026-03-02', total_revenue: 10, total_costs: 4 }],
      window,
    )
    expect(filled[1].total_expenses).toBe(0)
  })
})
