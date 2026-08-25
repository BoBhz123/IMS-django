import { memo } from 'react'
import { GlassCard } from './GlassCard'

/**
 * A titled card holding two or three related secondary metrics.
 *
 * The dashboard used to give every figure its own tile, which made "owed to you" and "owed to
 * suppliers" — two halves of one question — look like two unrelated facts sitting next to a
 * catalog count. Grouping them states the relationship the layout was previously hiding, and
 * costs a row of the grid rather than a row per number.
 *
 * Deliberately quieter than HeroStatTile: smaller numbers, no sparkline, no delta. These are
 * balances to check, not trends to watch.
 */
export const MetricGroup = memo(function MetricGroup({ title, hint, items, index = 0 }) {
  return (
    <GlassCard
      className="flex min-w-0 flex-col gap-4 p-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <h2 className="font-display text-[14px] font-semibold text-text-primary">{title}</h2>
        {hint && <span className="text-[12px] text-text-tertiary">{hint}</span>}
      </div>

      {/* A definition list, not a table: these are label/value pairs, and a screen reader
          reading "Owed to you, $48.00" is exactly the pairing dl expresses. */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-1">
            <dt className="text-[12px] font-medium text-text-tertiary">{item.label}</dt>
            <dd
              className="min-w-0 break-words font-display text-[20px] font-semibold leading-none tabular-nums"
              style={{ color: item.tone ?? 'var(--text-primary)' }}
            >
              {item.value}
            </dd>
            {item.hint && <span className="text-[12px] text-text-tertiary">{item.hint}</span>}
          </div>
        ))}
      </dl>
    </GlassCard>
  )
})
