import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export function TopProductsChart({ data }) {
  const rows = data.map((item) => ({
    name: item.product__name,
    units: item.total_sold,
  }))

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }} barCategoryGap={10}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          axisLine={false}
          tickLine={false}
          width={128}
          tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
        />
        <Tooltip content={<BarTooltip />} cursor={{ fill: 'var(--chart-grid)' }} />
        <Bar dataKey="units" radius={[0, 4, 4, 0]} maxBarSize={18} fill="var(--accent-blue)">
          {rows.map((row) => (
            <Cell key={row.name} fill="var(--accent-blue)" />
          ))}
          <LabelList
            dataKey="units"
            position="right"
            fill="var(--text-primary)"
            fontSize={12}
            fontWeight={600}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function BarTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const { name, units } = payload[0].payload

  return (
    <div className="rounded-xl border border-glass-border bg-glass-strong px-3 py-2 backdrop-blur-2xl [box-shadow:var(--shadow-glass)]">
      <div className="mb-0.5 text-[11px] text-text-tertiary">{name}</div>
      <div className="text-[13px] font-semibold text-text-primary tabular-nums">{units} units sold</div>
    </div>
  )
}
