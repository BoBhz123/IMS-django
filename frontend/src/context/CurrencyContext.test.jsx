import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthContext } from '@/context/AuthContext'
import { CurrencyProvider, useCurrency } from '@/context/CurrencyContext'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), patch: vi.fn() },
}))

const { api } = await import('@/lib/api')

/** Prints everything a consumer can branch on, so one render covers the whole contract. */
function Probe() {
  const {
    currency, primaryCurrency, enableDualCurrency, showExchangeRate,
    formatAmount, formatSecondary, toggleCurrency,
  } = useCurrency()
  return (
    <div>
      <span data-testid="currency">{currency}</span>
      <span data-testid="primary">{primaryCurrency}</span>
      <span data-testid="dual">{String(enableDualCurrency)}</span>
      <span data-testid="show-rate">{String(showExchangeRate)}</span>
      <span data-testid="amount">{formatAmount(10, 89000)}</span>
      {/* `?? 'none'` rather than a boolean: the whole point of formatSecondary is that it
          returns null when nothing may be shown, and callers render on that. */}
      <span data-testid="secondary">{formatSecondary(10, 89000) ?? 'none'}</span>
      <button type="button" onClick={toggleCurrency}>toggle</button>
    </div>
  )
}

function renderProbe({ status = 'authenticated' } = {}) {
  return render(
    <AuthContext.Provider value={{ status }}>
      <CurrencyProvider>
        <Probe />
      </CurrencyProvider>
    </AuthContext.Provider>,
  )
}

const settings = (primary, dual) => ({
  data: {
    primary_currency: primary,
    enable_dual_currency: dual,
    secondary_currency: dual ? (primary === 'USD' ? 'LBP' : 'USD') : null,
  },
})

describe('CurrencyProvider', () => {
  beforeEach(() => {
    api.get.mockReset()
    api.patch.mockReset()
  })

  it('renders USD with a dual-currency conversion by default', async () => {
    api.get.mockResolvedValue(settings('USD', true))
    renderProbe()

    await waitFor(() => expect(screen.getByTestId('primary')).toHaveTextContent('USD'))
    expect(screen.getByTestId('amount')).toHaveTextContent('$10.00')
    expect(screen.getByTestId('secondary')).toHaveTextContent('890,000 LBP')
  })

  it('hides every secondary figure when dual currency is off', async () => {
    api.get.mockResolvedValue(settings('USD', false))
    renderProbe()

    await waitFor(() => expect(screen.getByTestId('dual')).toHaveTextContent('false'))
    expect(screen.getByTestId('secondary')).toHaveTextContent('none')
  })

  it('renders LBP as the primary currency when the account says so', async () => {
    api.get.mockResolvedValue(settings('LBP', false))
    renderProbe()

    await waitFor(() => expect(screen.getByTestId('currency')).toHaveTextContent('LBP'))
    expect(screen.getByTestId('amount')).toHaveTextContent('890,000 LBP')
    expect(screen.getByTestId('secondary')).toHaveTextContent('none')
  })

  it('keeps the exchange-rate field for LBP-primary even with dual currency off', async () => {
    // The rate is what turns stored USD into every figure on screen in that mode, so hiding it
    // would take away control of all of them.
    api.get.mockResolvedValue(settings('LBP', false))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('show-rate')).toHaveTextContent('true'))
  })

  it('hides the exchange-rate field for USD-primary with dual currency off', async () => {
    api.get.mockResolvedValue(settings('USD', false))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('show-rate')).toHaveTextContent('false'))
  })

  it('refuses to toggle into a currency the account does not use', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(settings('USD', false))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('dual')).toHaveTextContent('false'))

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.getByTestId('currency')).toHaveTextContent('USD')
  })

  it('toggles between the two while dual currency is on', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(settings('USD', true))
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('currency')).toHaveTextContent('USD'))

    await user.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.getByTestId('currency')).toHaveTextContent('LBP')
    expect(screen.getByTestId('amount')).toHaveTextContent('890,000 LBP')
    expect(screen.getByTestId('secondary')).toHaveTextContent('$10.00')
  })

  it('fetches nothing while signed out and falls back to USD', async () => {
    renderProbe({ status: 'anonymous' })
    expect(api.get).not.toHaveBeenCalled()
    expect(screen.getByTestId('amount')).toHaveTextContent('$10.00')
  })

  it('survives a failed settings fetch without breaking the page', async () => {
    api.get.mockRejectedValue(new Error('offline'))
    renderProbe()
    // Still renders, still in USD — every stored amount is USD, so the fallback is correct
    // rather than merely harmless.
    await waitFor(() => expect(screen.getByTestId('amount')).toHaveTextContent('$10.00'))
  })
})
