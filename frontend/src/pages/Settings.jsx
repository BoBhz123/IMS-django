import { Link } from 'react-router-dom'
import { CreditCard, Mail, Phone, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useTheme } from '@/context/ThemeContext'
import { formatDate, planLabel, renewalInfo } from '@/lib/billing'

/**
 * Everything about the account that is read-only elsewhere in the app.
 *
 * Subscription state is shown from the account payload rather than recomputed here: the
 * server sends both `subscription_live` and the countdown already, and deriving either
 * from `expires_at` in the browser would drift with the device clock.
 */
export function Settings() {
  const { user, account } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const { currency, toggleCurrency } = useCurrency()
  const renewal = renewalInfo(account)

  return (
    <div className="space-y-5">
      <section>
        <h2 className="font-display text-[17px] font-semibold text-text-primary">Account</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field icon={ShieldCheck} label="Business" value={account?.business_name} />
          <Field icon={Mail} label="Email" value={account?.email ?? user?.email} />
          <Field icon={Phone} label="Phone" value={account?.phone} />
        </div>
      </section>

      <section>
        <h2 className="font-display text-[17px] font-semibold text-text-primary">
          Subscription &amp; Billing
        </h2>
        <div className="mt-3 rounded-2xl border border-hairline bg-canvas-2 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
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
        </div>
      </section>

      <section>
        <h2 className="font-display text-[17px] font-semibold text-text-primary">
          Preferences
        </h2>
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
      </section>
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

function Field({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-2xl border border-hairline bg-canvas-2 p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary">
        <Icon size={13} aria-hidden="true" /> {label}
      </p>
      <p className="mt-1 truncate text-[14px] font-medium text-text-primary">{value || '—'}</p>
      {hint && <p className="mt-1 text-[12px] text-text-tertiary">{hint}</p>}
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
