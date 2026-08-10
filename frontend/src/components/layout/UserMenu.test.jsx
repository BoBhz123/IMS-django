import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UserMenu } from './UserMenu'

const logout = vi.fn()
const navigate = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'owner@example.com' },
    account: { email: 'owner@example.com', business_name: 'Corner Shop' },
    logout,
  }),
}))
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => navigate,
}))

function renderMenu() {
  render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>,
  )
}

const trigger = () => screen.getByRole('button', { name: /account menu/i })

describe('UserMenu', () => {
  beforeEach(() => {
    logout.mockReset()
    navigate.mockReset()
  })

  it('keeps the menu closed until it is asked for', () => {
    renderMenu()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens to Account Settings and Sign Out', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())

    expect(screen.getByRole('menuitem', { name: /account settings/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not sign out on the first tap', async () => {
    // The whole reason for the menu: sign out used to be a single mis-tap away from the
    // theme toggle.
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())

    expect(logout).not.toHaveBeenCalled()
  })

  it('navigates to the settings page', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: /account settings/i }))

    expect(navigate).toHaveBeenCalledWith('/settings')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('signs out from the menu', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())
    await user.click(screen.getByRole('menuitem', { name: /sign out/i }))

    expect(logout).toHaveBeenCalled()
  })

  it('closes when a click lands outside it', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())
    await user.click(document.body)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('shows who is signed in', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(trigger())

    expect(screen.getByText('Corner Shop')).toBeInTheDocument()
    expect(screen.getByText('owner@example.com')).toBeInTheDocument()
  })
})
