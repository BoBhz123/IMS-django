import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/pages/Settings'

let account = null

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'a@b.com' }, account }),
}))
vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}))
vi.mock('@/context/CurrencyContext', () => ({
  useCurrency: () => ({ currency: 'USD', toggleCurrency: vi.fn() }),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  )
}

describe('Settings', () => {
  beforeEach(() => {
    account = {
      id: 7,
      subscription_status: 'active',
      plan_type: 'annual',
      expires_at: '2027-08-12T00:00:00Z',
      subscription_live: true,
      business_name: 'Acme',
      email: 'a@b.com',
      phone: '+961 70 000 000',
    }
  })

  it('shows the account identifiers support will ask for', () => {
    renderPage()
    expect(screen.getByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('+961 70 000 000')).toBeInTheDocument()
  })

  it('shows the plan and renewal date for a paying account', () => {
    renderPage()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText(/annual plan/i)).toBeInTheDocument()
    // The billing card states the plan and the date as their own labelled fields, so support
    // and the customer are reading the same two facts.
    expect(screen.getByText('Current plan')).toBeInTheDocument()
    expect(screen.getByText('Annual')).toBeInTheDocument()
    expect(screen.getByText('Renews')).toBeInTheDocument()
    expect(screen.getByText('Aug 12, 2027')).toBeInTheDocument()
  })

  it('shows the account id in the billing card for support reference', () => {
    renderPage()
    expect(screen.getByText('Account ID')).toBeInTheDocument()
    expect(screen.getByText('#7')).toBeInTheDocument()
    expect(screen.getByText(/quote this when you contact support/i)).toBeInTheDocument()
  })

  it('offers no way to change the subscription from here', () => {
    // Regular users view only — the sole affordance is a link to /subscription. Anything
    // that mutated billing state from this screen would be an unguarded second activation path.
    renderPage()
    expect(screen.getByRole('link', { name: /manage \/ upgrade plan/i })).toHaveAttribute(
      'href',
      '/subscription',
    )
    expect(screen.queryByRole('button', { name: /activate|cancel|revoke|extend/i })).toBeNull()
  })

  it('describes a lifetime licence as needing no renewal', () => {
    account = { ...account, plan_type: 'one_time', expires_at: null }
    renderPage()
    expect(screen.getByText(/lifetime licence, no renewal needed/i)).toBeInTheDocument()
  })

  it('counts down a running trial', () => {
    account = {
      ...account,
      subscription_status: 'trialing',
      plan_type: '',
      trial_days_remaining: 9,
      subscription_live: true,
    }
    renderPage()
    expect(screen.getByText('Free trial')).toBeInTheDocument()
    expect(screen.getByText(/9 days remaining/i)).toBeInTheDocument()
  })

  it('tells an elapsed trial its data is safe', () => {
    // This screen is reachable while locked out, so it is where the reassurance belongs.
    account = {
      ...account,
      subscription_status: 'trialing',
      trial_days_remaining: 0,
      subscription_live: false,
    }
    renderPage()
    expect(screen.getByText('Trial ended')).toBeInTheDocument()
    expect(screen.getByText(/data is untouched/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /choose a plan/i })).toBeInTheDocument()
  })

  it('reports an expired paid subscription as not live', () => {
    // The server's computed answer, not a date comparison in the browser — a wrong device
    // clock must not make this screen disagree with what the API enforces.
    account = { ...account, subscription_live: false }
    renderPage()
    // Both the badge and the renewal field flip to "Expired" off the same computed flag.
    expect(screen.getAllByText('Expired')).toHaveLength(2)
    expect(screen.getByText(/annual plan — expired/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /choose a plan/i })).toBeInTheDocument()
  })

  it('renders without an account rather than crashing', () => {
    account = null
    renderPage()
    expect(screen.getByText(/choose a plan to start/i)).toBeInTheDocument()
  })
})
