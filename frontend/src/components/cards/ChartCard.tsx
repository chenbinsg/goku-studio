import React from 'react'
import { Card, Typography, Empty } from 'antd'
import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { ChartCardData } from '../../types/card'

const { Text } = Typography

interface Props {
  // Raw JSON string of the chart spec. Passing the raw string (a stable
  // primitive) instead of a parsed object lets React.memo skip re-renders on
  // unrelated parent updates (e.g. mouse-move / background polling) — otherwise
  // a fresh JSON.parse object every render would re-trigger recharts redraws.
  raw: string
}

const COLORS = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16']

// Abbreviate large numbers so Y-axis ticks don't get clipped (亿/万).
const fmtTick = (v: number): string => {
  if (typeof v !== 'number' || !isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a >= 1e8) return (v / 1e8).toFixed(a % 1e8 === 0 ? 0 : 1) + '亿'
  if (a >= 1e4) return (v / 1e4).toFixed(a % 1e4 === 0 ? 0 : 1) + '万'
  return String(v)
}
// Full number with thousands separators for tooltips.
const fmtFull = (v: any): string =>
  typeof v === 'number' ? v.toLocaleString('en-US') : String(v)

const ChartCard: React.FC<Props> = ({ raw }) => {
  const data = React.useMemo<ChartCardData | null>(() => {
    try { return JSON.parse(raw) as ChartCardData } catch { return null }
  }, [raw])

  if (!data) {
    return <pre><code className="language-chart">{raw}</code></pre>
  }

  const chartType = data.type || 'bar'
  const labels = data.labels || []
  const datasets = data.datasets || []

  if (!labels.length || !datasets.length) {
    return (
      <Card size="small" style={{ margin: '8px 0' }} title={data.title}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No chart data" />
      </Card>
    )
  }

  // Recharts wants an array of row objects: [{ name, <series1>, <series2>, ... }].
  const rows = labels.map((label, i) => {
    const row: Record<string, any> = { name: label }
    datasets.forEach((ds, di) => {
      row[ds.label || `series_${di}`] = ds.data?.[i] ?? 0
    })
    return row
  })

  const renderChart = () => {
    if (chartType === 'pie') {
      const ds = datasets[0]
      const pieRows = labels.map((label, i) => ({ name: label, value: ds.data?.[i] ?? 0 }))
      return (
        <PieChart>
          <Pie data={pieRows} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90}
               label isAnimationActive={false}>
            {pieRows.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={fmtFull} />
          <Legend />
        </PieChart>
      )
    }

    if (chartType === 'line') {
      return (
        <LineChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} width={56} tickFormatter={fmtTick} />
          <Tooltip formatter={fmtFull} />
          <Legend />
          {datasets.map((ds, di) => (
            <Line
              key={di}
              type="monotone"
              dataKey={ds.label || `series_${di}`}
              stroke={COLORS[di % COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      )
    }

    // bar (default)
    return (
      <BarChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} width={56} tickFormatter={fmtTick} />
        <Tooltip formatter={fmtFull} />
        <Legend />
        {datasets.map((ds, di) => (
          <Bar key={di} dataKey={ds.label || `series_${di}`} fill={COLORS[di % COLORS.length]}
               radius={[3, 3, 0, 0]} isAnimationActive={false} />
        ))}
      </BarChart>
    )
  }

  return (
    <Card
      size="small"
      style={{ margin: '8px 0' }}
      title={data.title && <Text strong style={{ fontSize: 13 }}>{data.title}</Text>}
    >
      <ResponsiveContainer width="100%" height={280}>
        {renderChart()}
      </ResponsiveContainer>
    </Card>
  )
}

// Memoize on the raw string so unrelated re-renders (mouse-move, polling) don't
// redraw the chart.
export default React.memo(ChartCard)
