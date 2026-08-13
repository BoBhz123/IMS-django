import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn()
const refreshAccount = vi.fn()
const abandonRegistration = vi.fn()
const navigate = vi.fn()

// Reassigned per test so a case can render the screen for an account whose sign-up session
// has already lapsed, which is what the server reports after a closed tab.
let account = { email: 'owner@example.com' }

vi.mock('@/lib/api', () => ({ api: { post: (...args) => post(...args) } }))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ account, refreshAccount, abandonRegistration }),
}))
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => navigate,
}))

const { VerifyEmail } = await import('./VerifyEmail')

function renderPage() {
  return render(
    <MemoryRouter>
      <VerifyEmail />
    </MemoryRouter>,
  )
}

describe('VerifyEmail', () => {
  beforeEach(() => {
    post.mockReset()
    refreshAccount.mockReset()
    abandonRegistration.mockReset()
    navigate.mockReset()
    account = { email: 'owner@example.com' }
  })

  it('shows the address the code went to', () => {
    renderPage()
    expect(screen.getByText(/owner@example.com/)).toBeInTheDocument()
  })

  it('keeps submit disabled until six digits are entered', async () => {
    renderPage()
    const submit = screen.getByRole('button', { name: /verify email/i })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/verification code/i), '123456')
    expect(submit).toBeEnabled()
  })

  it('strips non-digits from what the user types', async () => {
    renderPage()
    const input = screen.getByLabelText(/verification code/i)
    await userEvent.type(input, '12-34-56')
    expect(input).toHaveValue('123456')
  })

  it('sends the user on after a successful verification', async () => {
    post.mockResolvedValue({ data: { status: 'pending_payment' } })
    renderPage()
    await userEvent.type(screen.getByLabelText(/verification code/i), '123456')
    await userEvent.click(screen.getByRole('button', { name: /verify email/i }))
    await waitFor(() => expect(refreshAccount).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/accounts/verify-email/', { code: '123456' })
    expect(navigate).toHaveBeenCalledWith('/subscription', { replace: true })
  })

  it('shows the server error without leaving the screen', async () => {
    post.mockRejectedValue({
      response: {
        status: 400,
        data: { detail: 'That code is not correct.', code: 'invalid_code' },
      },
    })
    renderPage()
    await userEvent.type(screen.getByLabelText(/verification code/i), '000000')
    await userEvent.click(screen.getByRole('button', { name: /verify email/i }))
    expect(await screen.findByText(/not correct/i)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('starts a cooldown from the server retry_after when resend is throttled', async () => {
    post.mockRejectedValue({
      response: {
        status: 429,
        data: { detail: 'Wait 45 seconds.', code: 'resend_throttled', retry_after: 45 },
      },
    })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /send a new code/i }))
    // Mirrors the server's own number rather than guessing a duration client-side.
    expect(await screen.findByRole('button', { name: /resend in 0:45/i })).toBeDisabled()
  })

  it('confirms a successful resend', async () => {
    post.mockResolvedValue({ data: { detail: 'A new code is on its way.' } })
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /send a new code/i }))
    expect(await screen.findByText(/on its way/i)).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/accounts/resend-code/')
  })

  it('counts the sign-up session down', () => {
    account = {
      email: 'owner@example.com',
      registration_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }
    renderPage()
    expect(screen.getByText(/session closes in 10:00/i)).toBeInTheDocument()
  })

  describe('back to sign up', () => {
    it('discards the registration before returning to the form', async () => {
      // Navigating alone would leave the half-finished account holding the email address,
      // so someone fixing a typo would be told the address is taken.
      renderPage()
      await userEvent.click(screen.getByRole('button', { name: /back to sign up/i }))

      await waitFor(() => expect(abandonRegistration).toHaveBeenCalled())
      expect(navigate).toHaveBeenCalledWith('/signup', { replace: true })
    })

    it('is offered even while a code is outstanding', () => {
      renderPage()
      expect(screen.getByRole('button', { name: /back to sign up/i })).toBeEnabled()
    })
  })

  describe('an expired sign-up session', () => {
    it('renders as expired straight away when the server says so', () => {
      account = { email: 'owner@example.com', registration_session_expired: true }
      renderPage()

      expect(screen.getByRole('alert')).toHaveTextContent(/expired/i)
      // No form to type into: the account behind it no longer exists.
      expect(screen.queryByLabelText(/verification code/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /back to sign up/i })).toBeInTheDocument()
    })

    it('swaps the form out when verification comes back 410', async () => {
      post.mockRejectedValue({
        response: {
          status: 410,
          data: {
            detail: 'Your sign-up session has expired. Please start the sign-up process again.',
            code: 'registration_expired',
          },
        },
      })
      renderPage()
      await userEvent.type(screen.getByLabelText(/verification code/i), '123456')
      await userEvent.click(screen.getByRole('button', { name: /verify email/i }))

      expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i)
      expect(screen.queryByRole('button', { name: /verify email/i })).not.toBeInTheDocument()
      // Nowhere to go but back to the start — and not automatically, since the user has to
      // read why their details are gone.
      expect(navigate).not.toHaveBeenCalled()
    })

    it('swaps the form out when a resend comes back 410', async () => {
      post.mockRejectedValue({
        response: { status: 410, data: { detail: 'Session expired.', code: 'registration_expired' } },
      })
      renderPage()
      await userEvent.click(screen.getByRole('button', { name: /send a new code/i }))

      expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i)
    })

    it('keeps a mistyped code on the same screen', async () => {
      // The distinction that matters: a wrong digit is recoverable, a closed session is not.
      post.mockRejectedValue({
        response: { status: 400, data: { detail: 'That code is not correct.', code: 'invalid_code' } },
      })
      renderPage()
      await userEvent.type(screen.getByLabelText(/verification code/i), '000000')
      await userEvent.click(screen.getByRole('button', { name: /verify email/i }))

      expect(await screen.findByText(/not correct/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /verify email/i })).toBeInTheDocument()
    })
  })
})
