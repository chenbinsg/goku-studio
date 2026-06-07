import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { Card, Badge, Space, Typography, Spin, Tooltip } from 'antd'
import {
  SearchOutlined, CodeOutlined, AuditOutlined, BarChartOutlined,
  ApartmentOutlined, EditOutlined, VideoCameraOutlined, PictureOutlined,
  MessageOutlined, SafetyCertificateOutlined, TranslationOutlined, RobotOutlined,
  LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined
} from '@ant-design/icons'

const { Text } = Typography

const AGENT_ICONS: Record<string, React.ReactNode> = {
  explorer:      <SearchOutlined />,
  coder:         <CodeOutlined />,
  reviewer:      <AuditOutlined />,
  data_agent:    <BarChartOutlined />,
  process_agent: <ApartmentOutlined />,
  writing_agent: <EditOutlined />,
  language_agent:<TranslationOutlined />,
  video_agent:   <VideoCameraOutlined />,
  image_agent:   <PictureOutlined />,
  comm_agent:    <MessageOutlined />,
  security_agent:<SafetyCertificateOutlined />,
}

const AGENT_COLORS: Record<string, string> = {
  explorer:      '#1890ff',
  coder:         '#52c41a',
  reviewer:      '#faad14',
  data_agent:    '#722ed1',
  process_agent: '#13c2c2',
  writing_agent: '#eb2f96',
  language_agent:'#4f8cff',
  video_agent:   '#f5222d',
  image_agent:   '#fa8c16',
  comm_agent:    '#1890ff',
  security_agent:'#52c41a',
}

const AGENT_LABEL_KEYS: Record<string, string> = {
  explorer: 'agent_label_explorer', coder: 'agent_label_coder', reviewer: 'agent_label_reviewer',
  data_agent: 'agent_label_data_agent', process_agent: 'agent_label_process_agent', writing_agent: 'agent_label_writing_agent',
  language_agent: 'agent_label_language_agent',
  video_agent: 'agent_label_video_agent', image_agent: 'agent_label_image_agent', comm_agent: 'agent_label_comm_agent', security_agent: 'agent_label_security_agent',
}

interface Agent {
  id: string
  agent_type: string
  prompt_summary: string
  status: 'running' | 'completed' | 'failed'
  steps_used: number
  result_summary: string | null
  started_at: string
  completed_at: string | null
}

interface Props {
  taskId: string
  sseEvents?: any[]  // SSE events from parent component
}

const AgentTeamPanel: React.FC<Props> = ({ taskId, sseEvents = [] }) => {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!taskId) return
    setLoading(true)
    fetch(`/api/v1/tasks/${taskId}/agents`, {
      headers: { Authorization: `Bearer ${useAuthStore.getState().token || ''}` }
    })
      .then(r => r.json())
      .then(d => setAgents(d.agents || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [taskId])

  // Update agent list from SSE events
  useEffect(() => {
    for (const event of sseEvents) {
      if (event.type === 'agent_spawned') {
        setAgents(prev => {
          if (prev.find(a => a.id === event.agent_id)) return prev
          return [...prev, {
            id: event.agent_id,
            agent_type: event.agent_type,
            prompt_summary: event.prompt_summary || '',
            status: 'running',
            steps_used: 0,
            result_summary: null,
            started_at: new Date().toISOString(),
            completed_at: null,
          }]
        })
      } else if (event.type === 'agent_completed' || event.type === 'agent_failed') {
        setAgents(prev => prev.map(a => a.id === event.agent_id ? {
          ...a,
          status: event.type === 'agent_completed' ? 'completed' : 'failed',
          steps_used: event.steps_used || a.steps_used,
          result_summary: event.result_summary || a.result_summary,
          completed_at: new Date().toISOString(),
        } : a))
      }
    }
  }, [sseEvents])

  if (loading) return <div style={{ textAlign: 'center', padding: 16 }}><Spin /></div>
  if (agents.length === 0) return null

  return (
    <Card
      size="small"
      title={
        <Space>
          <RobotOutlined style={{ color: '#722ed1' }} />
          <Text strong>{t('agent_team_title')}</Text>
          <Badge count={agents.length} style={{ backgroundColor: '#722ed1' }} />
        </Space>
      }
      style={{ marginBottom: 12, borderColor: '#f0f0f0' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {agents.map(agent => {
          const color = AGENT_COLORS[agent.agent_type] || '#1890ff'
          const icon = AGENT_ICONS[agent.agent_type] || <RobotOutlined />
          const labelKey = AGENT_LABEL_KEYS[agent.agent_type]
          const label = labelKey ? t(labelKey) : agent.agent_type
          return (
            <Tooltip
              key={agent.id}
              title={
                <div>
                  <div>{agent.prompt_summary}</div>
                  {agent.result_summary && <div style={{ marginTop: 4, opacity: 0.8 }}>{agent.result_summary}</div>}
                  <div style={{ marginTop: 4 }}>{t('agent_team_step_count_label')}: {agent.steps_used}</div>
                </div>
              }
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 20,
                border: `1px solid ${color}33`,
                background: `${color}0d`,
                cursor: 'default',
              }}>
                <span style={{ color, fontSize: 14 }}>{icon}</span>
                <Text style={{ fontSize: 12, color }}>{label}</Text>
                {agent.status === 'running' && <LoadingOutlined style={{ fontSize: 12, color }} spin />}
                {agent.status === 'completed' && <CheckCircleOutlined style={{ fontSize: 12, color: '#52c41a' }} />}
                {agent.status === 'failed' && <CloseCircleOutlined style={{ fontSize: 12, color: '#ff4d4f' }} />}
              </div>
            </Tooltip>
          )
        })}
      </div>
    </Card>
  )
}

export default AgentTeamPanel
