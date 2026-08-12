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
const openPaddleCheckout = vi.fn()
let account = { id: 7, subscription_status: 'pending_payment', business_name: 'Acme', email: 'a@b.com' }

vi.mock('@/lib/api', () => ({
  api: { get: (...args) => get(...args), post: (...args) => post(...args) },
}))
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'a@b.com' }, account, refreshAccount, logout }),
}))
vi.mock('@/lib/paddle', () => ({
  openPaddleCheckout: (...args) => openPaddleCheckout(...args),
}))
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => navigate,
}))

const CONFIG = {
  card_checkout_available: false,
  trial_days: 14,
  local_payment: { whatsapp_number: '96170000000', telegram_username: 'ims_support' },
  plans: [
    {
      key: 'monthly',
      name: 'Monthly',
      price_usd: '15',
      period: 'per month',
      description: 'Billed monthly.',
      card_available: false,
    },
    {
      key: 'annual',
      name: 'Annual',
      price_usd: '150',
      period: 'per year',
      description: 'Billed yearly.',
      card_available: false,
      highlight: true,
    },
    {
      key: 'one_time',
      name: 'Lifetime',
      price_usd: '299',
      period: 'one time',
      description: 'Pay once.',
      card_available: false,
    },
  ],
}

const withCards = (overrides = {}) => ({
  ...CONFIG,
  card_checkout_available: true,
  plans: CONFIG.plans.map((plan) => ({ ...plan, card_available: true })),
  ...overrides,
})

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
    openPaddleCheckout.mockReset()
    account = { id: 7, subscription_status: 'pending_payment', business_name: 'Acme', email: 'a@b.com' }
    get.mockResolvedValue({ data: CONFIG })
  })

  it('renders all three plans as one radio group with their prices', async () => {
    renderPage()
    expect(await screen.findByText('Monthly')).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByText('Annual')).toBeInTheDocument()
    expect(screen.getByText('Lifetime')).toBeInTheDocument()
    expect(screen.getByText(/299/)).toBeInTheDocument()
    expect(screen.getByText(/150/)).toBeInTheDocument()
  })

  it('hides card buttons rather than offering one that always fails', async () => {
    renderPage()
    await screen.findByText('Monthly')
    expect(screen.queryByRole('button', { name: /pay with card/i })).not.toBeInTheDocument()
  })

  it('offers a card button per plan the server says is purchasable', async () => {
    get.mockResolvedValue({ data: withCards() })
    renderPage()
    expect(await screen.findAllByRole('button', { name: /pay with card/i })).toHaveLength(3)
  })

  it('offers card payment only for plans whose price is configured', async () => {
    // A deployment mid-setup should sell the plan it has finished wiring, not hide all three.
    get.mockResolvedValue({
      data: {
        ...withCards(),
        plans: withCards().plans.map((plan) =>
          plan.key === 'annual' ? { ...plan, card_available: false } : plan,
        ),
      },
    })
    renderPage()
    expect(await screen.findAllByRole('button', { name: /pay with card/i })).toHaveLength(2)
  })

  // --- card checkout --------------------------------------------------------------------

  it('opens the Paddle overlay with exactly what the server returned', async () => {
    const checkout = {
      provider: 'paddle',
      environment: 'sandbox',
      client_token: 'tok',
      price_id: 'pri_annual',
      custom_data: { account_id: '7', plan: 'annual' },
    }
    get.mockResolvedValue({ data: withCards() })
    post.mockResolvedValue({ data: checkout })
    renderPage()

    const buttons = await screen.findAllByRole('button', { name: /pay with card/i })
    await userEvent.click(buttons[1])

    expect(post).toHaveBeenCalledWith('/billing/checkout/', { plan: 'annual' })
    await waitFor(() =>
      expect(openPaddleCheckout).toHaveBeenCalledWith(checkout, { email: 'a@b.com' }),
    )
  })

  it('never sends an amount or a currency to the checkout endpoint', async () => {
    // The server maps a plan key to a configured price. An amount in this request is an
    // amount somebody can edit to one cent in devtools.
    get.mockResolvedValue({ data: withCards() })
    post.mockResolvedValue({ data: { price_id: 'pri_monthly' } })
    renderPage()

    const buttons = await screen.findAllByRole('button', { name: /pay with card/i })
    await userEvent.click(buttons[0])

    expect(post).toHaveBeenCalledWith('/billing/checkout/', { plan: 'monthly' })
  })

  it('does not grant access when the overlay opens', async () => {
    // Only the signed webhook grants access; a redirect or a resolved promise is forgeable.
    get.mockResolvedValue({ data: withCards() })
    post.mockResolvedValue({ data: { price_id: 'pri_monthly' } })
    renderPage()

    const buttons = await screen.findAllByRole('button', { name: /pay with card/i })
    await userEvent.click(buttons[0])

    await waitFor(() => expect(openPaddleCheckout).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
  })

  it('falls back to the local payment message when checkout is refused', async () => {
    get.mockResolvedValue({ data: withCards() })
    post.mockRejectedValue({
      response: { status: 503, data: { detail: 'Card payment is not configured yet.' } },
    })
    renderPage()

    const buttons = await screen.findAllByRole('button', { name: /pay with card/i })
    await userEvent.click(buttons[0])

    expect(await screen.findByText(/not configured yet/i)).toBeInTheDocument()
  })

  // --- local payment --------------------------------------------------------------------

  it('pre-fills the chat message with the account, email and selected plan', async () => {
    renderPage()
    await screen.findByText('Monthly')

    const whatsapp = screen.getByRole('link', { name: /whatsapp/i })
    const href = decodeURIComponent(whatsapp.getAttribute('href'))
    expect(href).toContain('https://wa.me/96170000000')
    expect(href).toContain('Account ID: 7')
    expect(href).toContain('Email: a@b.com')
    expect(href).toContain('Plan: Annual')
  })

  it('updates the pre-filled plan when a different card is selected', async () => {
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.click(screen.getByRole('radio', { name: /lifetime/i }))

    const href = decodeURIComponent(
      screen.getByRole('link', { name: /telegram/i }).getAttribute('href'),
    )
    expect(href).toContain('https://t.me/ims_support')
    expect(href).toContain('Plan: Lifetime')
  })

  it('says renew rather than activate for a lapsed account', async () => {
    account = { ...account, subscription_status: 'canceled' }
    renderPage()
    await screen.findByText('Monthly')

    const href = decodeURIComponent(
      screen.getByRole('link', { name: /whatsapp/i }).getAttribute('href'),
    )
    expect(href).toContain('I want to renew my IMS subscription')
  })

  it('hides a chat button the server has no contact for', async () => {
    get.mockResolvedValue({
      data: { ...CONFIG, local_payment: { whatsapp_number: '', telegram_username: 'ims' } },
    })
    renderPage()
    await screen.findByText('Monthly')

    expect(screen.queryByRole('link', { name: /whatsapp/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /telegram/i })).toBeInTheDocument()
  })

  // --- headline -------------------------------------------------------------------------

  it('tells an elapsed trial that the trial ended, not that a subscription lapsed', async () => {
    account = { ...account, subscription_status: 'trialing', subscription_live: false }
    renderPage()
    expect(await screen.findByText(/free trial has ended/i)).toBeInTheDocument()
  })

  it('tells a lapsed subscriber their subscription ended', async () => {
    account = { ...account, subscription_status: 'past_due' }
    renderPage()
    expect(await screen.findByText(/subscription has ended/i)).toBeInTheDocument()
  })

  // --- activation keys ------------------------------------------------------------------

  it('keeps redeem disabled until a full key is entered', async () => {
    renderPage()
    await screen.findByText('Monthly')
    const submit = screen.getByRole('button', { name: /activate account/i })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/activation key/i), 'ABCDEFGHJKMN')
    expect(submit).toBeEnabled()
  })

  it('formats the key into groups as it is typed', async () => {
    renderPage()
    await screen.findByText('Monthly')
    const input = screen.getByLabelText(/activation key/i)
    await userEvent.type(input, 'abcdefgh')
    expect(input).toHaveValue('ABCD-EFGH')
  })

  it('sends the normalized key and re-routes once the account goes active', async () => {
    post.mockResolvedValue({ data: { subscription_status: 'active' } })
    refreshAccount.mockResolvedValue({ subscription_status: 'active', subscription_live: true })
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.type(screen.getByLabelText(/activation key/i), 'abcd-efgh-jkmn')
    await userEvent.click(screen.getByRole('button', { name: /activate account/i }))

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
    await userEvent.type(screen.getByLabelText(/activation key/i), 'ABCDEFGHJKMN')
    await userEvent.click(screen.getByRole('button', { name: /activate account/i }))

    expect(await screen.findByText(/not valid/i)).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('still offers activation when the config call fails', async () => {
    // The plan cards are a nicety; the key field is the only way out of the paywall for a
    // customer who paid cash.
    get.mockRejectedValue(new Error('offline'))
    renderPage()
    expect(await screen.findByLabelText(/activation key/i)).toBeInTheDocument()
  })

  it('lets a lapsed account sign out', async () => {
    renderPage()
    await screen.findByText('Monthly')
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })

  // --- live-subscription state ------------------------------------------------------------

  const liveAccount = {
    id: 7,
    subscription_status: 'active',
    subscription_live: true,
    plan_type: 'annual',
    expires_at: '2027-08-12T00:00:00Z',
    payment_method: 'card',
    email: 'a@b.com',
  }

  it('shows a summary instead of a price list to someone who already pays', async () => {
    // Fronting checkout to a paying customer reads as "we lost your payment".
    account = liveAccount
    renderPage()
    expect(await screen.findByText(/current active subscription/i)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('states the plan, payment type and renewal date on the summary', async () => {
    account = liveAccount
    renderPage()
    await screen.findByText(/current active subscription/i)
    expect(screen.getByText('Annual')).toBeInTheDocument()
    expect(screen.getByText(/card \(auto-renews\)/i)).toBeInTheDocument()
    expect(screen.getByText('Renews')).toBeInTheDocument()
    expect(screen.getByText('Aug 12, 2027')).toBeInTheDocument()
  })

  it('says a lifetime licence never renews rather than showing a blank date', async () => {
    account = { ...liveAccount, plan_type: 'one_time', expires_at: null, payment_method: 'manual' }
    renderPage()
    await screen.findByText(/current active subscription/i)
    expect(screen.getByText(/never — lifetime licence/i)).toBeInTheDocument()
  })

  it('counts a live trial as a subscription, not as a paywall', async () => {
    account = {
      ...liveAccount,
      subscription_status: 'trialing',
      plan_type: '',
      payment_method: 'trial',
      trial_ends_at: '2026-08-26T00:00:00Z',
      trial_days_remaining: 14,
    }
    renderPage()
    await screen.findByText(/current active subscription/i)
    expect(screen.getByText('Trialing')).toBeInTheDocument()
    expect(screen.getByText('Trial ends')).toBeInTheDocument()
    expect(screen.getByText(/free trial — no card on file/i)).toBeInTheDocument()
  })

  it('reveals the catalog on demand', async () => {
    account = liveAccount
    renderPage()
    await screen.findByText(/current active subscription/i)
    expect(screen.queryByLabelText(/activation key/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /change or upgrade plan/i }))

    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByLabelText(/activation key/i)).toBeInTheDocument()
  })

  // --- inactive state ---------------------------------------------------------------------

  it('alerts an inactive account and shows the plans straight away', async () => {
    // No extra click for someone who is locked out — this screen is their only way back in.
    account = { ...liveAccount, subscription_status: 'canceled', subscription_live: false }
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or is inactive/i)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.getByLabelText(/activation key/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /change or upgrade plan/i }),
    ).not.toBeInTheDocument()
  })

  it('treats an elapsed trial as inactive despite the trialing status', async () => {
    // The stored column still says `trialing`; only subscription_live tells the truth.
    account = {
      ...liveAccount,
      subscription_status: 'trialing',
      subscription_live: false,
      trial_days_remaining: 0,
    }
    renderPage()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/current active subscription/i)).not.toBeInTheDocument()
  })

  it('routes home off the refreshed liveness, not off the redeem response', async () => {
    account = { ...liveAccount, subscription_status: 'pending_payment', subscription_live: false }
    post.mockResolvedValue({ data: { subscription_status: 'active' } })
    refreshAccount.mockResolvedValue({ subscription_live: true })
    renderPage()
    await screen.findByLabelText(/activation key/i)
    await userEvent.type(screen.getByLabelText(/activation key/i), 'ABCDEFGHJKMN')
    await userEvent.click(screen.getByRole('button', { name: /activate account/i }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/', { replace: true }))
  })

  it('stays put when the refresh still reports the account as not live', async () => {
    // A 200 from redeem is not proof of access — ProtectedRoute would bounce them back.
    account = { ...liveAccount, subscription_status: 'pending_payment', subscription_live: false }
    post.mockResolvedValue({ data: {} })
    refreshAccount.mockResolvedValue({ subscription_live: false })
    renderPage()
    await screen.findByLabelText(/activation key/i)
    await userEvent.type(screen.getByLabelText(/activation key/i), 'ABCDEFGHJKMN')
    await userEvent.click(screen.getByRole('button', { name: /activate account/i }))

    await waitFor(() => expect(refreshAccount).toHaveBeenCalled())
    expect(navigate).not.toHaveBeenCalled()
  })

  // --- back to settings -------------------------------------------------------------------

  it('offers a way back to settings for a live subscriber', async () => {
    account = liveAccount
    renderPage()
    await screen.findByText(/current active subscription/i)
    expect(screen.getByRole('link', { name: /back to settings/i })).toHaveAttribute(
      'href',
      '/settings',
    )
  })

  it('does not offer it to someone who is locked out', async () => {
    // They did not arrive from Settings and cannot use the app; sign out is their exit.
    account = { ...liveAccount, subscription_status: 'canceled', subscription_live: false }
    renderPage()
    await screen.findByRole('alert')
    expect(screen.queryByRole('link', { name: /back to settings/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })
})
