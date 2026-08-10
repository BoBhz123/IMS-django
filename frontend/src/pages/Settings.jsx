import { useEffect, useState } from 'react'
import { ArrowLeft, Check, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { formatCooldown, isCompleteCode, normalizeCode } from '@/lib/onboarding'
import { canSubmitPassword, errorMessage, passwordProblem } from '@/lib/passwordReset'

export function Settings() {
  const { user, account, logout } = useAuth()

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
    </div>
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
