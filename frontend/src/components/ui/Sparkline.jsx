import { memo } from 'react'

/**
 * The little trend line in the corner of a stat tile.
 *
 * Extracted from StatTile so HeroStatTile can use the same one — two copies would drift, and
 * the drift would be invisible (both render a plausible line either way).
 *
 * memo'd because the dashboard mounts one per stat tile and re-renders the tree whenever the
 * period selector or the currency toggle moves. The `data` array is built inside a useMemo in
 * Dashboard for the same reason: a fresh array on every render defeats this.
 */
export const Sparkline = memo(function Sparkline({ data }) {
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
})
