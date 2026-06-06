import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table,
  Card,
  Typography,
  Button,
  Space,
  Tooltip,
  Popconfirm,
  message,
  Modal,
  Tag,
} from 'antd'
import {
  PlusOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  HistoryOutlined,
  MonitorOutlined,
  EditOutlined,
} from '@ant-design/icons'
import { workflowApi } from '@/api'
import { useTranslation } from 'react-i18next'
import { fmtUtc, fmtUtcSec } from '@/utils/time'

const { Title } = Typography

const EXEC_STATUS_COLORS: Record<string, string> = {
  running: 'processing',
  completed: 'success',
  failed: 'error',
  cancelled: 'default',
  cancelling: 'warning',
  waiting_approval: 'warning',
}

const WorkflowList: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [workflows, setWorkflows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  // Execution history modal state
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [historyWorkflow, setHistoryWorkflow] = useState<any>(null)
  const [executions, setExecutions] = useState<any[]>([])
  const [execLoading, setExecLoading] = useState(false)
  const [execTotal, setExecTotal] = useState(0)
  const [execPage, setExecPage] = useState(1)

  useEffect(() => {
    fetchWorkflows()
  }, [])

  const fetchWorkflows = async () => {
    setLoading(true)
    try {
      const res = await workflowApi.list()
      setWorkflows(res.items || [])
    } catch {
      message.error(t('workflow_list_fetch_failure'))
    } finally {
      setLoading(false)
    }
  }

  const handleExecute = async (id: string) => {
    try {
      await workflowApi.execute(id, {})
      message.success(t('workflow_list_execute_success'))
    } catch {
      message.error(t('workflow_list_execute_failure'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await workflowApi.delete(id)
      message.success(t('workflow_list_delete_success'))
      fetchWorkflows()
    } catch {
      message.error(t('workflow_list_delete_failure'))
    }
  }

  const openHistory = async (record: any, page = 1) => {
    setHistoryWorkflow(record)
    setHistoryModalOpen(true)
    setExecLoading(true)
    setExecPage(page)
    try {
      const res = await workflowApi.listExecutions(record.id, page, 10)
      setExecutions(res.items || [])
      setExecTotal(res.total || 0)
    } catch {
      message.error(t('workflow_list_fetch_history_failure'))
      setExecutions([])
    } finally {
      setExecLoading(false)
    }
  }

  const execColumns = [
    {
      title: t('workflow_list_exec_id_column'),
      dataIndex: 'id',
      key: 'id',
      width: 120,
      render: (id: string) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {id?.slice(0, 8)}...
        </span>
      ),
    },
    {
      title: t('workflow_list_status_column'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: string) => (
        <Tag color={EXEC_STATUS_COLORS[s] || 'default'}>{s || '-'}</Tag>
      ),
    },
    {
      title: t('workflow_list_started_at_column'),
      dataIndex: 'started_at',
      key: 'started_at',
      width: 160,
      render: (v: string) => (v ? fmtUtcSec(v) : '-'),
    },
    {
      title: t('workflow_list_completed_at_column'),
      dataIndex: 'completed_at',
      key: 'completed_at',
      width: 160,
      render: (v: string) => (v ? fmtUtcSec(v) : '-'),
    },
    {
      title: t('workflow_list_action_column'),
      key: 'action',
      width: 100,
      render: (_: any, rec: any) => (
        <Button
          size="small"
          icon={<MonitorOutlined />}
          onClick={() => {
            setHistoryModalOpen(false)
            navigate(`/workflows/${historyWorkflow?.id}/executions/${rec.id}`)
          }}
        >
          {t('workflow_list_view_monitor_button')}
        </Button>
      ),
    },
  ]

  const columns = [
    { title: t('workflow_list_name_column'), dataIndex: 'name', key: 'name' },
    {
      title: t('workflow_list_desc_column'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    { title: t('workflow_list_version_column'), dataIndex: 'version', key: 'version', width: 80 },
    {
      title: t('workflow_list_created_at_column'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (v: string) =>
        v ? fmtUtc(v) : '-',
    },
    {
      title: t('workflow_list_action_column'),
      key: 'action',
      width: 260,
      render: (_: any, record: any) => (
        <Space>
          <Tooltip title={t('workflow_list_edit_button')}>
            <Button
              icon={<EditOutlined />}
              size="small"
              onClick={() => navigate(`/workflows/designer/${record.id}`)}
            >
              {t('workflow_list_edit_button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('workflow_list_execute_button')}>
            <Button
              icon={<PlayCircleOutlined />}
              size="small"
              onClick={() => handleExecute(record.id)}
            >
              {t('workflow_list_execute_button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('workflow_list_exec_history_button')}>
            <Button
              icon={<HistoryOutlined />}
              size="small"
              onClick={() => openHistory(record)}
            >
              {t('workflow_list_exec_history_button')}
            </Button>
          </Tooltip>
          <Tooltip title={t('workflow_list_delete_button')}>
            <Popconfirm
              title={t('workflow_list_delete_confirm')}
              okText={t('workflow_list_delete_button')}
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(record.id)}
            >
              <Button danger size="small" icon={<DeleteOutlined />} />
            </Popconfirm>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title level={2}>{t('workflow_list_page_title')}</Title>
      <Card
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/workflows/designer')}
          >
            {t('workflow_list_create_button')}
          </Button>
        }
      >
        <Table
          columns={columns}
          dataSource={workflows}
          rowKey="id"
          loading={loading}
        />
      </Card>

      {/* Execution History Modal */}
      <Modal
        title={t('workflow_list_history_modal_title', { name: historyWorkflow?.name || '' })}
        open={historyModalOpen}
        onCancel={() => setHistoryModalOpen(false)}
        footer={null}
        width={860}
        destroyOnClose
      >
        <Table
          columns={execColumns}
          dataSource={executions}
          rowKey="id"
          loading={execLoading}
          size="small"
          pagination={{
            current: execPage,
            total: execTotal,
            pageSize: 10,
            showTotal: (total) => t('common_total', { total }),
            onChange: (page) => openHistory(historyWorkflow, page),
          }}
        />
      </Modal>
    </div>
  )
}

export default WorkflowList
