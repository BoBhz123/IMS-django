import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Settings } from '@/pages/Settings'

const post = vi.fn()
const logout = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { post: (...args) => post(...args) },
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'owner@example.com' },
    account: {
      email: 'owner@example.com',
      phone: '+961 70 000 000',
      business_name: 'Corner Shop',
    },
    logout,
  }),
}))

const codeInput = () => screen.getByRole('textbox', { name: /6-digit code/i })
const newPassword = () => screen.getByLabelText('New password')
const confirmPassword = () => screen.getByLabelText('Confirm new password')

/** Walk to the code step, which every test past the first one starts from. */
async function reachCodeStep(user) {
  post.mockResolvedValueOnce({ data: { detail: 'A password reset code is on its way.' } })
  await user.click(screen.getByRole('button', { name: /send reset code/i }))
  return screen.findByRole('textbox', { name: /6-digit code/i })
}

/** Walk all the way to the password step with a code the server accepts. */
async function reachPasswordStep(user) {
  await reachCodeStep(user)
  await user.type(codeInput(), '123456')
  post.mockResolvedValueOnce({ data: { detail: 'Code accepted.' } })
  await user.click(screen.getByRole('button', { name: /continue/i }))
  return screen.findByLabelText('New password')
}

describe('Settings', () => {
  beforeEach(() => {
    post.mockReset()
    logout.mockReset()
  })

  it('shows the account details', () => {
    render(<Settings />)
    // Scoped to the card: the business name also appears as the page subtitle.
    const details = within(screen.getByRole('region', { name: 'Your details' }))
    expect(details.getByText('Corner Shop')).toBeInTheDocument()
    expect(details.getByText('+961 70 000 000')).toBeInTheDocument()
    expect(details.getByText('owner@example.com')).toBeInTheDocument()
  })

  it('starts on the request step', () => {
    render(<Settings />)
    expect(screen.getByRole('button', { name: /send reset code/i })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /6-digit code/i })).not.toBeInTheDocument()
  })

  it('requests a code and moves to the code step', async () => {
    const user = userEvent.setup()
    render(<Settings />)

    await reachCodeStep(user)

    expect(post).toHaveBeenCalledWith('/accounts/password-reset/request/')
    expect(codeInput()).toBeInTheDocument()
  })

  it('will not submit a code that is not six digits', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await reachCodeStep(user)

    await user.type(codeInput(), '123')
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()

    await user.type(codeInput(), '456')
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()
  })

  it('keeps non-digits out of the code field', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await reachCodeStep(user)

    await user.type(codeInput(), '12ab34')
    expect(codeInput()).toHaveValue('1234')
  })

  it('shows the server message when the code is wrong, and stays on the step', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await reachCodeStep(user)

    await user.type(codeInput(), '000000')
    post.mockRejectedValueOnce({
      response: { data: { detail: 'That code is not correct.', code: 'invalid_code' } },
    })
    await user.click(screen.getByRole('button', { name: /continue/i }))

    expect(await screen.findByText('That code is not correct.')).toBeInTheDocument()
    expect(codeInput()).toBeInTheDocument()
  })

  it('moves to the password step once the code checks out', async () => {
    const user = userEvent.setup()
    render(<Settings />)

    await reachPasswordStep(user)

    expect(post).toHaveBeenCalledWith('/accounts/password-reset/verify/', { code: '123456' })
    expect(confirmPassword()).toBeInTheDocument()
  })

  it('blocks submission until the two passwords match', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await reachPasswordStep(user)

    await user.type(newPassword(), 'brandNewPw!2026')
    await user.type(confirmPassword(), 'different')
    expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled()
  })

  it('sends the code with the new password, not on its own', async () => {
    // The code travels with the password because that request is the only one that changes
    // anything — a confirm endpoint trusting the earlier verify would let a borrowed session
    // skip the code entirely.
    const user = userEvent.setup()
    render(<Settings />)
    await reachPasswordStep(user)

    await user.type(newPassword(), 'brandNewPw!2026')
    await user.type(confirmPassword(), 'brandNewPw!2026')
    post.mockResolvedValueOnce({ data: { detail: 'Your password has been changed.' } })
    await user.click(screen.getByRole('button', { name: /change password/i }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/accounts/password-reset/confirm/', {
        code: '123456',
        new_password: 'brandNewPw!2026',
        confirm_password: 'brandNewPw!2026',
      }),
    )
  })

  it('confirms the change and offers to sign in again', async () => {
    const user = userEvent.setup()
    render(<Settings />)
    await reachPasswordStep(user)

    await user.type(newPassword(), 'brandNewPw!2026')
    await user.type(confirmPassword(), 'brandNewPw!2026')
    post.mockResolvedValueOnce({ data: { detail: 'Your password has been changed.' } })
    await user.click(screen.getByRole('button', { name: /change password/i }))

    expect(await screen.findByText('Password changed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /sign in again/i }))
    expect(logout).toHaveBeenCalled()
  })

  it('renders a rejected password as a field error and keeps the user on the step', async () => {
    // The server rejects on its own validators, and a rejected password does not spend the
    // code — so the user must be able to try another one without a fresh email.
    const user = userEvent.setup()
    render(<Settings />)
    await reachPasswordStep(user)

    await user.type(newPassword(), 'password1234')
    await user.type(confirmPassword(), 'password1234')
    post.mockRejectedValueOnce({
      response: { data: { new_password: ['This password is too common.'] } },
    })
    await user.click(screen.getByRole('button', { name: /change password/i }))

    expect(await screen.findByText('This password is too common.')).toBeInTheDocument()
    expect(confirmPassword()).toBeInTheDocument()
  })

  it('reports a throttled request instead of pretending a code was sent', async () => {
    const user = userEvent.setup()
    render(<Settings />)

    post.mockRejectedValueOnce({
      response: {
        data: {
          detail: 'Wait 45 seconds before requesting another code.',
          code: 'resend_throttled',
          retry_after: 45,
        },
      },
    })
    await user.click(screen.getByRole('button', { name: /send reset code/i }))

    expect(
      await screen.findByText('Wait 45 seconds before requesting another code.'),
    ).toBeInTheDocument()
    // Still on step 1, and the button now counts down rather than inviting another attempt.
    expect(screen.queryByRole('textbox', { name: /6-digit code/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /resend in/i })).toBeDisabled()
  })
})
