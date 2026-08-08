import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Subscription } from '@/pages/Subscription'

const get = vi.fn()
const post = vi.fn()
const refreshAccount = vi.fn()
const logout = vi.fn()
const navigate = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { get: (...args) => get(...args), post: (...args) => post(...args) },
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    account: { status: 'pending_payment', business_name: 'Acme' },
    refreshAccount,
    logout,
  }),
}))
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => navigate,
}))

const CONFIG = {
  card_checkout_available: false,
  plans: [
    {
      key: 'monthly',
      name: 'Monthly',
      price_usd: '15',
      period: 'per month',
      description: 'Billed monthly.',
    },
    {
      key: 'one_time',
      name: 'Lifetime',
      price_usd: '299',
      period: 'one time',
      description: 'Pay once.',
    },
  ],
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Subscription />
    </MemoryRouter>,
  )
}

describe('Subscription', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    refreshAccount.mockReset()
    navigate.mockReset()
    logout.mockReset()
    get.mockResolvedValue({ data: CONFIG })
  })

  it('renders both plans with their prices', async () => {
    renderPage()
    expect(await screen.findByText('Monthly')).toBeInTheDocument()
    expect(screen.getByText('Lifetime')).toBeInTheDocument()
    expect(screen.getByText(/299/)).toBeInTheDocument()
  })

  it('says card payment is unavailable rather than offering a button that fails', async () => {
    renderPage()
    expect(await screen.findByText(/not available yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /pay with card/i })).not.toBeInTheDocument()
  })

  it('offers card buttons once the server says checkout is on', async () => {
    get.mockResolvedValue({ data: { ...CONFIG, card_checkout_available: true } })
    renderPage()
    expect(await screen.findAllByRole('button', { name: /pay with card/i })).toHaveLength(2)
  })

  it('keeps redeem disabled until a full key is entered', async () => {
    renderPage()
    await screen.findByText('Monthly')
    const submit = screen.getByRole('button', { name: /activate/i })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/discount key/i), 'ABCDEFGHJKMN')
    expect(submit).toBeEnabled()
  })

  it('formats the key into groups as it is typed', async () => {
    renderPage()
    await screen.findByText('Monthly')
    const input = screen.getByLabelText(/discount key/i)
    await userEvent.type(input, 'abcdefgh')
    expect(input).toHaveValue('ABCD-EFGH')
  })

  it('sends the normalized key and re-routes once the account goes active', async () => {
    post.mockResolvedValue({ data: { status: 'active' } })
    refreshAccount.mockResolvedValue({ status: 'active' })
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.type(screen.getByLabelText(/discount key/i), 'abcd-efgh-jkmn')
    await userEvent.click(screen.getByRole('button', { name: /activate/i }))

    await waitFor(() => expect(refreshAccount).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/billing/redeem-key/', { code: 'ABCDEFGHJKMN' })
    expect(navigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('shows the server error and stays put on a bad key', async () => {
    post.mockRejectedValue({
      response: { status: 400, data: { detail: 'That key is not valid.', code: 'invalid_key' } },
    })
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.type(screen.getByLabelText(/discount key/i), 'ABCDEFGHJKMN')
    await userEvent.click(screen.getByRole('button', { name: /activate/i }))

    expect(await screen.findByText(/not valid/i)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('lets a lapsed account sign out', async () => {
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })
})
