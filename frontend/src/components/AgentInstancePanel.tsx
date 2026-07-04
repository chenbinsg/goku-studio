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
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
      message.success(t('agent_instance_cancel_queued_success'))
      refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('agent_instance_cancel_failure'))
    }
  }

  const handleScale = async () => {
    if (!scaleValue || scaleValue < 1) return
    setScaling(true)
    try {
      const res = await agentInstanceApi.scale(agentType, scaleValue)
      message.success(t('agent_instance_resize_success', { n: res.new_count }))
      refresh()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('agent_instance_resize_failure'))
    } finally {
      setScaling(false)
    }
  }

  const slotColumns = [
    {
      title: t('agent_instance_col_slot'),
      dataIndex: 'slot_id',
      key: 'slot_id',
      render: (id: string) => <Text code style={{ fontSize: 11 }}>{id.split('#')[1] ?? id}</Text>,
      width: 50,
    },
    {
      title: t('agent_instance_col_status'),
      dataIndex: 'status',
      key: 'status',
      width: 70,
      render: (s: string) =>
        s === 'busy'
          ? <Badge status="processing" text={<Text style={{ fontSize: 12 }}>{t('agent_instance_status_busy')}</Text>} />
          : <Badge status="default" text={<Text type="secondary" style={{ fontSize: 12 }}>{t('agent_instance_status_idle')}</Text>} />,
    },
    {
      title: t('agent_instance_col_task'),
      dataIndex: 'task_id',
      key: 'task_id',
      ellipsis: true,
      render: (id: string | null) =>
        id
          ? <a href={`/tasks/${id}`} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>{id.slice(0, 8)}…</a>
          : <Text type="secondary" style={{ fontSize: 11 }}>—</Text>,
    },
    {
      title: t('agent_instance_col_channel'),
      dataIndex: 'channel',
      key: 'channel',
      width: 70,
      render: (ch: string | null) =>
        ch ? <Tag style={{ fontSize: 10 }}>{ch}</Tag> : null,
    },
    {
      title: t('agent_instance_col_duration'),
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
      title: t('agent_instance_col_channel'),
      dataIndex: 'channel',
      key: 'channel',
      render: (ch: string | null) => ch ? <Tag style={{ fontSize: 10 }}>{ch}</Tag> : '—',
    },
    {
      title: t('agent_instance_col_wait'),
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
          title={t('agent_instance_cancel_confirm')}
          onConfirm={() => handleCancelQueued(row.request_id)}
          okText={t('agent_instance_cancel_ok')}
          cancelText={t('agent_instance_cancel_keep')}
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
          <Tag color="blue" style={{ fontSize: 11 }}>{t('agent_instance_concurrency_tag')}</Tag>
          {status && (
            <Space size={4}>
              <Badge status="processing" text={<Text style={{ fontSize: 12 }}>{t('agent_instance_badge_busy', { n: status.busy })}</Text>} />
              <Badge status="default" text={<Text type="secondary" style={{ fontSize: 12 }}>{t('agent_instance_badge_idle', { n: status.idle })}</Text>} />
              {status.queued > 0 && <Badge status="warning" text={<Text style={{ fontSize: 12, color: '#faad14' }}>{t('agent_instance_badge_queued', { n: status.queued })}</Text>} />}
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
            <Text style={{ fontSize: 13 }}>{t('agent_instance_max_slots_label')}</Text>
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
              {t('agent_instance_apply')}
            </Button>
            <Text type="secondary" style={{ fontSize: 11 }}>{t('agent_instance_resize_hint')}</Text>
          </div>
        )}

        {/* Slot table */}
        <Title level={5} style={{ marginBottom: 8, fontSize: 13 }}>
          {t('agent_instance_slot_list')} {status && <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{t('agent_instance_slot_total', { n: status.total_slots })}</Text>}
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
              {t('agent_instance_queued_section')} ({status.queued})
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
