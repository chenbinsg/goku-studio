/**
 * AgentRuntimeDashboard — Wukong Phase 5
 *
 * A cross-agent concurrency overview page at /agents/runtime.
 * Shows a grid of cards, one per agent type that has been initialised,
 * with a heat-bar and click-through to AgentInstancePanel.
 *
 * Auto-refreshes every 10 s.  Manual refresh button in the header.
 */

import React, { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  AlertOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { agentInstanceApi, AgentTypeStatus } from '@/api'
import AgentInstancePanel from '@/components/AgentInstancePanel'

const { Title, Text } = Typography

const TYPE_EMOJI: Record<string, string> = {
  explorer: '🔍',
  coder: '💻',
  reviewer: '🔎',
  data_agent: '📊',
  process_agent: '⚙️',
  writing_agent: '✍️',
  language_agent: '🌐',
  video_agent: '🎬',
  image_agent: '🎨',
  comm_agent: '💬',
  security_agent: '🛡️',
  ops_monitor_agent: '🖥️',
  security_test_agent: '🛡️',
  security_policy_agent: '🔐',
  vuln_agent: '🚨',
  pm_agent: '📋',
  capacity_agent: '📈',
  arch_agent: '🏗️',
  requirements_agent: '📝',
  test_agent: '🧪',
  event_agent: '🎯',
}

function agentEmoji(type: string) {
  return TYPE_EMOJI[type] || '🤖'
}

function slotColor(status: AgentTypeStatus): string {
  if (status.busy >= status.total_slots) return '#ff4d4f'
  if (status.busy > 0) return '#faad14'
  return '#52c41a'
}

interface PanelTarget {
  agentType: string
  name: string
}

const AgentRuntimeDashboard: React.FC = () => {
  const [statuses, setStatuses] = useState<AgentTypeStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [panelTarget, setPanelTarget] = useState<PanelTarget | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchAll = async () => {
    setLoading(true)
    try {
      const data = await agentInstanceApi.allStatus()
      // Sort: fully-busy first, then partially busy, then idle
      const sorted = [...data].sort((a, b) => {
        const scoreA = a.busy >= a.total_slots ? 2 : a.busy > 0 ? 1 : 0
        const scoreB = b.busy >= b.total_slots ? 2 : b.busy > 0 ? 1 : 0
        if (scoreB !== scoreA) return scoreB - scoreA
        return b.busy - a.busy
      })
      setStatuses(sorted)
      setLastUpdated(new Date())
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    const timer = setInterval(fetchAll, 10_000)
    return () => clearInterval(timer)
  }, [])

  // Aggregate totals for the summary bar
  const totalSlots  = statuses.reduce((s, t) => s + t.total_slots, 0)
  const totalBusy   = statuses.reduce((s, t) => s + t.busy, 0)
  const totalIdle   = statuses.reduce((s, t) => s + t.idle, 0)
  const totalQueued = statuses.reduce((s, t) => s + t.queued, 0)
  const globalPct   = totalSlots > 0 ? Math.round((totalBusy / totalSlots) * 100) : 0

  return (
    <div style={{ padding: 24, minHeight: '100vh', background: '#f6f8fb' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            ⚡ Agent 并发运行状态
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            实时监控所有 Agent 类型的槽位占用与队列情况
          </Text>
        </div>
        <Space>
          {lastUpdated && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              <ClockCircleOutlined style={{ marginRight: 4 }} />
              {lastUpdated.toLocaleTimeString()}
            </Text>
          )}
          <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      {/* Summary banner */}
      <div
        style={{
          background: '#fff',
          borderRadius: 14,
          border: '1px solid #edf1f6',
          padding: '16px 24px',
          marginBottom: 20,
          boxShadow: '0 2px 10px rgba(15,23,42,0.035)',
        }}
      >
        <Row gutter={24} align="middle">
          <Col xs={24} sm={6}>
            <Statistic
              title="总槽位"
              value={totalSlots}
              prefix={<ThunderboltOutlined style={{ color: '#6366f1' }} />}
            />
          </Col>
          <Col xs={24} sm={6}>
            <Statistic
              title="运行中"
              value={totalBusy}
              valueStyle={{ color: totalBusy > 0 ? '#faad14' : '#52c41a' }}
              prefix={<Badge status="processing" />}
            />
          </Col>
          <Col xs={24} sm={6}>
            <Statistic
              title="空闲"
              value={totalIdle}
              valueStyle={{ color: '#52c41a' }}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            />
          </Col>
          <Col xs={24} sm={6}>
            <Statistic
              title="排队等待"
              value={totalQueued}
              valueStyle={{ color: totalQueued > 0 ? '#ff4d4f' : '#52c41a' }}
              prefix={<AlertOutlined style={{ color: totalQueued > 0 ? '#ff4d4f' : '#52c41a' }} />}
            />
          </Col>
          <Col xs={24} style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>全局占用率</Text>
              <Progress
                percent={globalPct}
                strokeColor={globalPct >= 90 ? '#ff4d4f' : globalPct >= 50 ? '#faad14' : '#52c41a'}
                size="small"
                style={{ flex: 1, margin: 0 }}
              />
              <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{globalPct}%</Text>
            </div>
          </Col>
        </Row>
      </div>

      {/* Agent type cards */}
      <Spin spinning={loading && statuses.length === 0}>
        {statuses.length === 0 && !loading ? (
          <Empty
            description="暂无已初始化的 Agent 类型（提交任务后自动出现）"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ padding: '60px 0' }}
          />
        ) : (
          <Row gutter={[14, 14]}>
            {statuses.map(st => {
              const busyPct = Math.round((st.busy / st.total_slots) * 100)
              const color = slotColor(st)
              const isFullyBusy = st.busy >= st.total_slots
              return (
                <Col key={st.agent_type} xs={24} sm={12} md={8} lg={6} xl={4}>
                  <Card
                    hoverable
                    size="small"
                    onClick={() => setPanelTarget({ agentType: st.agent_type, name: st.agent_type })}
                    style={{
                      borderRadius: 12,
                      border: `1px solid ${isFullyBusy ? '#ffccc7' : st.busy > 0 ? '#ffe7ba' : '#edf1f6'}`,
                      background: isFullyBusy ? '#fff2f0' : '#fbfcfe',
                      cursor: 'pointer',
                    }}
                    bodyStyle={{ padding: '12px 14px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 22 }}>{agentEmoji(st.agent_type)}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color: '#1f2937',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {st.agent_type}
                        </div>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>
                          {st.total_slots} 槽位
                        </div>
                      </div>
                      {st.queued > 0 && (
                        <Tooltip title={`${st.queued} 个请求排队等待`}>
                          <Tag color="warning" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                            +{st.queued}
                          </Tag>
                        </Tooltip>
                      )}
                    </div>

                    <Progress
                      percent={busyPct}
                      size="small"
                      strokeColor={color}
                      showInfo={false}
                      style={{ margin: '0 0 6px' }}
                    />

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Space size={6}>
                        {st.busy > 0 && (
                          <Badge status="processing" text={<Text style={{ fontSize: 11 }}>{st.busy} 运行</Text>} />
                        )}
                        {st.idle > 0 && (
                          <Badge status="default" text={<Text type="secondary" style={{ fontSize: 11 }}>{st.idle} 闲</Text>} />
                        )}
                      </Space>
                      <Text style={{ fontSize: 11, color }}>
                        {busyPct}%
                      </Text>
                    </div>
                  </Card>
                </Col>
              )
            })}
          </Row>
        )}
      </Spin>

      {/* Detail drawer */}
      {panelTarget && (
        <AgentInstancePanel
          agentType={panelTarget.agentType}
          agentName={panelTarget.name}
          open={!!panelTarget}
          onClose={() => setPanelTarget(null)}
        />
      )}
    </div>
  )
}

export default AgentRuntimeDashboard
