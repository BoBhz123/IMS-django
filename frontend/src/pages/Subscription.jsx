import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  CreditCard,
  KeyRound,
  MessageCircle,
  Send,
  Sparkles,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'
import {
  buildSupportMessage,
  formatDate,
  formatKeyInput,
  isCompleteKey,
  normalizeKey,
  paymentMethodLabel,
  planLabel,
  renewalInfo,
  subscriptionBadge,
  telegramUrl,
  whatsappUrl,
} from '@/lib/billing'
import { openPaddleCheckout } from '@/lib/paddle'

export function Subscription() {
  const { user, account, refreshAccount, logout } = useAuth()
  const navigate = useNavigate()
  const [config, setConfig] = useState(null)
  const [selectedPlan, setSelectedPlan] = useState('annual')
  const [key, setKey] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkingOut, setCheckingOut] = useState(null)

  useEffect(() => {
    let cancelled = false
    api
      .get('/billing/config/')
      .then(({ data }) => {
        if (!cancelled) setConfig(data)
      })
      .catch(() => {
        // The plans are a nicety; the key field and the chat links are the parts that have
        // to work. Falling back to an empty plan list keeps activation reachable.
        if (!cancelled) setConfig({ card_checkout_available: false, plans: [], local_payment: {} })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const live = Boolean(account?.subscription_live)
  const lapsed =
    account?.subscription_status === 'past_due' || account?.subscription_status === 'canceled'
  const trialEnded = account?.subscription_status === 'trialing' && !account?.subscription_live

  // A live subscriber lands on a summary, not a wall of prices — showing checkout to someone
  // who has already paid reads as "we lost your payment". The catalog is one click away.
  // An account that is *not* live sees the plans immediately: for them this screen is the
  // only way out, and an extra click before the fix is an extra click of friction.
  const [showPlans, setShowPlans] = useState(false)
  const plansVisible = !live || showPlans

  const supportMessage = buildSupportMessage({
    accountId: account?.id,
    email: account?.email ?? user?.email,
    plan: selectedPlan,
    renewing: lapsed,
  })
  const whatsapp = whatsappUrl(config?.local_payment?.whatsapp_number, supportMessage)
  const telegram = telegramUrl(config?.local_payment?.telegram_username, supportMessage)

  async function handleRedeem(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/billing/redeem-key/', { code: normalizeKey(key) })
      // Refresh first, then route off the server's computed answer — not off the 200. A key
      // that activated something must leave the app in a state the router agrees is live, or
      // ProtectedRoute bounces the user straight back here.
      const refreshed = await refreshAccount()
      if (refreshed?.subscription_live) navigate('/', { replace: true })
    } catch (caught) {
      setError(caught?.response?.data?.detail ?? 'Could not activate with that key.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCheckout(planKey) {
    setError(null)
    setCheckingOut(planKey)
    try {
      const { data } = await api.post('/billing/checkout/', { plan: planKey })
      await openPaddleCheckout(data, { email: account?.email ?? user?.email })
      // Nothing is granted here. Access arrives via the signed webhook, and the app picks it
      // up on the next status refresh — a redirect parameter saying "paid" is forgeable.
    } catch (caught) {
      setError(
        caught?.response?.data?.detail ??
          caught?.message ??
          'Could not start checkout. Please try again, or pay by Whish or cash below.',
      )
    } finally {
      setCheckingOut(null)
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
        className="w-full max-w-3xl p-8"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue/15 text-accent-blue">
            <Sparkles size={26} />
          </div>
          <h1 className="font-display text-[22px] font-semibold text-text-primary">
            {live
              ? 'Your subscription'
              : lapsed
                ? 'Your subscription has ended'
                : trialEnded
                  ? 'Your free trial has ended'
                  : 'Choose your plan'}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-text-secondary">
            {live
              ? 'Everything below is active. You can change plan at any time.'
              : lapsed || trialEnded
                ? 'Your data is safe and untouched — access resumes the moment a plan is active.'
                : 'Every plan includes the same full access. Pick how you would like to pay.'}
          </p>
        </div>

        {live && <CurrentSubscriptionCard account={account} />}

        {!live && (
          <p
            role="alert"
            className="mt-6 rounded-xl border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-[13px] font-medium text-accent-red"
          >
            Your subscription has expired or is inactive. Choose a plan below, or enter an
            activation key, to restore access.
          </p>
        )}

        {live && !showPlans && (
          <button
            type="button"
            onClick={() => setShowPlans(true)}
            className="mt-5 w-full rounded-xl border border-hairline py-2.5 text-[14px] font-medium text-text-secondary transition-colors hover:border-hairline-strong hover:text-text-primary"
          >
            Change or upgrade plan
          </button>
        )}

        {plansVisible && (
          <div className="mt-7 grid gap-4 sm:grid-cols-3">
            {(config?.plans ?? []).map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                selected={selectedPlan === plan.key}
                busy={checkingOut === plan.key}
                onSelect={() => setSelectedPlan(plan.key)}
                onCheckout={() => handleCheckout(plan.key)}
              />
            ))}
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-xl border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-[13px] leading-relaxed text-accent-red">
            {error}
          </p>
        )}

        {plansVisible && (whatsapp || telegram) && (
          <section className="mt-6 rounded-2xl border border-hairline bg-canvas-2 p-5">
            <h2 className="text-[14px] font-semibold text-text-primary">
              Pay with Whish Money or cash
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
              Message us and we&apos;ll send you an activation key. Your account details are
              filled in already — just hit send.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {whatsapp && (
                <a
                  href={whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-green py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  <MessageCircle size={15} /> WhatsApp
                </a>
              )}
              {telegram && (
                <a
                  href={telegram}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent-blue py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  <Send size={15} /> Telegram
                </a>
              )}
            </div>
          </section>
        )}

        {plansVisible && (
        <form onSubmit={handleRedeem} className="mt-6 border-t border-hairline pt-6">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
              <KeyRound size={13} /> Activation key
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

          <button
            type="submit"
            disabled={submitting || !isCompleteKey(key)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-green py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check size={16} />
            {submitting ? 'Activating…' : 'Activate account'}
          </button>
        </form>
        )}

        {/* Only for a live subscriber, who arrived here from Settings and needs the way
            back. Someone locked out did not come from there and cannot use the app anyway —
            for them the sign-out button below is the escape hatch, and a link into a second
            screen they can barely use is noise. */}
        {live && (
          <Link
            to="/settings"
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-hairline py-2.5 text-[14px] font-medium text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowLeft size={15} />
            Back to Settings
          </Link>
        )}

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

/**
 * What a paying customer sees instead of a price list.
 *
 * Every value here comes from the server's computed fields — `subscription_live` and the
 * badge derived from it, never a date comparison in the browser. A device with a wrong clock
 * must not be told it is subscribed when the API has already stopped serving it.
 */
function CurrentSubscriptionCard({ account }) {
  const badge = subscriptionBadge(account)
  const renewal = renewalInfo(account)

  return (
    <section className="mt-6 rounded-2xl border border-accent-green/30 bg-accent-green/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-text-primary">
          Current active subscription
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-green/15 px-2.5 py-1 text-[12px] font-semibold text-accent-green">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-green" aria-hidden="true" />
          {badge.label}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <SummaryItem label="Plan" value={planLabel(account?.plan_type)} />
        <SummaryItem
          label="Payment"
          value={paymentMethodLabel(account?.payment_method)}
        />
        <SummaryItem
          label={renewal?.label ?? 'Renews'}
          value={renewal ? formatDate(renewal.value) : 'Never — lifetime licence'}
        />
      </dl>
    </section>
  )
}

function SummaryItem({ label, value }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-medium text-text-primary">{value ?? '—'}</dd>
    </div>
  )
}

/**
 * Selection is a real radio input rather than a click handler on the card.
 *
 * The obvious version — role="button" on the container with the pay button inside it —
 * nests one interactive control in another, which is invalid ARIA: a screen reader reads
 * the outer control's name as the whole card including "Pay with card", and the two targets
 * become indistinguishable. A radio also gets arrow-key navigation across the group for free.
 */
function PlanCard({ plan, selected, busy, onSelect, onCheckout }) {
  return (
    <div
      className={`relative rounded-2xl border transition-colors ${
        selected
          ? 'border-accent-blue/60 bg-accent-blue/5'
          : 'border-hairline bg-canvas-2 hover:border-hairline-strong'
      }`}
    >
      {plan.highlight && (
        <span className="absolute -top-2 right-4 rounded-full bg-accent-blue px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
          Best value
        </span>
      )}

      <label className="block cursor-pointer p-5 text-left">
        <input
          type="radio"
          name="plan"
          value={plan.key}
          checked={selected}
          onChange={onSelect}
          className="sr-only"
        />
        <span className="block text-[13px] font-medium text-text-secondary">{plan.name}</span>
        <span className="mt-1 block font-display text-[26px] font-semibold text-text-primary">
          ${plan.price_usd}
          <span className="ml-1.5 text-[13px] font-normal text-text-tertiary">
            {plan.period}
          </span>
        </span>
        <span className="mt-2 block text-[13px] leading-relaxed text-text-secondary">
          {plan.description}
        </span>
      </label>

      {plan.card_available && (
        <div className="px-5 pb-5">
          <button
            type="button"
            onClick={onCheckout}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent-blue py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <CreditCard size={14} />
            {busy ? 'Opening…' : 'Pay with card'}
          </button>
        </div>
      )}
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
