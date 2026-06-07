import React, { useState } from 'react'
import { Card, Tag, Progress, Button, Popconfirm, Space, Typography } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ClockCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, TaskCardData, TaskStep } from '../../types/card'

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'default',
  planning: 'blue',
  executing: 'processing',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'task_card_status_pending',
  planning: 'task_card_status_planning',
  executing: 'task_card_status_executing',
  completed: 'task_card_status_completed',
  failed: 'task_card_status_failed',
  cancelled: 'task_card_status_cancelled',
}

const PRIORITY_CONFIG: Record<number, { color: string; label: string }> = {
  1: { color: 'red', label: 'P1' },
  2: { color: 'orange', label: 'P2' },
  3: { color: 'blue', label: 'P3' },
  4: { color: 'default', label: 'P4' },
}

const BORDER_COLOR: Record<string, string> = {
  pending: '#d9d9d9',
  planning: '#1890ff',
  executing: '#1890ff',
  completed: '#52c41a',
  failed: '#ff4d4f',
  cancelled: '#d9d9d9',
}

const stepIcon = (status: TaskStep['status']) => {
  switch (status) {
    case 'completed': return <CheckCircleOutlined style={{ color: '#52c41a' }} />
    case 'failed': return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
    case 'running': return <LoadingOutlined style={{ color: '#1890ff' }} />
    case 'skipped': return <MinusCircleOutlined style={{ color: '#d9d9d9' }} />
    default: return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />
  }
}

const TaskCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as TaskCardData
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())

  const toggleStep = (stepNum: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(stepNum)) next.delete(stepNum)
      else next.add(stepNum)
      return next
    })
  }

  const completedCount = data.steps.filter(s => s.status === 'completed').length
  const totalCount = data.steps.length
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const statusColor = STATUS_COLORS[data.status] || STATUS_COLORS.pending
  const statusLabelKey = STATUS_LABEL_KEYS[data.status]
  const priorityConf = PRIORITY_CONFIG[data.priority] || PRIORITY_CONFIG[4]
  const borderColor = BORDER_COLOR[data.status] || '#d9d9d9'

  return (
    <Card
      size="small"
      style={{ margin: '8px 0', borderLeft: `3px solid ${borderColor}` }}
    >
      <div style={{ marginBottom: 8 }}>
        <Space>
          <Typography.Text code style={{ fontFamily: 'monospace' }}>
            {data.task_id.slice(0, 8)}
          </Typography.Text>
          <Tag color={statusColor}>{statusLabelKey ? t(statusLabelKey) : data.status}</Tag>
          <Tag color={priorityConf.color}>{priorityConf.label}</Tag>
        </Space>
      </div>

      <Typography.Paragraph style={{ marginBottom: 8 }}>
        {data.description}
      </Typography.Paragraph>

      <Progress
        percent={percent}
        size="small"
        format={() => `${completedCount}/${totalCount}`}
        style={{ marginBottom: 8 }}
      />

      <div style={{ marginBottom: 8 }}>
        {data.steps.map(step => (
          <div
            key={step.step_number}
            style={{ cursor: 'pointer', padding: '4px 0' }}
            onClick={() => toggleStep(step.step_number)}
          >
            <Space>
              {stepIcon(step.status)}
              <Typography.Text code>{step.action}</Typography.Text>
              {step.duration_ms != null && (
                <Typography.Text type="secondary">
                  {(step.duration_ms / 1000).toFixed(1)}s
                </Typography.Text>
              )}
            </Space>
            {expandedSteps.has(step.step_number) && (
              <div style={{ marginLeft: 24, marginTop: 4 }}>
                {step.reasoning && (
                  <Typography.Text type="secondary" style={{ display: 'block' }}>
                    {step.reasoning}
                  </Typography.Text>
                )}
                {step.parameters && (
                  <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                    {JSON.stringify(step.parameters, null, 2)}
                  </pre>
                )}
                {step.output != null && (
                  <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                    {typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {data.error_message && (
        <Typography.Text type="danger" style={{ display: 'block', marginBottom: 8 }}>
          {data.error_message}
        </Typography.Text>
      )}

      {card.actions && card.actions.length > 0 && (
        <Space>
          {card.actions.map(action =>
            action.confirm ? (
              <Popconfirm
                key={action.key}
                title={action.confirm}
                onConfirm={() => onAction(card.card_id, action.key, action.params)}
              >
                <Button size="small" type={action.type === 'danger' ? 'primary' : action.type} danger={action.type === 'danger'}>
                  {action.label}
                </Button>
              </Popconfirm>
            ) : (
              <Button
                key={action.key}
                size="small"
                type={action.type === 'danger' ? 'primary' : action.type}
                danger={action.type === 'danger'}
                onClick={() => onAction(card.card_id, action.key, action.params)}
              >
                {action.label}
              </Button>
            )
          )}
        </Space>
      )}
    </Card>
  )
}

export default TaskCard
