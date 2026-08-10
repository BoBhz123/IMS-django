import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MailCheck } from 'lucide-react'
import { api } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'
import { formatCooldown, isCompleteCode, normalizeCode } from '@/lib/onboarding'

export function VerifyEmail() {
  const { account, refreshAccount } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      await api.post('/accounts/verify-email/', { code })
      await refreshAccount()
      navigate('/subscription', { replace: true })
    } catch (caught) {
      setError(caught?.response?.data?.detail ?? 'Could not verify that code. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResend() {
    setError(null)
    setNotice(null)
    try {
      const { data } = await api.post('/accounts/resend-code/')
      setNotice(data.detail)
      setCode('')
      setCooldown(60)
    } catch (caught) {
      const body = caught?.response?.data
      setError(body?.detail ?? 'Could not send a new code.')
      // The server tells us exactly how long to wait — mirror it rather than guessing.
      if (body?.retry_after) setCooldown(body.retry_after)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <AmbientBackground />

      <GlassCard
        className="w-full max-w-sm p-8 text-center"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue/15 text-accent-blue">
          <MailCheck size={26} />
        </div>

        <h1 className="font-display text-[20px] font-semibold text-text-primary">
          Check your email
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
          We sent a 6-digit code to{' '}
          <span className="font-medium text-text-primary">{account?.email}</span>. It expires in
          10 minutes.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-left">
            <span className="text-[12px] font-medium text-text-secondary">Verification code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(normalizeCode(event.target.value))}
              className="w-full rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 text-center font-display text-[22px] tracking-[0.4em] text-text-primary focus:border-accent-blue/60 focus:outline-none focus:ring-2 focus:ring-accent-blue/20"
              placeholder="000000"
            />
          </label>

          {error && <p className="text-[13px] text-accent-red">{error}</p>}
          {notice && <p className="text-[13px] text-accent-green">{notice}</p>}

          <button
            type="submit"
            disabled={submitting || !isCompleteCode(code)}
            className="rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Verifying…' : 'Verify email'}
          </button>
        </form>

        <button
          type="button"
          onClick={handleResend}
          disabled={cooldown > 0}
          className="mt-4 text-[13px] font-medium text-accent-blue transition-opacity hover:underline disabled:opacity-50 disabled:hover:no-underline"
        >
          {cooldown > 0 ? `Resend in ${formatCooldown(cooldown)}` : 'Send a new code'}
        </button>
      </GlassCard>
    </div>
  )
}

function AmbientBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="absolute top-1/4 left-1/4 h-96 w-96 -translate-x-1/2 rounded-full bg-accent-blue/25 blur-[120px]" />
      <div className="absolute bottom-1/4 right-1/4 h-96 w-96 translate-x-1/2 rounded-full bg-accent-purple/20 blur-[120px]" />
    </div>
  )
}
