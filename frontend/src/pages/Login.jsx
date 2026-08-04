import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Lock, User } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login(username, password)
      navigate(location.state?.from?.pathname ?? '/', { replace: true })
    } catch {
      setError('Incorrect username or password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-4">
      <AmbientBackground />

      <GlassCard
        className="w-full max-w-sm p-8"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-blue font-display text-lg font-bold text-white shadow-lg shadow-accent-blue/30">
            IMS
          </div>
          <div>
            <h1 className="font-display text-[20px] font-semibold text-text-primary">Sign in</h1>
            <p className="text-[13px] text-text-secondary">Access your inventory dashboard</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field icon={User} label="Username">
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
              className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="admin"
            />
          </Field>

          <Field icon={Lock} label="Password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="••••••••"
            />
          </Field>

          {error && <p className="text-[13px] text-accent-red">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </GlassCard>
    </div>
  )
}

function Field({ icon: Icon, label, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 focus-within:border-accent-blue/60 focus-within:ring-2 focus-within:ring-accent-blue/20">
        <Icon size={16} className="text-text-tertiary" />
        {children}
      </div>
    </label>
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
