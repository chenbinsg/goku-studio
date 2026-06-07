import React, { useEffect, useState, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  message,
  Typography,
  Popconfirm,
  Tooltip,
  Badge,
  Row,
  Col,
  Tabs,
  Alert,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  SyncOutlined,
  LinkOutlined,
  FolderOpenOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { externalMemoryApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography

type Source = {
  id: string
  provider: 'notion' | 'obsidian'
  name: string
  status: 'active' | 'syncing' | 'error' | 'disconnected'
  last_synced_at: string | null
  doc_count: number
  error_message: string | null
  created_at: string
  workspace_name?: string
  vault_path?: string
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  active: { color: 'success', icon: <CheckCircleOutlined /> },
  syncing: { color: 'processing', icon: <LoadingOutlined spin /> },
  error: { color: 'error', icon: <ExclamationCircleOutlined /> },
  disconnected: { color: 'default', icon: <ClockCircleOutlined /> },
}

export default function ExternalSources() {
  const { t } = useTranslation()
  const [sources, setSources] = useState<Source[]>([])
  const [loading, setLoading] = useState(false)
  const [addModal, setAddModal] = useState(false)
  const [obsidianForm] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [notionConnecting, setNotionConnecting] = useState(false)
  const [activeTab, setActiveTab] = useState('notion')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await externalMemoryApi.list()
      setSources(res)
    } catch {
      message.error(t('ext_sources_load_error'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])

  // Poll while any source is syncing
  useEffect(() => {
    const syncing = sources.some(s => s.status === 'syncing')
    if (!syncing) return
    const timer = setTimeout(load, 3000)
    return () => clearTimeout(timer)
  }, [sources, load])

  const handleSync = async (id: string) => {
    try {
      await externalMemoryApi.sync(id)
      message.success(t('ext_sources_sync_started'))
      setSources(prev => prev.map(s => s.id === id ? { ...s, status: 'syncing' } : s))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('ext_sources_sync_error'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await externalMemoryApi.delete(id)
      message.success(t('ext_sources_deleted'))
      setSources(prev => prev.filter(s => s.id !== id))
    } catch {
      message.error(t('ext_sources_delete_error'))
    }
  }

  const handleObsidianSubmit = async () => {
    try {
      const values = await obsidianForm.validateFields()
      setSubmitting(true)
      const res = await externalMemoryApi.createObsidian(values)
      message.success(t('ext_sources_added'))
      setSources(prev => [res, ...prev])
      setAddModal(false)
      obsidianForm.resetFields()
    } catch (e: any) {
      if (e?.errorFields) return   // validation error, don't close
      message.error(e?.response?.data?.detail || t('ext_sources_add_error'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleNotionConnect = async () => {
    setNotionConnecting(true)
    try {
      const redirectUri = `${window.location.origin}/knowledge/notion-callback`
      const res = await externalMemoryApi.getNotionAuthUrl(redirectUri)
      const { authorization_url, state } = res
      sessionStorage.setItem('notion_oauth_state', state)
      sessionStorage.setItem('notion_redirect_uri', redirectUri)

      const popup = window.open(authorization_url, 'notion_oauth',
        'width=600,height=700,scrollbars=yes')

      // Listen for the callback page posting back
      const onMessage = (evt: MessageEvent) => {
        if (evt.origin !== window.location.origin) return
        if (evt.data?.type !== 'notion_oauth_success') return
        window.removeEventListener('message', onMessage)
        popup?.close()
        load()
        message.success(t('ext_sources_notion_connected'))
        setAddModal(false)
        setNotionConnecting(false)
      }
      window.addEventListener('message', onMessage)

      // Fallback: stop spinner if popup is closed without completing
      const pollClosed = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollClosed)
          window.removeEventListener('message', onMessage)
          setNotionConnecting(false)
        }
      }, 1000)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('ext_sources_notion_error'))
      setNotionConnecting(false)
    }
  }

  const columns: ColumnsType<Source> = [
    {
      title: t('ext_sources_col_name'),
      dataIndex: 'name',
      render: (name, row) => (
        <Space>
          {row.provider === 'notion'
            ? <LinkOutlined style={{ color: '#000' }} />
            : <FolderOpenOutlined style={{ color: '#8b5cf6' }} />}
          <Text strong>{name}</Text>
        </Space>
      ),
    },
    {
      title: t('ext_sources_col_provider'),
      dataIndex: 'provider',
      render: (p) => (
        <Tag color={p === 'notion' ? 'black' : 'purple'}>
          {p === 'notion' ? 'Notion' : 'Obsidian'}
        </Tag>
      ),
      width: 110,
    },
    {
      title: t('ext_sources_col_status'),
      dataIndex: 'status',
      render: (status, row) => {
        const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.disconnected
        return (
          <Tooltip title={row.error_message || undefined}>
            <Badge status={cfg.color as any} text={t(`ext_sources_status_${status}`)} />
          </Tooltip>
        )
      },
      width: 120,
    },
    {
      title: t('ext_sources_col_docs'),
      dataIndex: 'doc_count',
      width: 90,
      align: 'right',
      render: (n) => <Text>{n.toLocaleString()}</Text>,
    },
    {
      title: t('ext_sources_col_last_sync'),
      dataIndex: 'last_synced_at',
      render: (v) => v ? dayjs(v).fromNow() : t('ext_sources_never'),
      width: 150,
    },
    {
      title: t('ext_sources_col_actions'),
      key: 'actions',
      width: 130,
      render: (_, row) => (
        <Space>
          <Tooltip title={t('ext_sources_sync_now')}>
            <Button
              icon={<SyncOutlined spin={row.status === 'syncing'} />}
              size="small"
              disabled={row.status === 'syncing'}
              onClick={() => handleSync(row.id)}
            />
          </Tooltip>
          <Popconfirm
            title={t('ext_sources_delete_confirm')}
            onConfirm={() => handleDelete(row.id)}
            okType="danger"
          >
            <Button icon={<DeleteOutlined />} size="small" danger />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Title level={4} style={{ margin: 0 }}>{t('ext_sources_title')}</Title>
          <Text type="secondary">{t('ext_sources_subtitle')}</Text>
        </Col>
        <Col>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModal(true)}>
            {t('ext_sources_add_button')}
          </Button>
        </Col>
      </Row>

      <Card>
        <Table<Source>
          rowKey="id"
          columns={columns}
          dataSource={sources}
          loading={loading}
          pagination={false}
          locale={{ emptyText: t('ext_sources_empty') }}
        />
      </Card>

      <Modal
        title={t('ext_sources_add_modal_title')}
        open={addModal}
        onCancel={() => { setAddModal(false); obsidianForm.resetFields() }}
        footer={null}
        width={520}
      >
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          {
            key: 'notion',
            label: 'Notion',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Alert
                  message={t('ext_sources_notion_info')}
                  type="info"
                  showIcon
                />
                <Button
                  type="primary"
                  icon={<LinkOutlined />}
                  onClick={handleNotionConnect}
                  loading={notionConnecting}
                  block
                  size="large"
                >
                  {t('ext_sources_notion_connect_button')}
                </Button>
              </Space>
            ),
          },
          {
            key: 'obsidian',
            label: 'Obsidian',
            children: (
              <Form form={obsidianForm} layout="vertical">
                <Form.Item
                  name="vault_path"
                  label={t('ext_sources_obsidian_path_label')}
                  rules={[{ required: true, message: t('ext_sources_obsidian_path_required') }]}
                  extra={t('ext_sources_obsidian_path_hint')}
                >
                  <Input
                    prefix={<FolderOpenOutlined />}
                    placeholder="/Users/you/Documents/MyVault"
                  />
                </Form.Item>
                <Form.Item
                  name="name"
                  label={t('ext_sources_obsidian_name_label')}
                >
                  <Input placeholder={t('ext_sources_obsidian_name_placeholder')} />
                </Form.Item>
                <Button
                  type="primary"
                  block
                  onClick={handleObsidianSubmit}
                  loading={submitting}
                >
                  {t('ext_sources_add_button')}
                </Button>
              </Form>
            ),
          },
        ]} />
      </Modal>
    </div>
  )
}
