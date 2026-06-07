import React, { useEffect, useState } from 'react'
import {
  Table, Tag, Button, Select, Space, Typography, Card,
  Drawer, Descriptions, Modal, Input, Statistic, Row, Col, message, Tooltip,
} from 'antd'
import {
  BulbOutlined,
  CheckOutlined,
  CloseOutlined,
  ReloadOutlined,
  WarningOutlined,
  RobotOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { proposalsApi, agentApi } from '@/api'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'

dayjs.extend(relativeTime)

const { Title, Text, Paragraph } = Typography

const RISK_COLOR: Record<string, string> = { LOW: 'green', MED: 'orange', HIGH: 'red' }
const STATUS_COLOR: Record<string, string> = {
  pending: 'processing', applied: 'success', rejected: 'default', failed: 'error',
}
const TYPE_LABEL: Record<string, string> = {
  prompt_hint: '提示优化',
  memory_injection: '记忆注入',
  tool_patch: '工具补丁',
  code_change: '代码变更',
}

// ── Stats card ────────────────────────────────────────────────────────────────
const StatsCard: React.FC<{ stats: any }> = ({ stats }) => {
  if (!stats) return null
  const { total, by_status = {}, by_risk = {} } = stats
  return (
    <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
      <Col xs={12} sm={6}>
        <Card size="small">
          <Statistic title="总提案" value={total} prefix={<BulbOutlined />} />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size="small">
          <Statistic title="待处理" value={by_status.pending ?? 0} prefix={<ClockCircleOutlined style={{ color: '#1677ff' }} />} />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size="small">
          <Statistic title="已应用" value={by_status.applied ?? 0} prefix={<CheckOutlined style={{ color: '#52c41a' }} />} />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size="small" style={{ borderLeft: by_risk.HIGH > 0 ? '3px solid #ff4d4f' : undefined }}>
          <Statistic
            title="高风险待处理"
            value={by_risk.HIGH ?? 0}
            valueStyle={{ color: by_risk.HIGH > 0 ? '#ff4d4f' : undefined }}
            prefix={<WarningOutlined />}
          />
        </Card>
      </Col>
    </Row>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
const ImprovementProposals: React.FC = () => {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<any>(null)
  const [params, setParams] = useState<any>({ page: 1, size: 20 })
  const [selected, setSelected] = useState<any>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [rejectModal, setRejectModal] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [agents, setAgents] = useState<Record<string, string>>({})

  const fetchData = async (p = params) => {
    setLoading(true)
    try {
      const [listRes, statsRes] = await Promise.all([
        proposalsApi.list(p),
        proposalsApi.stats(7),
      ])
      setData(listRes.items || [])
      setTotal(listRes.total || 0)
      setStats(statsRes)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // prefetch agent names for display
    agentApi.list({ page: 1, size: 100 }).then(res => {
      const m: Record<string, string> = {}
      for (const a of res.items || []) m[a.id] = a.name
      setAgents(m)
    }).catch(() => {})
  }, [])

  const openDetail = (row: any) => { setSelected(row); setDrawerOpen(true) }

  const doApply = async (id: string) => {
    try {
      const res = await proposalsApi.apply(id)
      message.success(`已应用 (${res.status})`)
      fetchData()
      setDrawerOpen(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '应用失败')
    }
  }

  const doReject = async () => {
    if (!rejectModal) return
    try {
      await proposalsApi.reject(rejectModal, rejectReason)
      message.success('已驳回')
      setRejectModal(null)
      setRejectReason('')
      fetchData()
      setDrawerOpen(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '驳回失败')
    }
  }

  const columns = [
    {
      title: '风险',
      dataIndex: 'risk_level',
      width: 72,
      render: (v: string) => <Tag color={RISK_COLOR[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '类型',
      dataIndex: 'proposal_type',
      width: 100,
      render: (v: string) => TYPE_LABEL[v] || v,
    },
    {
      title: 'Agent',
      dataIndex: 'agent_id',
      ellipsis: true,
      render: (v: string) => v ? (agents[v] || <code style={{ fontSize: 10 }}>{v.slice(0, 8)}…</code>) : '—',
    },
    {
      title: '分析摘要',
      dataIndex: 'analysis_summary',
      ellipsis: true,
      render: (v: string) => <Tooltip title={v}><span>{v}</span></Tooltip>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={STATUS_COLOR[v] || 'default'}>{v}</Tag>,
    },
    {
      title: '触发原因',
      dataIndex: 'trigger_reason',
      width: 110,
      render: (v: string) => v ? <Tag>{v}</Tag> : '—',
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 110,
      render: (v: string) => dayjs(v).fromNow(),
    },
    {
      title: '',
      width: 130,
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button size="small" onClick={() => openDetail(row)}>详情</Button>
          {row.status === 'pending' && row.risk_level === 'HIGH' && (
            <>
              <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => doApply(row.id)}>应用</Button>
              <Button size="small" danger icon={<CloseOutlined />} onClick={() => { setRejectModal(row.id); setRejectReason('') }}>驳回</Button>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title level={4} style={{ margin: 0 }}>
          <RobotOutlined /> 自我进化提案
        </Title>
        <Space>
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 110 }}
            options={['pending', 'applied', 'rejected', 'failed'].map(s => ({ label: s, value: s }))}
            onChange={v => { const p = { ...params, status: v, page: 1 }; setParams(p); fetchData(p) }}
          />
          <Select
            placeholder="风险"
            allowClear
            style={{ width: 90 }}
            options={['LOW', 'MED', 'HIGH'].map(r => ({ label: r, value: r }))}
            onChange={v => { const p = { ...params, risk_level: v, page: 1 }; setParams(p); fetchData(p) }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>刷新</Button>
        </Space>
      </div>

      <StatsCard stats={stats} />

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        size="small"
        scroll={{ x: 900 }}
        pagination={{
          total, pageSize: params.size, current: params.page, showSizeChanger: true,
          onChange: (page, size) => { const p = { ...params, page, size }; setParams(p); fetchData(p) },
        }}
        rowClassName={(r) => r.risk_level === 'HIGH' && r.status === 'pending' ? 'ant-table-row-danger' : ''}
      />

      {/* Detail drawer */}
      <Drawer
        title={
          <Space>
            <Tag color={RISK_COLOR[selected?.risk_level] || 'default'}>{selected?.risk_level}</Tag>
            {TYPE_LABEL[selected?.proposal_type] || selected?.proposal_type}
          </Space>
        }
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={520}
        extra={
          selected?.status === 'pending' && selected?.risk_level === 'HIGH' && (
            <Space>
              <Button type="primary" icon={<CheckOutlined />} onClick={() => doApply(selected.id)}>应用</Button>
              <Button danger icon={<CloseOutlined />} onClick={() => { setRejectModal(selected.id); setRejectReason('') }}>驳回</Button>
            </Space>
          )
        }
      >
        {selected && (
          <>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="状态"><Tag color={STATUS_COLOR[selected.status]}>{selected.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="Agent">{agents[selected.agent_id] || selected.agent_id || '—'}</Descriptions.Item>
              <Descriptions.Item label="触发任务">{selected.task_id ? <code style={{ fontSize: 11 }}>{selected.task_id}</code> : '—'}</Descriptions.Item>
              <Descriptions.Item label="触发原因">{selected.trigger_reason || '—'}</Descriptions.Item>
              <Descriptions.Item label="步数 / 重规划">{selected.step_count ?? '—'} 步 / {selected.replan_count ?? 0} 次重规划</Descriptions.Item>
              <Descriptions.Item label="创建时间">{dayjs(selected.created_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
              {selected.applied_at && (
                <Descriptions.Item label="处理时间">{dayjs(selected.applied_at).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
              )}
              {selected.reject_reason && (
                <Descriptions.Item label="驳回原因"><Text type="danger">{selected.reject_reason}</Text></Descriptions.Item>
              )}
            </Descriptions>

            <div style={{ marginBottom: 12 }}>
              <Text strong>分析摘要</Text>
              <Paragraph style={{ marginTop: 6, whiteSpace: 'pre-wrap', background: '#fafafa', padding: '10px 12px', borderRadius: 6 }}>
                {selected.analysis_summary}
              </Paragraph>
            </div>

            {selected.payload && Object.keys(selected.payload).length > 0 && (
              <div>
                <Text strong>Payload</Text>
                <pre style={{ marginTop: 6, fontSize: 11, background: '#f5f5f5', padding: '10px 12px', borderRadius: 6, overflowX: 'auto' }}>
                  {JSON.stringify(selected.payload, null, 2)}
                </pre>
              </div>
            )}
          </>
        )}
      </Drawer>

      {/* Reject reason modal */}
      <Modal
        title="驳回提案"
        open={!!rejectModal}
        onCancel={() => setRejectModal(null)}
        onOk={doReject}
        okText="确认驳回"
        okButtonProps={{ danger: true }}
      >
        <Input.TextArea
          rows={3}
          placeholder="驳回原因（可选）"
          value={rejectReason}
          onChange={e => setRejectReason(e.target.value)}
        />
      </Modal>
    </div>
  )
}

export default ImprovementProposals
