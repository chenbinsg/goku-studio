import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Typography,
  Input,
  Badge,
  Row,
  Col,
  Statistic,
  Modal,
  Form,
  Select,
  message,
} from 'antd'
import {
  ToolOutlined,
  SearchOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  SafetyOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import { toolApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography
const { TextArea } = Input

const DEFAULT_TOOL_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {},
}, null, 2)

const ToolList: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [form] = Form.useForm()
  const [tools, setTools] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')

  useEffect(() => {
    fetchTools()
  }, [])

  const fetchTools = async () => {
    setLoading(true)
    try {
      const res = await toolApi.list()
      setTools(res.tools || [])
    } catch (error) {
      console.error('Failed to fetch tools')
    } finally {
      setLoading(false)
    }
  }

  const openAddModal = () => {
    form.setFieldsValue({
      permission_level: 0,
      schema: DEFAULT_TOOL_SCHEMA,
    })
    setAddModalOpen(true)
  }

  const closeAddModal = () => {
    if (registering) return
    setAddModalOpen(false)
    form.resetFields()
  }

  const handleRegisterTool = async () => {
    const values = await form.validateFields()
    setRegistering(true)
    try {
      await toolApi.register({
        name: values.name.trim(),
        description: values.description.trim(),
        handler: values.handler.trim(),
        permission_level: values.permission_level,
        schema: JSON.parse(values.schema),
      })
      message.success(t('tool_list_add_success'))
      setAddModalOpen(false)
      form.resetFields()
      await fetchTools()
    } catch (error) {
      message.error(t('tool_list_add_failure'))
    } finally {
      setRegistering(false)
    }
  }

  const getPermissionTag = (level: number) => {
    const colors = ['green', 'blue', 'orange', 'red']
    const texts = [t('tool_list_permission_l0'), t('tool_list_permission_l1'), t('tool_list_permission_l2'), t('tool_list_permission_l3')]
    return <Tag color={colors[level] || 'default'}>{texts[level] || 'unknown'}</Tag>
  }

  const filteredTools = tools.filter(tool =>
    tool.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    tool.description?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const columns = [
    {
      title: t('tool_list_name_column'),
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => (
        <Space>
          <ToolOutlined />
          <Text strong>{text}</Text>
        </Space>
      ),
    },
    {
      title: t('tool_list_description_column'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: t('tool_list_permission_column'),
      dataIndex: 'permission_level',
      key: 'permission_level',
      width: 140,
      render: getPermissionTag,
    },
    {
      title: 'Calls',
      dataIndex: 'call_count',
      key: 'call_count',
      width: 100,
      render: (count: number) => <Badge count={count || 0} showZero color="#1890ff" />,
    },
    {
      title: 'Success',
      dataIndex: 'success_rate',
      key: 'success_rate',
      width: 100,
      render: (rate: number) => `${(rate || 0).toFixed(1)}%`,
    },
    {
      title: 'Action',
      key: 'action',
      width: 150,
      render: (_: any, record: any) => (
        <Space>
          <Button type="text" icon={<CodeOutlined />} onClick={() => navigate(`/tools/${record.name}`)} />
          <Button type="text" icon={<PlayCircleOutlined />} />
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title level={2}>{t('tool_list_title')}</Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic value={tools.length} prefix={<ToolOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic value={tools.filter(tool => tool.permission_level === 3).length} prefix={<SafetyOutlined />} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic value={1247} prefix={<PlayCircleOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic value={98.5} suffix="%" prefix={<SafetyOutlined />} valueStyle={{ color: '#3f8600' }} />
          </Card>
        </Col>
      </Row>

      <Card>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between' }}>
          <Input
            prefix={<SearchOutlined />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: 300 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal} aria-label={t('tool_list_add_button')} />
        </div>

        <Table
          columns={columns}
          dataSource={filteredTools}
          rowKey="name"
          loading={loading}
        />
      </Card>

      <Modal
        title={t('tool_list_add_title')}
        open={addModalOpen}
        onOk={handleRegisterTool}
        onCancel={closeAddModal}
        okText={t('tool_list_add_submit')}
        cancelText={t('common_cancel', 'Cancel')}
        confirmLoading={registering}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="name"
            label={t('tool_list_add_name')}
            rules={[
              { required: true, message: t('tool_list_add_name_required') },
              {
                pattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
                message: t('tool_list_add_name_invalid'),
              },
            ]}
          >
            <Input placeholder="custom_tool" />
          </Form.Item>
          <Form.Item
            name="description"
            label={t('tool_list_add_description')}
            rules={[{ required: true, message: t('tool_list_add_description_required') }]}
          >
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="handler"
            label={t('tool_list_add_handler')}
            rules={[{ required: true, message: t('tool_list_add_handler_required') }]}
          >
            <Input placeholder="app.agent.tools.custom:execute" />
          </Form.Item>
          <Form.Item
            name="permission_level"
            label={t('tool_list_permission_column')}
            rules={[{ required: true }]}
          >
            <Select
              options={[
                { value: 0, label: t('tool_list_permission_l0') },
                { value: 1, label: t('tool_list_permission_l1') },
                { value: 2, label: t('tool_list_permission_l2') },
                { value: 3, label: t('tool_list_permission_l3') },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="schema"
            label={t('tool_list_add_schema')}
            rules={[
              { required: true, message: t('tool_list_add_schema_required') },
              {
                validator: async (_, value) => {
                  try {
                    JSON.parse(value)
                  } catch (error) {
                    throw new Error(t('tool_list_add_schema_invalid'))
                  }
                },
              },
            ]}
          >
            <TextArea rows={6} spellCheck={false} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default ToolList
