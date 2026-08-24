import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PaymentBadge } from './PaymentBadge'

const usd = (value) => `$${Number(value).toFixed(2)}`

describe('PaymentBadge', () => {
  it('labels a fully paid transaction', () => {
    render(<PaymentBadge status="PAID" />)
    expect(screen.getByText('PAID')).toBeInTheDocument()
  })

  it('labels an unpaid transaction', () => {
    render(<PaymentBadge status="UNPAID" />)
    expect(screen.getByText('UNPAID')).toBeInTheDocument()
  })

  it('shows the outstanding balance on a partial payment', () => {
    // The number is the point: "partially paid" tells the user to open the row, "$48.00 due"
    // tells them whether they need to.
    render(<PaymentBadge status="PARTIALLY_PAID" remaining={48} formatAmount={usd} />)
    expect(screen.getByText('Partial ($48.00 due)')).toBeInTheDocument()
  })

  it('falls back to the plain label when no formatter is supplied', () => {
    // Callers outside a CurrencyContext still get a readable badge rather than a raw number in
    // an unknown currency.
    render(<PaymentBadge status="PARTIALLY_PAID" remaining={48} />)
    expect(screen.getByText('PARTIALLY PAID')).toBeInTheDocument()
  })

  it('does not render a due figure for a fully paid transaction', () => {
    // "Paid ($0.00 due)" is noise.
    render(<PaymentBadge status="PAID" remaining={0} formatAmount={usd} />)
    expect(screen.getByText('PAID')).toBeInTheDocument()
    expect(screen.queryByText(/due/)).not.toBeInTheDocument()
  })

  it('does not render a due figure when the balance has been cleared to zero', () => {
    render(<PaymentBadge status="PARTIALLY_PAID" remaining={0} formatAmount={usd} />)
    expect(screen.getByText('PARTIALLY PAID')).toBeInTheDocument()
  })

  it('treats an unknown status as unpaid rather than rendering nothing', () => {
    // An older payload, or a status added server-side before the SPA ships.
    render(<PaymentBadge status={undefined} />)
    expect(screen.getByText('UNPAID')).toBeInTheDocument()
  })
})
