import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Clock } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useDailyTick } from '@/hooks/useDailyTick'
import { isTrialUrgent, trialBannerMessage } from '@/lib/billing'

/**
 * The persistent trial countdown.
 *
 * Renders nothing for a paid account, so the app is uncluttered for the people who have
 * already converted. It only turns red in the last few days — a banner that shouts from day
 * one of a fortnight is a banner the user learns to stop seeing.
 *
 * The day count is derived from `account.trial_ends_at` against a clock that reticks at
 * midnight and on tab resume, not read off the server's `trial_days_remaining`. That field is
 * a snapshot taken when the session payload was fetched: correct on load, and then frozen for
 * as long as the tab stays open. This app is a shop tool that lives in a pinned tab for days,
 * so "frozen until reload" meant the banner routinely showed a number that had been wrong
 * since some previous midnight. It stays as the fallback for a payload without the timestamp.
 */
export function TrialBanner() {
  const { account } = useAuth()
  const now = useDailyTick()

  const message = trialBannerMessage(account, now)
  if (!message) return null

  const urgent = isTrialUrgent(account, 3, now)

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className={`mx-auto mb-3 flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2 text-[13px] backdrop-blur-xl sm:ml-auto ${
        urgent
          ? 'border-accent-red/30 bg-accent-red/10 text-accent-red'
          : 'border-glass-border bg-glass text-text-secondary'
      }`}
      role="status"
    >
      <span className="flex items-center gap-1.5 font-medium">
        <Clock size={14} aria-hidden="true" />
        {message}
      </span>
      <Link
        to="/subscription"
        className={`font-semibold underline underline-offset-2 transition-opacity hover:opacity-80 ${
          urgent ? 'text-accent-red' : 'text-accent-blue'
        }`}
      >
        Choose a plan
      </Link>
    </motion.div>
  )
}
