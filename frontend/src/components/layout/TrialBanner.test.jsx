import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TrialBanner } from './TrialBanner'

let account = null

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ account }),
}))

function renderBanner() {
  return render(
    <MemoryRouter>
      <TrialBanner />
    </MemoryRouter>,
  )
}

describe('TrialBanner', () => {
  beforeEach(() => {
    account = null
  })

  it('renders nothing for a paid account', () => {
    account = { subscription_status: 'active', is_trial: false, subscription_live: true }
    const { container } = renderBanner()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when there is no account at all', () => {
    // A platform superadmin has no account row and must not be shown a trial countdown.
    const { container } = renderBanner()
    expect(container).toBeEmptyDOMElement()
  })

  it('counts down during a trial and links to the plan screen', () => {
    account = { subscription_status: 'trialing', is_trial: true, trial_days_remaining: 9 }
    renderBanner()
    expect(screen.getByText(/9 days left in your free trial/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /choose a plan/i })).toHaveAttribute(
      'href',
      '/subscription',
    )
  })

  it('is announced to assistive tech without stealing focus', () => {
    account = { subscription_status: 'trialing', is_trial: true, trial_days_remaining: 5 }
    renderBanner()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('disappears the moment the trial stops being live', () => {
    // is_trial is the server's computed answer, so an elapsed trial drops the banner and
    // ProtectedRoute takes over with a redirect.
    account = { subscription_status: 'trialing', is_trial: false, trial_days_remaining: 0 }
    const { container } = renderBanner()
    expect(container).toBeEmptyDOMElement()
  })
})
