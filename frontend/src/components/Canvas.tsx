/**
 * Canvas — renders dynamic visual components pushed by the agent.
 * Supports: chart, table, form, markdown, image.
 */
import React from 'react'
import { Table, Form, Input, InputNumber, Select, Button, Collapse, Tag } from 'antd'
import ReactMarkdown from 'react-markdown'

export interface CanvasComponent {
  id: string
  component_type: 'chart' | 'table' | 'form' | 'markdown' | 'image'
  title: string
  data: any
  position: 'main' | 'sidebar' | 'modal'
}

interface CanvasProps {
  components: CanvasComponent[]
  onFormSubmit?: (componentId: string, values: any) => void
}

const ChartRenderer: React.FC<{ data: any }> = ({ data }) => {
  // Simple SVG bar chart (no external dependency)
  const chartType = data?.type || 'bar'
  const labels: string[] = data?.labels || []
  const datasets: any[] = data?.datasets || []

  if (!labels.length || !datasets.length) {
    return <div style={{ color: '#999' }}>No chart data</div>
  }

  const values: number[] = datasets[0]?.data || []
  const maxVal = Math.max(...values, 1)
  const barWidth = Math.min(60, Math.floor(400 / labels.length))
  const height = 200
  const colors = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2']

  if (chartType === 'pie') {
    // Simple pie chart
    const total = values.reduce((a, b) => a + b, 0)
    let cumulativeAngle = 0
    return (
      <div>
        <svg width={220} height={220} viewBox="-110 -110 220 220">
          {values.map((v, i) => {
            const angle = (v / total) * Math.PI * 2
            const startAngle = cumulativeAngle
            cumulativeAngle += angle
            const x1 = Math.cos(startAngle) * 100
            const y1 = Math.sin(startAngle) * 100
            const x2 = Math.cos(startAngle + angle) * 100
            const y2 = Math.sin(startAngle + angle) * 100
            const largeArc = angle > Math.PI ? 1 : 0
            return (
              <path
                key={i}
                d={`M0,0 L${x1},${y1} A100,100 0 ${largeArc},1 ${x2},${y2} Z`}
                fill={colors[i % colors.length]}
                stroke="#fff"
                strokeWidth={2}
              />
            )
          })}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {labels.map((l, i) => (
            <Tag key={i} color={colors[i % colors.length]}>{l}: {values[i]}</Tag>
          ))}
        </div>
      </div>
    )
  }

  // Bar / line chart
  return (
    <svg width={labels.length * (barWidth + 10) + 40} height={height + 40} style={{ overflow: 'visible' }}>
      {values.map((v, i) => {
        const barHeight = (v / maxVal) * height
        const x = i * (barWidth + 10) + 20
        const y = height - barHeight + 10
        return (
          <g key={i}>
            {chartType === 'line' && i > 0 ? (
              <line
                x1={(i - 1) * (barWidth + 10) + 20 + barWidth / 2}
                y1={height - ((values[i - 1] / maxVal) * height) + 10}
                x2={x + barWidth / 2}
                y2={y}
                stroke={colors[0]}
                strokeWidth={2}
              />
            ) : null}
            <rect x={x} y={y} width={barWidth} height={barHeight}
                  fill={colors[i % colors.length]} rx={3} />
            <text x={x + barWidth / 2} y={height + 25} textAnchor="middle" fontSize={11}>{labels[i]}</text>
            <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" fontSize={10}>{v}</text>
          </g>
        )
      })}
    </svg>
  )
}

const TableRenderer: React.FC<{ data: any }> = ({ data }) => {
  const columns = (data?.columns || []).map((c: any) => ({
    title: c.title || c.dataIndex,
    dataIndex: c.dataIndex,
    key: c.dataIndex,
  }))
  const rows = (data?.rows || []).map((r: any, i: number) => ({ key: i, ...r }))
  return <Table columns={columns} dataSource={rows} size="small" pagination={false} scroll={{ x: true }} />
}

const FormRenderer: React.FC<{ data: any; onSubmit?: (values: any) => void }> = ({ data, onSubmit }) => {
  const [form] = Form.useForm()
  const fields: any[] = data?.fields || []

  return (
    <Form form={form} layout="vertical" onFinish={onSubmit} size="small">
      {fields.map((f: any) => (
        <Form.Item key={f.name} name={f.name} label={f.label || f.name}>
          {f.type === 'number' ? (
            <InputNumber style={{ width: '100%' }} />
          ) : f.type === 'select' ? (
            <Select options={(f.options || []).map((o: string) => ({ label: o, value: o }))} />
          ) : (
            <Input />
          )}
        </Form.Item>
      ))}
      <Button type="primary" htmlType="submit" size="small">Submit</Button>
    </Form>
  )
}

const Canvas: React.FC<CanvasProps> = ({ components, onFormSubmit }) => {
  if (!components.length) return null

  return (
    <Collapse
      defaultActiveKey={components.map((c) => c.id)}
      style={{ marginBottom: 16 }}
      size="small"
    >
      {components.map((comp) => (
        <Collapse.Panel key={comp.id} header={<span><Tag color="blue">{comp.component_type}</Tag> {comp.title}</span>}>
          {comp.component_type === 'chart' && <ChartRenderer data={comp.data} />}
          {comp.component_type === 'table' && <TableRenderer data={comp.data} />}
          {comp.component_type === 'form' && (
            <FormRenderer data={comp.data} onSubmit={(v) => onFormSubmit?.(comp.id, v)} />
          )}
          {comp.component_type === 'markdown' && (
            <ReactMarkdown>{comp.data?.content || ''}</ReactMarkdown>
          )}
          {comp.component_type === 'image' && (
            <img src={comp.data?.url} alt={comp.data?.alt || comp.title}
                 style={{ maxWidth: '100%', borderRadius: 4 }} />
          )}
        </Collapse.Panel>
      ))}
    </Collapse>
  )
}

export default Canvas
