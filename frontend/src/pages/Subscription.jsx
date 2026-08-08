import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, KeyRound, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { formatKeyInput, isCompleteKey, normalizeKey } from '@/lib/billing'

export function Subscription() {
  const { account, refreshAccount, logout } = useAuth()
  const navigate = useNavigate()
  const [config, setConfig] = useState(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get('/billing/config/')
      .then(({ data }) => {
        if (!cancelled) setConfig(data)
      })
      .catch(() => {
        // The plans are a nicety; the key field is the part that has to work. Falling back
        // to an empty plan list keeps activation reachable if this call fails.
        if (!cancelled) setConfig({ card_checkout_available: false, plans: [] })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const lapsed = account?.status === 'past_due' || account?.status === 'canceled'

  async function handleRedeem(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/billing/redeem-key/', { code: normalizeKey(key) })
      const refreshed = await refreshAccount()
      if (refreshed?.status === 'active') navigate('/', { replace: true })
    } catch (caught) {
      setError(caught?.response?.data?.detail ?? 'Could not activate with that key.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCheckout(planKey) {
    setError(null)
    try {
      await api.post('/billing/checkout/', { plan: planKey })
      // Paddle.js takes over here in 2.5b-2. Until then the server answers 503 and the
      // catch below explains why, so this branch is unreachable in practice.
    } catch (caught) {
      setError(caught?.response?.data?.detail ?? 'Could not start checkout.')
    }
  }

  async function handleSignOut() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <AmbientBackground />

      <GlassCard
        className="w-full max-w-2xl p-8"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue/15 text-accent-blue">
            <Sparkles size={26} />
          </div>
          <h1 className="font-display text-[22px] font-semibold text-text-primary">
            {lapsed ? 'Your subscription has ended' : 'Choose your plan'}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-text-secondary">
            {lapsed
              ? 'Your data is safe and untouched — access resumes as soon as the subscription is renewed.'
              : 'Your email is verified. Pick a plan or enter a discount key to activate your account.'}
          </p>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          {(config?.plans ?? []).map((plan) => (
            <div
              key={plan.key}
              className="rounded-2xl border border-hairline bg-canvas-2 p-5 text-left"
            >
              <p className="text-[13px] font-medium text-text-secondary">{plan.name}</p>
              <p className="mt-1 font-display text-[26px] font-semibold text-text-primary">
                ${plan.price_usd}
                <span className="ml-1.5 text-[13px] font-normal text-text-tertiary">
                  {plan.period}
                </span>
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
                {plan.description}
              </p>
              {config?.card_checkout_available && (
                <button
                  type="button"
                  onClick={() => handleCheckout(plan.key)}
                  className="mt-4 w-full rounded-xl bg-accent-blue py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Pay with card
                </button>
              )}
            </div>
          ))}
        </div>

        {config && !config.card_checkout_available && (
          <p className="mt-4 rounded-xl border border-hairline bg-canvas-2 px-4 py-3 text-[13px] leading-relaxed text-text-secondary">
            Card payment is not available yet. Contact us to pay by cash, Whish, or OMT and
            we&apos;ll send you a key to activate your account below.
          </p>
        )}

        <form onSubmit={handleRedeem} className="mt-6 border-t border-hairline pt-6">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <KeyRound size={13} /> Discount key
            </span>
            <input
              type="text"
              autoComplete="off"
              spellCheck="false"
              value={formatKeyInput(key)}
              onChange={(event) => setKey(normalizeKey(event.target.value))}
              placeholder="ABCD-EFGH-JKMN"
              className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 text-center font-display text-[17px] tracking-[0.2em] text-text-primary focus:border-accent-blue/60 focus:outline-none focus:ring-2 focus:ring-accent-blue/20"
            />
          </label>

          {error && <p className="mt-3 text-[13px] text-accent-red">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !isCompleteKey(key)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-green py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check size={16} />
            {submitting ? 'Activating…' : 'Activate account'}
          </button>
        </form>

        <button
          type="button"
          onClick={handleSignOut}
          className="mt-3 w-full rounded-xl border border-hairline py-2.5 text-[14px] font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          Sign out
        </button>
      </GlassCard>
    </div>
  )
}

function AmbientBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="absolute top-1/4 left-1/4 h-96 w-96 -translate-x-1/2 rounded-full bg-accent-blue/20 blur-[120px]" />
      <div className="absolute bottom-1/4 right-1/4 h-96 w-96 translate-x-1/2 rounded-full bg-accent-purple/20 blur-[120px]" />
    </div>
  )
}
