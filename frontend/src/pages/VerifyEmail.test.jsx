import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const post = vi.fn()
const refreshAccount = vi.fn()
const navigate = vi.fn()

vi.mock('@/lib/api', () => ({ api: { post: (...args) => post(...args) } }))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ account: { email: 'owner@example.com' }, refreshAccount }),
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
    navigate.mockReset()
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
})
