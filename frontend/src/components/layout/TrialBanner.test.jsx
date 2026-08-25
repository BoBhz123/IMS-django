import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  describe('counting from the deadline', () => {
    function trialEndingOn(date, extra = {}) {
      return {
        subscription_status: 'trialing',
        is_trial: true,
        trial_ends_at: date.toISOString(),
        ...extra,
      }
    }

    afterEach(() => {
      vi.useRealTimers()
      delete document.visibilityState
    })

    it('derives the count from trial_ends_at, not the server snapshot', () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
      // The two disagree exactly when the payload has gone stale. The timestamp wins.
      account = trialEndingOn(new Date(2026, 7, 27, 10, 0, 0), { trial_days_remaining: 14 })

      renderBanner()
      expect(screen.getByText(/2 days left in your free trial/i)).toBeInTheDocument()
      expect(screen.queryByText(/14 days/i)).not.toBeInTheDocument()
    })

    it('updates without a refetch when the tab comes back on a later day', () => {
      // The bug this fixes: this app lives in a pinned tab for days at a time, so the
      // banner routinely showed a number that had been wrong since some earlier midnight.
      // Same account object throughout — nothing refetches.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
      account = trialEndingOn(new Date(2026, 7, 30, 10, 0, 0))

      renderBanner()
      expect(screen.getByText(/5 days left in your free trial/i)).toBeInTheDocument()

      vi.setSystemTime(new Date(2026, 7, 28, 10, 0, 0))
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })

      expect(screen.getByText(/2 days left in your free trial/i)).toBeInTheDocument()
    })

    it('says the trial has ended once the deadline is behind us', () => {
      // An elapsed trial still reads is_trial until something refetches. "Ends today" would
      // invite the user to keep working against an app that has already locked them out.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
      account = trialEndingOn(new Date(2026, 7, 24, 10, 0, 0))

      renderBanner()
      expect(screen.getByText(/your free trial has ended/i)).toBeInTheDocument()
    })

    it('turns urgent on the deadline rather than the stale count', () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(new Date(2026, 7, 25, 10, 0, 0))
      account = trialEndingOn(new Date(2026, 7, 26, 10, 0, 0), { trial_days_remaining: 14 })

      renderBanner()
      expect(screen.getByRole('status').className).toMatch(/accent-red/)
    })
  })
})
