import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@/context/AuthContext'
import { Login } from './Login'

const login = vi.fn()

function renderLogin() {
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ login }}>
        <Login />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

async function submit(user) {
  await user.type(screen.getByLabelText(/email/i), 'someone@example.com')
  await user.type(screen.getByLabelText(/password/i), 'whatever')
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}

beforeEach(() => {
  login.mockReset()
})

describe('Login error reporting', () => {
  it('shows the lockout message when the server reports a lockout', async () => {
    // The bug this pins: a brute-force lockout came back indistinguishable from a wrong
    // password, so someone locked out was told to check credentials that were already
    // correct — with no hint that waiting was the answer.
    const user = userEvent.setup()
    login.mockRejectedValue({
      response: {
        status: 429,
        data: {
          code: 'account_locked',
          detail: 'Too many failed sign-in attempts. Try again in about 1 hour.',
          cooloff_seconds: 3600,
        },
      },
    })
    renderLogin()
    await submit(user)

    expect(await screen.findByText(/too many failed sign-in attempts/i)).toBeInTheDocument()
    expect(screen.queryByText(/incorrect email or password/i)).not.toBeInTheDocument()
  })

  it('still says wrong password for an ordinary 401', async () => {
    const user = userEvent.setup()
    login.mockRejectedValue({ response: { status: 401, data: { detail: 'No active account found' } } })
    renderLogin()
    await submit(user)

    // Deliberately NOT the server's wording here: djoser's "No active account found with the
    // given credentials" invites a user to think their account was deleted.
    expect(await screen.findByText(/incorrect email or password/i)).toBeInTheDocument()
  })

  it('falls back to the generic message when there is no response at all', async () => {
    const user = userEvent.setup()
    login.mockRejectedValue(new Error('Network down'))
    renderLogin()
    await submit(user)

    expect(await screen.findByText(/incorrect email or password/i)).toBeInTheDocument()
  })

  it('does not trust a lockout code without a message', async () => {
    // Branching on the code alone would render `undefined` into the error line.
    const user = userEvent.setup()
    login.mockRejectedValue({ response: { status: 429, data: { code: 'account_locked' } } })
    renderLogin()
    await submit(user)

    expect(await screen.findByText(/incorrect email or password/i)).toBeInTheDocument()
  })
})
