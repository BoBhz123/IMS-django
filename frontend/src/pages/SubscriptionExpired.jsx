import { useNavigate } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { GlassCard } from '@/components/ui/GlassCard'

export function SubscriptionExpired() {
  const { logout } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-4">
      <AmbientBackground />

      <GlassCard
        className="w-full max-w-md p-8 text-center"
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-orange/15 text-accent-orange">
          <Clock size={26} />
        </div>

        <h1 className="font-display text-[20px] font-semibold text-text-primary">
          Your subscription has ended
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
          Your data is safe and untouched — access is paused until the subscription is renewed.
          Get in touch and we&apos;ll reactivate your account right away.
        </p>

        <a
          href="mailto:support@myimsapp.com"
          className="mt-6 inline-block w-full rounded-xl bg-accent-blue py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Contact us to renew
        </a>

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
      <div className="absolute top-1/4 left-1/4 h-96 w-96 -translate-x-1/2 rounded-full bg-accent-orange/20 blur-[120px]" />
      <div className="absolute bottom-1/4 right-1/4 h-96 w-96 translate-x-1/2 rounded-full bg-accent-purple/20 blur-[120px]" />
    </div>
  )
}
