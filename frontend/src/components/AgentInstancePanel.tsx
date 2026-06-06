/**
 * AgentInstancePanel — Wukong Phase 4
 *
 * A slide-in drawer that shows live concurrency state for one agent_type:
 *   - Slot list (busy / idle) with duration and task link
 *   - Queue list with cancel button (admin only)
 *   - Scale control (admin only)
 *
 * Opens when the user clicks the CapacityBar on an AgentTile.
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Drawer,
  InputNumber,
  Popconfirm,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  ClockCircleOutlined,
  CloseOutlined,
  ExpandAltOutlined,
  PauseCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { agentInstanceApi, AgentInstanceSlot, AgentTypeStatus } from '../api'
import { useAuthStore } from '../stores/auth'

const { Text, Title } = Typography

interface Props {
  agentType: string
  agentName: string
  open: boolean
  onClose: () => void
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

const AgentInstancePanel: React.FC<Props> = ({ agentType, agentName, open, onClose }) => {
  const [status, setStatus] = useState<AgentTypeStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [scaleValue, setScaleValue] = useState<number | null>(null)
  const [scaling, setScaling] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const user = useAuthStore(s => s.user)
  const isAdmin = (user?.roles ?? []).includes('admin') || (user?.roles ?? []).includes('superuser')

  const refresh = async () => {
    try {
      const data = await agentInstanceApi.typeStatus(agentType)
      setStatus(data)
      if (scaleValue === null) setScaleValue(data.total_slots)
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!open) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    setLoading(true)
    refresh().finally(() => setLoading(false))
    timerRef.current = setInterval(refresh, 5_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [open, agentType])

  const handleCancelQueued = async (requestId: string) => {
    try {
      await agentInstanceApi.cancelQueued(agentType, requestId)
      message.success('已取消排队请求')
      refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '取消失败')
    }
  }

  const handleScale = async () => {
    if (!scaleValue || scaleValue < 1) return
    setScaling(true)
    try {
      const res = await agentInstanceApi.scale(agentType, scaleValue)
      message.success(`已调整为 ${res.new_count} 个槽位`)
      refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '调整失败')
    } finally {
      setScaling(false)
    }
  }

  const slotColumns = [
    {
      title: '槽位',
      dataIndex: 'slot_id',
      key: 'slot_id',
      render: (id: string) => <Text code style={{ fontSize: 11 }}>{id.split('#')[1] ?? id}</Text>,
      width: 50,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 70,
      render: (s: string) =>
        s === 'busy'
          ? <Badge status="processing" text={<Text style={{ fontSize: 12 }}>运行中</Text>} />
          : <Badge status="default" text={<Text type="secondary" style={{ fontSize: 12 }}>空闲</Text>} />,
    },
    {
      title: '任务',
      dataIndex: 'task_id',
      key: 'task_id',
      ellipsis: true,
      render: (id: string | null) =>
        id
          ? <a href={`/tasks/${id}`} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>{id.slice(0, 8)}…</a>
          : <Text type="secondary" style={{ fontSize: 11 }}>—</Text>,
    },
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      width: 70,
      render: (ch: string | null) =>
        ch ? <Tag style={{ fontSize: 10 }}>{ch}</Tag> : null,
    },
    {
      title: '时长',
      dataIndex: 'duration_sec',
      key: 'duration_sec',
      width: 65,
      render: (sec: number, row: AgentInstanceSlot) =>
        row.status === 'busy'
          ? <Text style={{ fontSize: 11 }}><ClockCircleOutlined style={{ marginRight: 3 }} />{fmtDuration(sec)}</Text>
          : null,
    },
  ]

  const queueColumns = [
    {
      title: 'ID',
      dataIndex: 'request_id',
      key: 'request_id',
      render: (id: string) => <Text code style={{ fontSize: 11 }}>{id.slice(0, 8)}…</Text>,
    },
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      render: (ch: string | null) => ch ? <Tag style={{ fontSize: 10 }}>{ch}</Tag> : '—',
    },
    {
      title: '等待',
      dataIndex: 'waited_sec',
      key: 'waited_sec',
      render: (sec: number) => <Text style={{ fontSize: 11 }}>{fmtDuration(sec)}</Text>,
    },
    ...(isAdmin ? [{
      title: '',
      key: 'action',
      width: 60,
      render: (_: any, row: any) => (
        <Popconfirm
          title="取消此排队请求？"
          onConfirm={() => handleCancelQueued(row.request_id)}
          okText="取消"
          cancelText="保留"
        >
          <Button size="small" type="text" danger icon={<CloseOutlined />} />
        </Popconfirm>
      ),
    }] : []),
  ]

  // Build full slot list (busy instances come from API; idle ones we synthesize)
  const allSlots: AgentInstanceSlot[] = status
    ? [
        ...status.instances,
        ...Array.from({ length: status.idle }, (_, i) => ({
          slot_id: `${agentType}#idle-${i}`,
          status: 'idle' as const,
          session_id: null,
          task_id: null,
          caller_id: null,
          channel: null,
          duration_sec: 0,
        })),
      ]
    : []

  return (
    <Drawer
      title={
        <Space>
          <span>🤖</span>
          <span style={{ fontWeight: 600 }}>{agentName}</span>
          <Tag color="blue" style={{ fontSize: 11 }}>并发状态</Tag>
          {status && (
            <Space size={4}>
              <Badge status="processing" text={<Text style={{ fontSize: 12 }}>{status.busy} 运行</Text>} />
              <Badge status="default" text={<Text type="secondary" style={{ fontSize: 12 }}>{status.idle} 空闲</Text>} />
              {status.queued > 0 && <Badge status="warning" text={<Text style={{ fontSize: 12, color: '#faad14' }}>{status.queued} 排队</Text>} />}
            </Space>
          )}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={560}
      extra={
        <Button
          icon={<ReloadOutlined />}
          size="small"
          onClick={() => { setLoading(true); refresh().finally(() => setLoading(false)) }}
          loading={loading}
        />
      }
    >
      <Spin spinning={loading && !status}>
        {/* Admin: scale control */}
        {isAdmin && status && (
          <div
            style={{
              background: '#f8faff',
              border: '1px solid #e8edf5',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <ExpandAltOutlined style={{ color: '#6366f1', fontSize: 16 }} />
            <Text style={{ fontSize: 13 }}>最大槽位数：</Text>
            <InputNumber
              min={1}
              max={50}
              value={scaleValue ?? status.total_slots}
              onChange={v => setScaleValue(v)}
              size="small"
              style={{ width: 70 }}
            />
            <Button
              type="primary"
              size="small"
              loading={scaling}
              onClick={handleScale}
              disabled={scaleValue === status.total_slots}
            >
              应用
            </Button>
            <Text type="secondary" style={{ fontSize: 11 }}>（仅限空闲槽位缩减，忙碌中的不受影响）</Text>
          </div>
        )}

        {/* Slot table */}
        <Title level={5} style={{ marginBottom: 8, fontSize: 13 }}>
          槽位列表 {status && <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>（共 {status.total_slots} 个）</Text>}
        </Title>
        <Table
          dataSource={allSlots}
          columns={slotColumns}
          rowKey="slot_id"
          size="small"
          pagination={false}
          style={{ marginBottom: 20 }}
          rowClassName={(row) => row.status === 'busy' ? 'wukong-slot-busy' : ''}
        />

        {/* Queue */}
        {status && status.queued > 0 && (
          <>
            <Title level={5} style={{ marginBottom: 8, fontSize: 13, color: '#faad14' }}>
              <PauseCircleOutlined style={{ marginRight: 6 }} />
              排队等待 ({status.queued})
            </Title>
            <Table
              dataSource={status.queue}
              columns={queueColumns}
              rowKey="request_id"
              size="small"
              pagination={false}
            />
          </>
        )}
      </Spin>
    </Drawer>
  )
}

export default AgentInstancePanel
