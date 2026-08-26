import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Building2, Lock, Mail, Phone } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { BrandMark } from '@/components/ui/BrandMark'
import { GlassCard } from '@/components/ui/GlassCard'

export function Signup() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState({})
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    setFieldErrors({})
    try {
      await register({ email, password, phone, businessName })
      // Straight to the code screen — the account exists but is inert until verified and paid.
      navigate('/signup/verify', { replace: true })
    } catch (caught) {
      // Djoser returns per-field arrays: {username: ["..."], password: ["...", "..."]}.
      // Show them beside the field they belong to rather than collapsing to one line.
      const body = caught?.response?.data
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        setFieldErrors(body)
        if (!body.email && !body.phone && !body.password && !body.business_name) {
          setError('Could not create your account. Please try again.')
        }
      } else {
        setError('Could not create your account. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <AmbientBackground />

      <GlassCard
        className="w-full max-w-sm p-8"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark size={56} className="rounded-2xl shadow-lg shadow-accent-blue/30" />
          <div>
            <h1 className="font-display text-[20px] font-semibold text-text-primary">
              Create your account
            </h1>
            <p className="text-[13px] text-text-secondary">Verify your email, then choose a plan</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field icon={Building2} label="Business name" error={fieldErrors.business_name}>
            <input
              type="text"
              autoComplete="organization"
              value={businessName}
              onChange={(event) => setBusinessName(event.target.value)}
              className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="Corner Shop"
            />
          </Field>

          <Field icon={Mail} label="Email" error={fieldErrors.email}>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="you@example.com"
            />
          </Field>

          <Field icon={Phone} label="Phone number" error={fieldErrors.phone}>
            <input
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none"
              placeholder="+961 70 123 456"
            />
          </Field>

          <Field icon={Lock} label="Password" error={fieldErrors.password}>
            <input
              type="password"
              autoComplete="new-password"
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
            {submitting ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className="mt-6 text-center text-[13px] text-text-secondary">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent-blue hover:underline">
            Sign in
          </Link>
        </p>
      </GlassCard>
    </div>
  )
}

function Field({ icon: Icon, label, error, children }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-text-secondary">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-hairline bg-canvas-2 px-3 py-2.5 focus-within:border-accent-blue/60 focus-within:ring-2 focus-within:ring-accent-blue/20">
        <Icon size={16} className="text-text-tertiary" />
        {children}
      </div>
      {error && (
        <span className="text-[12px] text-accent-red">
          {Array.isArray(error) ? error[0] : error}
        </span>
      )}
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
