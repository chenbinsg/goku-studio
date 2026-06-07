import { useState, useCallback } from 'react'
import {
  Table, Tag, Button, Select, Input, Space, Switch, Typography, Tooltip,
  Badge, Card, Descriptions,
} from 'antd'
import { SearchOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { statefulPoliciesApi } from '@/api'

const { Title, Text } = Typography
const { Option } = Select

const STOP_REASON_COLORS: Record<string, string> = {
  completed:                    'green',
  no_available_actions:         'orange',
  no_decision:                  'orange',
  action_failed:                'red',
  state_mismatch:               'red',
  guard_violation:              'red',
  non_idempotent_retry_blocked: 'volcano',
  approval_required:            'blue',
  confirmation_required:        'blue',
  human_only:                   'purple',
  max_steps_reached:            'gold',
}

const POLICY_MODE_COLORS: Record<string, string> = {
  auto:                 'default',
  confirm_required:     'blue',
  approval_required:    'orange',
  human_only:           'red',
}

export default function StatefulTransitionAudit() {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{ total: number; items: any[] }>({ total: 0, items: [] })
  const [filters, setFilters] = useState<{
    entity_kind?: string
    entity_id?: string
    task_id?: string
    needs_human_review?: boolean
    stop_reason?: string
    limit: number
    offset: number
  }>({ limit: 50, offset: 0 })
  const [expanded, setExpanded] = useState<string | null>(null)

  const fetch = useCallback(async (f = filters) => {
    setLoading(true)
    try {
      const params: any = { limit: f.limit, offset: f.offset }
      if (f.entity_kind)         params.entity_kind = f.entity_kind
      if (f.entity_id)           params.entity_id   = f.entity_id
      if (f.task_id)             params.task_id      = f.task_id
      if (f.needs_human_review != null) params.needs_human_review = f.needs_human_review
      if (f.stop_reason)         params.stop_reason  = f.stop_reason
      const res = await statefulPoliciesApi.listTransitions(params)
      setData({ total: res.total, items: res.items })
    } finally {
      setLoading(false)
    }
  }, [filters])

  const applyFilter = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch, offset: 0 }
    setFilters(next)
    fetch(next)
  }

  const columns = [
    {
      title: 'Time',
      dataIndex: 'created_at',
      width: 170,
      render: (v: string) => v ? new Date(v).toLocaleString() : '—',
    },
    {
      title: 'Kind',
      dataIndex: 'entity_kind',
      width: 120,
      render: (v: string) => <Tag>{v}</Tag>,
    },
    {
      title: 'Entity ID',
      dataIndex: 'entity_id',
      width: 160,
      ellipsis: true,
      render: (v: string) => <Text code copyable style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: 'Transition',
      width: 260,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Tag color="processing">{row.previous_state}</Tag>
          <Text type="secondary">→</Text>
          <Tag color={row.action_name === '__loop_stop__' ? 'default' : 'success'}>
            {row.resulting_state}
          </Tag>
        </Space>
      ),
    },
    {
      title: 'Action',
      dataIndex: 'action_name',
      width: 160,
      render: (v: string) =>
        v === '__loop_stop__'
          ? <Tag color="default">loop_stop</Tag>
          : <Tag color="blue">{v}</Tag>,
    },
    {
      title: 'Policy',
      dataIndex: 'policy_mode',
      width: 130,
      render: (v: string) => v ? <Tag color={POLICY_MODE_COLORS[v] ?? 'default'}>{v}</Tag> : '—',
    },
    {
      title: 'Stop Reason',
      dataIndex: 'stop_reason',
      width: 200,
      render: (v: string) => v
        ? <Tag color={STOP_REASON_COLORS[v] ?? 'default'}>{v}</Tag>
        : null,
    },
    {
      title: 'Review',
      dataIndex: 'needs_human_review',
      width: 80,
      render: (v: boolean) => v
        ? <Tooltip title="Needs human review"><WarningOutlined style={{ color: '#ff4d4f', fontSize: 16 }} /></Tooltip>
        : null,
    },
    {
      title: 'Match',
      dataIndex: 'matched_expected',
      width: 70,
      render: (v: boolean | null) =>
        v == null ? null
        : v ? <Badge status="success" text="✓" />
            : <Badge status="error" text="✗" />,
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Title level={4}>Stateful Transition Audit</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        Cross-task history of all stateful runtime state transitions. Filter by entity, task, or review flag.
      </Text>

      {/* Filter bar */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="Entity kind"
            allowClear
            style={{ width: 160 }}
            onChange={v => applyFilter({ entity_kind: v })}
          >
            {['approval', 'ticket', 'reimbursement'].map(k => (
              <Option key={k} value={k}>{k}</Option>
            ))}
          </Select>

          <Input
            placeholder="Entity ID"
            allowClear
            style={{ width: 200 }}
            onPressEnter={e => applyFilter({ entity_id: (e.target as HTMLInputElement).value || undefined })}
            suffix={<SearchOutlined />}
          />

          <Input
            placeholder="Task ID"
            allowClear
            style={{ width: 200 }}
            onPressEnter={e => applyFilter({ task_id: (e.target as HTMLInputElement).value || undefined })}
            suffix={<SearchOutlined />}
          />

          <Select
            placeholder="Stop reason"
            allowClear
            style={{ width: 200 }}
            onChange={v => applyFilter({ stop_reason: v })}
          >
            {Object.keys(STOP_REASON_COLORS).map(r => (
              <Option key={r} value={r}><Tag color={STOP_REASON_COLORS[r]}>{r}</Tag></Option>
            ))}
          </Select>

          <Space>
            <Text>Needs review:</Text>
            <Switch
              checked={filters.needs_human_review === true}
              onChange={checked => applyFilter({ needs_human_review: checked ? true : undefined })}
            />
          </Space>

          <Button icon={<ReloadOutlined />} onClick={() => fetch()}>
            Search
          </Button>
        </Space>
      </Card>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data.items}
        loading={loading}
        size="small"
        scroll={{ x: 1200 }}
        pagination={{
          total: data.total,
          pageSize: filters.limit,
          current: Math.floor(filters.offset / filters.limit) + 1,
          onChange: (page, pageSize) => {
            const next = { ...filters, offset: (page - 1) * pageSize, limit: pageSize }
            setFilters(next)
            fetch(next)
          },
          showTotal: (total) => `${total} transitions`,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100'],
        }}
        expandable={{
          expandedRowKeys: expanded ? [expanded] : [],
          onExpand: (_, row) => setExpanded(expanded === row.id ? null : row.id),
          expandedRowRender: (row) => (
            <Descriptions size="small" column={2} bordered style={{ background: '#fff' }}>
              <Descriptions.Item label="Entity ID" span={2}>
                <Text code copyable>{row.entity_id}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Task ID" span={2}>
                {row.task_id ? <Text code copyable>{row.task_id}</Text> : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Expected next state">
                {row.expected_next_state ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Match">
                {row.matched_expected == null ? '—' : row.matched_expected ? '✓ matched' : '✗ mismatch'}
              </Descriptions.Item>
              <Descriptions.Item label="Result code">{row.result_code ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Policy mode">
                <Tag color={POLICY_MODE_COLORS[row.policy_mode] ?? 'default'}>{row.policy_mode}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Message" span={2}>{row.message ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Reason" span={2}>{row.reason ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Actor">{row.actor_user_id ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="Tenant">{row.actor_tenant_id ?? '—'}</Descriptions.Item>
            </Descriptions>
          ),
        }}
      />
    </div>
  )
}
