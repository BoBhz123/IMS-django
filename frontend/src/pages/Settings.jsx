import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, CreditCard, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useTheme } from '@/context/ThemeContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { formatCooldown, isCompleteCode, normalizeCode } from '@/lib/onboarding'
import { canSubmitPassword, errorMessage, passwordProblem } from '@/lib/passwordReset'
import { formatDate, planLabel, renewalInfo } from '@/lib/billing'

/**
 * Everything about the account the customer can see or change themselves: their details, what
 * they are paying for, their password, and display preferences.
 *
 * Subscription state is read straight off the account payload, never recomputed here — the
 * server already sends `subscription_live` and the trial countdown, and deriving either from a
 * date in the browser would drift with the device clock and disagree with what the API
 * enforces. Nothing on this screen mutates billing: the only affordance is a link to
 * /subscription, because a second activation path is a second thing to secure.
 *
 * This page stays reachable while a subscription is expired (see `UNPAID_ALLOWED_PATHS`),
 * which is why the account id support asks for, and the reassurance that the data is still
 * there, both live here rather than behind the wall.
 */
export function Settings() {
  const { user, account, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { currency, toggleCurrency } = useCurrency()
  const renewal = renewalInfo(account)

  const [step, setStep] = useState('request')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  function reset() {
    setStep('request')
    setCode('')
    setNewPassword('')
    setConfirmPassword('')
    setError(null)
    setNotice(null)
  }

  async function requestCode() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { data } = await api.post('/accounts/password-reset/request/')
      setNotice(data.detail)
      setStep('code')
      setCooldown(60)
    } catch (caught) {
      setError(errorMessage(caught, 'Could not send a code.'))
      // The server says exactly how long to wait; mirror it rather than guessing.
      const retryAfter = caught?.response?.data?.retry_after
      if (retryAfter) setCooldown(retryAfter)
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.post('/accounts/password-reset/verify/', { code })
      setStep('password')
    } catch (caught) {
      setError(errorMessage(caught, 'Could not check that code.'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmReset(event) {
    event.preventDefault()
    const problem = passwordProblem(newPassword, confirmPassword)
    if (problem) {
      setError(problem)
      return
    }

    setBusy(true)
    setError(null)
    try {
      await api.post('/accounts/password-reset/confirm/', {
        code,
        new_password: newPassword,
        confirm_password: confirmPassword,
      })
      setDone(true)
    } catch (caught) {
      setError(errorMessage(caught, 'Could not change your password.'))
      // A rejected password does not spend the code, so the user stays on this step and
      // tries another one — sending them back to step 1 would cost them an email they do
      // not need.
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <GlassCard className="p-8 text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-green/15 text-accent-green">
            <Check size={26} />
          </div>
          <h2 className="font-display text-[18px] font-semibold text-text-primary">
            Password changed
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
            Every other device signed into this account has been signed out. Sign in again with
            your new password.
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-6 w-full rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Sign in again
          </button>
        </GlassCard>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5">
      <section>
        <h1 className="font-display text-[20px] font-semibold text-text-primary">
          Account settings
        </h1>
        <p className="mt-1 text-[14px] text-text-secondary">
          {account?.business_name || 'Your account'}
        </p>
      </section>

      <GlassCard as="section" aria-label="Your details" className="p-5">
        <h2 className="font-display text-[15px] font-semibold text-text-primary">Your details</h2>
        <dl className="mt-3 flex flex-col gap-2.5">
          <Detail label="Email" value={account?.email || user?.email} />
          <Detail label="Phone" value={account?.phone} />
          <Detail label="Business" value={account?.business_name} />
        </dl>
      </GlassCard>

      <GlassCard as="section" aria-label="Subscription and billing" className="p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-blue/15 text-accent-blue">
            <CreditCard size={16} />
          </span>
          <h2 className="font-display text-[15px] font-semibold text-text-primary">
            Subscription &amp; Billing
          </h2>
        </div>

        <div className="mt-4">
          <SubscriptionSummary account={account} />
        </div>

        <dl className="mt-4 grid gap-3 border-t border-hairline pt-4 sm:grid-cols-3">
          <SummaryItem label="Current plan" value={currentPlanLabel(account)} />
          <SummaryItem
            label={renewal?.label ?? 'Renewal'}
            value={
              renewal
                ? formatDate(renewal.value)
                : account?.plan_type === 'one_time'
                  ? 'Never — lifetime licence'
                  : '—'
            }
          />
          <SummaryItem
            label="Account ID"
            value={account?.id ? `#${account.id}` : '—'}
            hint="Quote this when you contact support."
          />
        </dl>

        <Link
          to="/subscription"
          className="mt-5 inline-flex items-center gap-1.5 rounded-xl bg-accent-blue px-4 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          <CreditCard size={14} />
          {account?.subscription_live ? 'Manage / upgrade plan' : 'Choose a plan'}
        </Link>
      </GlassCard>

      <GlassCard as="section" aria-label="Password" className="p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-blue/15 text-accent-blue">
            <KeyRound size={16} />
          </span>
          <h2 className="font-display text-[15px] font-semibold text-text-primary">Password</h2>
        </div>

        <StepTrail step={step} />

        {step === 'request' && (
          <div className="mt-4">
            <p className="text-[14px] leading-relaxed text-text-secondary">
              We will email a 6-digit code to{' '}
              <span className="font-medium text-text-primary">
                {account?.email || user?.email}
              </span>
              . You will need it to set a new password.
            </p>
            {error && <p className="mt-3 text-[13px] text-accent-red">{error}</p>}
            <button
              type="button"
              onClick={requestCode}
              disabled={busy || cooldown > 0}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent-blue px-4 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Mail size={15} />
              {cooldown > 0
                ? `Resend in ${formatCooldown(cooldown)}`
                : busy
                  ? 'Sending…'
                  : 'Send reset code'}
            </button>
          </div>
        )}

        {step === 'code' && (
          <form onSubmit={verifyCode} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-text-secondary">
                6-digit code
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                placeholder="000000"
                className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 text-center font-display text-[22px] tracking-[0.4em] text-text-primary focus:border-accent-blue/60 focus:outline-none focus:ring-2 focus:ring-accent-blue/20"
              />
            </label>

            {notice && <p className="text-[13px] text-accent-green">{notice}</p>}
            {error && <p className="text-[13px] text-accent-red">{error}</p>}

            <button
              type="submit"
              disabled={busy || !isCompleteCode(code)}
              className="rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>

            <div className="flex items-center justify-between">
              <BackButton onClick={reset} />
              <button
                type="button"
                onClick={requestCode}
                disabled={cooldown > 0 || busy}
                className="text-[13px] font-medium text-accent-blue hover:underline disabled:opacity-50 disabled:hover:no-underline"
              >
                {cooldown > 0 ? `Resend in ${formatCooldown(cooldown)}` : 'Send a new code'}
              </button>
            </div>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={confirmReset} className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-text-secondary">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 text-[14px] text-text-primary focus:border-accent-blue/60 focus:outline-none focus:ring-2 focus:ring-accent-blue/20"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-text-secondary">
                Confirm new password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 text-[14px] text-text-primary focus:border-accent-blue/60 focus:outline-none focus:ring-2 focus:ring-accent-blue/20"
              />
            </label>

            {error && <p className="text-[13px] text-accent-red">{error}</p>}

            <button
              type="submit"
              disabled={busy || !canSubmitPassword(newPassword, confirmPassword)}
              className="rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Change password'}
            </button>
            <BackButton onClick={() => setStep('code')} />
          </form>
        )}
      </GlassCard>

      <GlassCard as="section" aria-label="Preferences" className="p-5">
        <h2 className="font-display text-[15px] font-semibold text-text-primary">Preferences</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Toggle
            label="Appearance"
            value={theme === 'dark' ? 'Dark' : 'Light'}
            onClick={toggleTheme}
          />
          <Toggle
            label="Display currency"
            value={currency}
            onClick={toggleCurrency}
            hint="Changes how amounts are shown. Stored values are always USD."
          />
        </div>
      </GlassCard>
    </div>
  )
}

function SubscriptionSummary({ account }) {
  const status = account?.subscription_status
  const live = Boolean(account?.subscription_live)

  if (status === 'trialing') {
    const days = account?.trial_days_remaining
    return (
      <>
        <StatusPill live={live} label={live ? 'Free trial' : 'Trial ended'} />
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
          {live
            ? `${days} ${days === 1 ? 'day' : 'days'} remaining. No card required until you choose a plan.`
            : 'Your free trial has ended. Choose a plan to restore access — your data is untouched.'}
        </p>
      </>
    )
  }

  if (status === 'active') {
    return (
      <>
        <StatusPill live={live} label={live ? 'Active' : 'Expired'} />
        <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
          {planLabel(account?.plan_type)} plan
          {account?.expires_at
            ? ` — ${live ? 'renews' : 'expired'} ${formatDate(account.expires_at) ?? 'soon'}.`
            : ' — lifetime licence, no renewal needed.'}
        </p>
      </>
    )
  }

  return (
    <>
      <StatusPill live={false} label={status === 'canceled' ? 'Canceled' : 'Not active'} />
      <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
        Choose a plan to start using the app. You can pay by card, Whish Money, or cash.
      </p>
    </>
  )
}

function StatusPill({ live, label }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold ${
        live ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-accent-green' : 'bg-accent-red'}`}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

/** "Trialing" is a plan in the customer's mind even though it is a status in the database. */
function currentPlanLabel(account) {
  if (account?.subscription_status === 'trialing') return 'Trialing'
  if (!account?.plan_type) return 'No plan'
  return planLabel(account.plan_type)
}

function SummaryItem({ label, value, hint }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-text-secondary">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-medium text-text-primary">{value ?? '—'}</dd>
      {hint && <p className="mt-0.5 text-[12px] text-text-tertiary">{hint}</p>}
    </div>
  )
}

function Toggle({ label, value, onClick, hint }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-2xl border border-hairline bg-canvas-2 p-4 text-left transition-colors hover:border-hairline-strong"
    >
      <p className="text-[12px] font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-[14px] font-medium text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-text-tertiary">{hint}</p>}
    </button>
  )
}

function Detail({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[13px] text-text-secondary">{label}</dt>
      <dd className="text-[13px] font-medium text-text-primary">{value || '—'}</dd>
    </div>
  )
}

function BackButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[13px] font-medium text-text-secondary hover:text-text-primary"
    >
      <ArrowLeft size={14} />
      Back
    </button>
  )
}

function StepTrail({ step }) {
  const labels = [
    { key: 'request', label: 'Request code' },
    { key: 'code', label: 'Enter code' },
    { key: 'password', label: 'New password' },
  ]
  const currentIndex = labels.findIndex((item) => item.key === step)

  return (
    <ol className="mt-4 flex items-center gap-2" aria-label="Password reset progress">
      {labels.map((item, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
        return (
          <li key={item.key} className="flex flex-1 items-center gap-2">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                state === 'todo'
                  ? 'bg-canvas-2 text-text-secondary'
                  : 'bg-accent-blue text-white'
              }`}
            >
              {state === 'done' ? <ShieldCheck size={12} /> : index + 1}
            </span>
            <span
              className={`hidden text-[12px] font-medium sm:inline ${
                state === 'todo' ? 'text-text-secondary' : 'text-text-primary'
              }`}
            >
              {item.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
