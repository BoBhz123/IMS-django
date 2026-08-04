import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { useCurrency } from '@/context/CurrencyContext'

const SERIES = [
  { key: 'revenue', name: 'Revenue', color: 'var(--chart-series-revenue)' },
  { key: 'cost', name: 'Cost', color: 'var(--chart-series-cost)' },
]

function EndLabel({ x, y, index, data, dataKey, formatAmount }) {
  if (index !== data.length - 1) return null
  return (
    <text x={x + 6} y={y} dy={4} fontSize={11} fontWeight={600} fill="var(--text-primary)">
      {formatAmount(data[index][dataKey], undefined, { compact: true })}
    </text>
  )
}

export function RevenueTrendChart({ data }) {
  const { formatAmount } = useCurrency()

  return (
    <div>
      <Legend />
      <ResponsiveContainer width="100%" height={220}>
        {/* right margin sized for the widest end label ("78.1B LBP") — the old 48px clipped the
            SVG <text> at the canvas edge in LBP mode, mangling the trailing "LBP" glyphs. */}
        <AreaChart data={data} margin={{ top: 12, right: 76, bottom: 0, left: 0 }}>
          <defs>
            {SERIES.map((series) => (
              <linearGradient key={series.key} id={`fill-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={series.color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--text-tertiary)', fontSize: 12 }}
            dy={8}
          />
          <Tooltip
            content={<ChartTooltip formatAmount={formatAmount} />}
            cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
          />
          {SERIES.map((series) => (
            <Area
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.name}
              stroke={series.color}
              strokeWidth={2}
              fill={`url(#fill-${series.key})`}
              activeDot={{ r: 4, stroke: 'var(--chart-surface)', strokeWidth: 2 }}
              dot={false}
              label={(props) => <EndLabel {...props} data={data} dataKey={series.key} formatAmount={formatAmount} />}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function Legend() {
  return (
    <div className="mb-1 flex items-center gap-4">
      {SERIES.map((series) => (
        <div key={series.key} className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <span className="inline-block h-[2px] w-3 rounded-full" style={{ backgroundColor: series.color }} />
          {series.name}
        </div>
      ))}
    </div>
  )
}

function ChartTooltip({ active, payload, label, formatAmount }) {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-xl border border-glass-border bg-glass-strong px-3 py-2 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
      <div className="mb-1 text-[11px] text-text-tertiary">{label}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center gap-2 text-[12px]">
          <span className="inline-block h-[2px] w-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-text-secondary">{entry.name}</span>
          <span className="ml-auto font-semibold text-text-primary tabular-nums">
            {formatAmount(entry.value)}
          </span>
        </div>
      ))}
    </div>
  )
}
