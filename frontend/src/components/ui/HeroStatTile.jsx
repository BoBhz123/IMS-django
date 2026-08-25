import { memo } from 'react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { GlassCard } from './GlassCard'
import { Sparkline } from './Sparkline'

/**
 * A headline KPI. Four of these sit above everything else on the dashboard.
 *
 * The distinction from StatTile is hierarchy, not features: more padding, a larger and
 * heavier number, and an accent rule down the leading edge. Ten equally weighted tiles read
 * as a wall of numbers with no entry point — the eye has nowhere to land first, so the figure
 * a shopkeeper actually opens the app for ("did I make money, and has it arrived?") competes
 * with the catalog size for attention.
 *
 * `footnote` is where a KPI carries its own context — outstanding balance under revenue,
 * margin under profit — so the headline stays one number instead of becoming two.
 */
export const HeroStatTile = memo(function HeroStatTile({
  label,
  value,
  delta,
  deltaLabel = 'vs. last month',
  sparkline,
  footnote,
  accent = 'var(--accent-blue)',
  index = 0,
}) {
  const hasDelta = delta && Number.isFinite(delta.percent)
  const isGood = hasDelta && (delta.direction === 'up') === delta.goodWhenUp
  const DeltaIcon = delta?.direction === 'down' ? ArrowDownRight : ArrowUpRight

  return (
    <GlassCard
      className="relative flex min-w-0 flex-col gap-3 overflow-hidden p-5 sm:p-6"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* The leading rule. aria-hidden and pointer-events-none — it is the only thing
          separating the hero row from the secondary widgets at a glance, and it carries no
          information a screen reader has any use for. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: accent }}
      />

      <div className="flex items-start justify-between gap-2">
        <span className="text-[12px] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
          {label}
        </span>
        {sparkline && sparkline.length > 1 && <Sparkline data={sparkline} />}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-display text-[30px] font-semibold leading-none text-text-primary tabular-nums sm:text-[34px]">
          {value}
        </span>
        {hasDelta && (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[13px] font-medium"
            style={{ color: isGood ? 'var(--delta-good)' : 'var(--delta-bad)' }}
          >
            <DeltaIcon size={14} strokeWidth={2.5} />
            {delta.percent.toFixed(1)}%
          </span>
        )}
      </div>

      {(footnote || hasDelta) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {footnote}
          {hasDelta && <span className="text-[12px] text-text-tertiary">{deltaLabel}</span>}
        </div>
      )}
    </GlassCard>
  )
})

/**
 * The pill under a hero figure — an outstanding balance, a margin.
 *
 * `tone` is deliberately not derived from the number's sign. "$48 owed to you" is neutral at
 * a healthy business and alarming at a struggling one, and this component cannot tell which;
 * the caller decides.
 */
export function StatFootnote({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'border-glass-border bg-canvas-2 text-text-secondary',
    warn: 'border-accent-orange/30 bg-accent-orange/10 text-accent-orange',
    good: 'border-accent-green/30 bg-accent-green/10 text-accent-green',
  }
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[12px] font-medium tabular-nums ${tones[tone] ?? tones.neutral}`}
    >
      {children}
    </span>
  )
}
