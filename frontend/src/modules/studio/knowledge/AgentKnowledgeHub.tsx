import React, { useEffect, useState, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Typography,
  Popconfirm,
  Select,
  message,
  Tooltip,
  Empty,
  Statistic,
  Row,
  Col,
  Alert,
  Modal,
  Form,
  Input,
  Collapse,
} from 'antd'
import {
  DeleteOutlined,
  ReloadOutlined,
  RobotOutlined,
  BulbOutlined,
  PlusOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { agentKnowledgeApi } from '@/api'
import { useTranslation } from 'react-i18next'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

const DOMAIN_COLORS: Record<string, string> = {
  email: 'blue', calendar: 'cyan', code: 'green', data: 'orange',
  ir: 'purple', search: 'geekblue', finance: 'gold', security: 'red',
}

const AgentKnowledgeHub: React.FC = () => {
  const { t } = useTranslation()

  const AGENT_TYPE_OPTIONS = [
    { label: t('knowledge_hub_filter_placeholder'), value: '' },
    { label: t('knowledge_hub_agent_manual'),   value: 'manual' },
    { label: t('knowledge_hub_agent_explorer'), value: 'explorer' },
    { label: t('knowledge_hub_agent_coder'),    value: 'coder' },
    { label: t('knowledge_hub_agent_reviewer'), value: 'reviewer' },
    { label: t('knowledge_hub_agent_data'),     value: 'data_agent' },
    { label: t('knowledge_hub_agent_writing'),  value: 'writing_agent' },
    { label: t('knowledge_hub_agent_process'),  value: 'process_agent' },
    { label: t('knowledge_hub_agent_comm'),     value: 'comm_agent' },
    { label: t('knowledge_hub_agent_security'), value: 'security_agent' },
    { label: t('knowledge_hub_agent_language'), value: 'language_agent' },
  ]

  const DOMAIN_OPTIONS = [
    { label: t('knowledge_hub_modal_domain_none'), value: '' },
    { label: t('knowledge_hub_domain_email'),    value: 'email' },
    { label: t('knowledge_hub_domain_calendar'), value: 'calendar' },
    { label: t('knowledge_hub_domain_code'),     value: 'code' },
    { label: t('knowledge_hub_domain_data'),     value: 'data' },
    { label: t('knowledge_hub_domain_ir'),       value: 'ir' },
    { label: t('knowledge_hub_domain_search'),   value: 'search' },
    { label: t('knowledge_hub_domain_finance'),  value: 'finance' },
    { label: t('knowledge_hub_domain_security'), value: 'security' },
  ]

  const MODAL_AGENT_OPTIONS = AGENT_TYPE_OPTIONS.filter(o => o.value !== '')

  const [items, setItems]               = useState<any[]>([])
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [agentTypeFilter, setAgentTypeFilter] = useState<string>('')
  const [modalOpen, setModalOpen]       = useState(false)
  const [modalLoading, setModalLoading] = useState(false)
  const [form] = Form.useForm()

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, any> = { limit: 200 }
      if (agentTypeFilter) params.agent_type = agentTypeFilter
      const res = await agentKnowledgeApi.list(params)
      setItems(res.items || [])
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || 'Unknown error'
      setError(`${t('knowledge_hub_load_failed')}: ${detail}`)
      message.error(t('knowledge_hub_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [agentTypeFilter, t])

  useEffect(() => { fetchItems() }, [fetchItems])

  const handleDelete = async (id: string) => {
    try {
      await agentKnowledgeApi.delete(id)
      message.success(t('knowledge_hub_delete_success'))
      setItems(prev => prev.filter(i => i.id !== id))
    } catch {
      message.error(t('knowledge_hub_delete_failed'))
    }
  }

  const handleCreate = async (values: { content: string; agent_type: string; domain: string }) => {
    setModalLoading(true)
    try {
      const item = await agentKnowledgeApi.create({
        content:    values.content.trim(),
        agent_type: values.agent_type || 'manual',
        domain:     values.domain || '',
      })
      message.success(t('knowledge_hub_modal_create_success'))
      setItems(prev => [item, ...prev])
      setModalOpen(false)
      form.resetFields()
    } catch {
      message.error(t('knowledge_hub_modal_create_failed'))
    } finally {
      setModalLoading(false)
    }
  }

  // Aggregate stats
  const byAgent: Record<string, number> = {}
  const byDomain: Record<string, number> = {}
  items.forEach(item => {
    const at = item.agent_type || 'unknown'
    byAgent[at] = (byAgent[at] || 0) + 1
    const d = item.domain
    if (d) byDomain[d] = (byDomain[d] || 0) + 1
  })

  const columns = [
    {
      title: t('knowledge_hub_col_insight'),
      dataIndex: 'content',
      key: 'content',
      render: (text: string) => <Text style={{ fontSize: 13 }}>{text}</Text>,
    },
    {
      title: t('knowledge_hub_col_agent'),
      dataIndex: 'agent_type',
      key: 'agent_type',
      width: 150,
      render: (v: string) => (
        <Tag icon={<RobotOutlined />} color={v === 'manual' ? 'default' : 'processing'}>
          {AGENT_TYPE_OPTIONS.find(o => o.value === v)?.label || v || 'unknown'}
        </Tag>
      ),
    },
    {
      title: t('knowledge_hub_col_domain'),
      dataIndex: 'domain',
      key: 'domain',
      width: 120,
      render: (v: string) =>
        v ? (
          <Tag color={DOMAIN_COLORS[v] || 'default'}>
            {DOMAIN_OPTIONS.find(o => o.value === v)?.label || v}
          </Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('knowledge_hub_col_discovered'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (v: string) => (
        <Tooltip title={dayjs(v).format('YYYY-MM-DD HH:mm:ss')}>
          <Text type="secondary">{dayjs(v).fromNow()}</Text>
        </Tooltip>
      ),
    },
    {
      title: '',
      key: 'action',
      width: 56,
      render: (_: any, record: any) => (
        <Popconfirm
          title={t('knowledge_hub_delete_confirm')}
          onConfirm={() => handleDelete(record.id)}
          okText={t('knowledge_hub_delete_success')}
          okButtonProps={{ danger: true }}
        >
          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <Title level={2} style={{ margin: 0 }}>
            <BulbOutlined style={{ marginRight: 8, color: '#faad14' }} />
            {t('knowledge_hub_title')}
          </Title>
          <Text type="secondary" style={{ display: 'block', marginTop: 4, maxWidth: 680 }}>
            {t('knowledge_hub_subtitle')}
          </Text>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalOpen(true)}
          size="large"
        >
          {t('knowledge_hub_add_button')}
        </Button>
      </div>

      {/* ── How it works ── */}
      <Collapse
        size="small"
        style={{ marginBottom: 20, background: '#fffbe6', border: '1px solid #ffe58f' }}
        items={[{
          key: '1',
          label: (
            <span style={{ color: '#ad6800', fontWeight: 500 }}>
              <InfoCircleOutlined style={{ marginRight: 6 }} />
              {t('knowledge_hub_how_title')}
            </span>
          ),
          children: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <ThunderboltOutlined style={{ color: '#1677ff', marginTop: 3, flexShrink: 0 }} />
                <Text style={{ fontSize: 13 }}>{t('knowledge_hub_how_auto')}</Text>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <PlusOutlined style={{ color: '#52c41a', marginTop: 3, flexShrink: 0 }} />
                <Text style={{ fontSize: 13 }}>{t('knowledge_hub_how_manual')}</Text>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <SearchOutlined style={{ color: '#722ed1', marginTop: 3, flexShrink: 0 }} />
                <Text style={{ fontSize: 13 }}>{t('knowledge_hub_how_retrieval')}</Text>
              </div>
            </Space>
          ),
        }]}
      />

      {/* ── Stats row ── */}
      <Row gutter={12} style={{ marginBottom: 20, flexWrap: 'wrap' }}>
        <Col style={{ marginBottom: 8 }}>
          <Card size="small" style={{ minWidth: 110, textAlign: 'center', background: '#f0f5ff', border: '1px solid #adc6ff' }}>
            <Statistic title={t('knowledge_hub_total')} value={items.length} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        {Object.entries(byDomain).map(([domain, count]) => (
          <Col key={domain} style={{ marginBottom: 8 }}>
            <Card size="small" style={{ minWidth: 90, textAlign: 'center' }}>
              <Statistic
                title={<Tag color={DOMAIN_COLORS[domain] || 'default'} style={{ margin: 0 }}>{DOMAIN_OPTIONS.find(o => o.value === domain)?.label || domain}</Tag>}
                value={count}
                valueStyle={{ fontSize: 18 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* ── Table ── */}
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Select
            style={{ width: 200 }}
            value={agentTypeFilter}
            onChange={setAgentTypeFilter}
            options={AGENT_TYPE_OPTIONS}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchItems} loading={loading}>
            {t('knowledge_hub_refresh_button')}
          </Button>
        </Space>

        {error && (
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 16 }}
            action={<Button size="small" onClick={fetchItems}>Retry</Button>}
          />
        )}

        {items.length === 0 && !loading && !error ? (
          <Empty
            image={<BulbOutlined style={{ fontSize: 48, color: '#d9d9d9' }} />}
            imageStyle={{ height: 60 }}
            description={
              <Space direction="vertical" size={4} style={{ textAlign: 'center' }}>
                <Text strong>{t('knowledge_hub_empty_title')}</Text>
                <Text type="secondary">{t('knowledge_hub_empty_desc')}</Text>
              </Space>
            }
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              {t('knowledge_hub_add_button')}
            </Button>
          </Empty>
        ) : (!error && (
          <Table
            columns={columns}
            dataSource={items}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            size="middle"
          />
        ))}
      </Card>

      {/* ── Add Knowledge Modal ── */}
      <Modal
        title={
          <span>
            <BulbOutlined style={{ marginRight: 8, color: '#faad14' }} />
            {t('knowledge_hub_modal_title')}
          </span>
        }
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        onOk={() => form.submit()}
        okText={t('knowledge_hub_add_button')}
        confirmLoading={modalLoading}
        width={540}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleCreate}
          initialValues={{ agent_type: 'manual', domain: '' }}
          style={{ marginTop: 12 }}
        >
          <Form.Item
            label={t('knowledge_hub_modal_content_label')}
            name="content"
            rules={[{ required: true, message: t('knowledge_hub_modal_content_required') }]}
            extra={t('knowledge_hub_modal_content_hint')}
          >
            <Input.TextArea
              rows={4}
              showCount
              maxLength={500}
              placeholder={t('knowledge_hub_modal_content_placeholder')}
            />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label={t('knowledge_hub_modal_agent_label')} name="agent_type">
                <Select options={MODAL_AGENT_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('knowledge_hub_modal_domain_label')} name="domain">
                <Select options={DOMAIN_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  )
}

export default AgentKnowledgeHub
