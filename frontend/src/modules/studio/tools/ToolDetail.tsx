import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card,
  Descriptions,
  Tag,
  Button,
  Space,
  Typography,
  Tabs,
  Table,
  Form,
  Input,
  InputNumber,
  message,
} from 'antd'
import { ArrowLeftOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { toolApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title } = Typography
const { TextArea } = Input

const ToolDetail: React.FC = () => {
  const { t } = useTranslation()
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [tool, setTool] = useState<any>(null)
  const [form] = Form.useForm()
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<any>(null)

  useEffect(() => {
    if (name) {
      fetchToolDetail()
    }
  }, [name])

  const fetchToolDetail = async () => {
    try {
      const res = await toolApi.get(name!)
      setTool(res)
    } catch (error) {
      message.error(t('tool_detail_fetch_failure'))
    }
  }

  const handleExecute = async (values: any) => {
    setExecuting(true)
    try {
      const res = await toolApi.execute(name!, {
        parameters: values.parameters ? JSON.parse(values.parameters) : {},
        timeout: values.timeout,
      })
      setResult(res)
      message.success(t('tool_detail_execute_success'))
    } catch (error) {
      message.error(t('tool_detail_execute_failure'))
    } finally {
      setExecuting(false)
    }
  }

  if (!tool) return null

  const getPermissionTag = (level: number) => {
    const colors = ['green', 'blue', 'orange', 'red']
    const texts = [t('tool_detail_permission_l0'), t('tool_detail_permission_l1'), t('tool_detail_permission_l2'), t('tool_detail_permission_l3')]
    return <Tag color={colors[level] || 'default'}>{texts[level] || 'unknown'}</Tag>
  }

  const paramColumns = [
    { title: t('tool_detail_param_name_column'), dataIndex: 'name', key: 'name' },
    { title: t('tool_detail_param_type_column'), dataIndex: 'type', key: 'type', render: (tp: string) => <Tag>{tp}</Tag> },
    { title: t('tool_detail_param_required_column'), dataIndex: 'required', key: 'required', render: (r: boolean) => r ? <Tag color="red">{t('tool_detail_param_required_yes')}</Tag> : <Tag>{t('tool_detail_param_required_no')}</Tag> },
    { title: t('tool_detail_param_description_column'), dataIndex: 'description', key: 'description' },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 24 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/tools')}>{t('tool_detail_back_button')}</Button>
      </Space>

      <Title level={2}>{tool.name}</Title>

      <Card className="detail-card">
        <Descriptions bordered column={2}>
          <Descriptions.Item label={t('tool_list_name_column')}>{tool.name}</Descriptions.Item>
          <Descriptions.Item label={t('tool_list_permission_column')}>{getPermissionTag(tool.permission_level)}</Descriptions.Item>
          <Descriptions.Item label={t('tool_list_description_column')} span={2}>{tool.description}</Descriptions.Item>
          <Descriptions.Item label="Handler">{tool.handler}</Descriptions.Item>
          <Descriptions.Item label="Version">{tool.version}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Tabs
        defaultActiveKey="schema"
        items={[
          {
            key: 'schema',
            label: t('tool_detail_parameters_title'),
            children: (
              <Card>
                <Table
                  columns={paramColumns}
                  dataSource={tool.schema?.parameters || []}
                  rowKey="name"
                  pagination={false}
                />
              </Card>
            ),
          },
          {
            key: 'execute',
            label: t('tool_detail_execute_button'),
            children: (
              <Card>
                <Form form={form} layout="vertical" onFinish={handleExecute}>
                  <Form.Item name="parameters" label="Parameters (JSON)">
                    <TextArea rows={6} placeholder='{"key": "value"}' />
                  </Form.Item>
                  <Form.Item name="timeout" label="Timeout (s)" initialValue={60}>
                    <InputNumber min={10} max={600} />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" loading={executing} icon={<PlayCircleOutlined />}>
                      {t('tool_detail_execute_button')}
                    </Button>
                  </Form.Item>
                </Form>

                {result && (
                  <div style={{ marginTop: 24 }}>
                    <pre className="code-block">{JSON.stringify(result, null, 2)}</pre>
                  </div>
                )}
              </Card>
            ),
          },
          {
            key: 'history',
            label: 'History',
            children: (
              <Card />
            ),
          },
        ]}
      />
    </div>
  )
}

export default ToolDetail
