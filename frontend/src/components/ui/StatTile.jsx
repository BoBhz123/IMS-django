import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { GlassCard } from './GlassCard'

export function StatTile({ label, value, delta, sparkline, index = 0, deltaLabel = 'vs. last month' }) {
  const hasDelta = delta && Number.isFinite(delta.percent)
  const isGood = hasDelta && (delta.direction === 'up') === delta.goodWhenUp
  const DeltaIcon = delta?.direction === 'down' ? ArrowDownRight : ArrowUpRight

  return (
    <GlassCard
      className="flex min-w-0 flex-col gap-3 overflow-hidden p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium tracking-wide text-text-secondary">{label}</span>
        {sparkline && sparkline.length > 1 && <Sparkline data={sparkline} />}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-display text-[28px] font-semibold leading-none text-text-primary tabular-nums">
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
      {hasDelta && <span className="text-[12px] text-text-tertiary">{deltaLabel}</span>}
    </GlassCard>
  )
}

function Sparkline({ data }) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const width = 56
  const height = 22
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width
      const y = height - ((value - min) / range) * height
      return `${x},${y}`
    })
    .join(' ')
  const lastX = width
  const lastY = height - ((data.at(-1) - min) / range) * height

  return (
    <svg width={width} height={height} className="shrink-0 overflow-visible" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" opacity="0.5" />
      <circle cx={lastX} cy={lastY} r="2.5" fill="var(--accent-blue)" stroke="var(--chart-surface)" strokeWidth="1.5" />
    </svg>
  )
}
