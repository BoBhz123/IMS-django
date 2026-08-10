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
    // Exact match on purpose: it pins the full row shape, so a key added to the series
    // without being zero-filled here fails loudly instead of rendering as undefined.
    expect(filled[0]).toEqual({
      period: '2026-03-01', total_revenue: 0, total_costs: 0, total_expenses: 0,
      total_cogs: 0, gross_profit: 0, net_profit: 0,
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

describe('fillSeriesGaps profit keys', () => {
  const window = { start: '2026-03-01', end: '2026-03-03', stepDays: 1 }
  const row = {
    period: '2026-03-02',
    total_revenue: 100, total_costs: 20, total_cogs: 40,
    gross_profit: 60, total_expenses: 25, net_profit: 35,
  }

  it('carries cogs, gross profit and net profit through', () => {
    const filled = fillSeriesGaps([row], window)
    expect(filled[1].total_cogs).toBe(40)
    expect(filled[1].gross_profit).toBe(60)
    expect(filled[1].net_profit).toBe(35)
  })

  it('zero-fills them for periods with no data', () => {
    const filled = fillSeriesGaps([row], window)
    expect(filled[0].gross_profit).toBe(0)
    expect(filled[0].net_profit).toBe(0)
    expect(filled[0].total_cogs).toBe(0)
  })

  it('preserves a negative net profit rather than zeroing it', () => {
    const loss = { ...row, net_profit: -80 }
    expect(fillSeriesGaps([loss], window)[1].net_profit).toBe(-80)
  })
})
