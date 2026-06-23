import React, { useEffect, useState } from 'react'
import {
  Card,
  Form,
  Input,
  Button,
  Select,
  Typography,
  message,
  Tag,
  Row,
  Col,
  Divider,
  Space,
  Alert,
} from 'antd'
import {
  SendOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ApiOutlined,
  MailOutlined,
  MessageOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { connectorApi } from '@/api'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../../../stores/auth'
import { goToRuntime } from '../../../utils/runtimeBridge'

const { Title, Text } = Typography
const { TextArea } = Input

interface Connector {
  name: string
  display_name: string
  configured: boolean
  webhook_path: string
  detail?: string
  capabilities?: { send?: boolean; receive?: boolean }
}

const ConnectorPage: React.FC = () => {
  const { t } = useTranslation()
  const { token, refreshToken } = useAuthStore()
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [sending, setSending] = useState(false)
  const [form] = Form.useForm()

  const FEISHU_MSG_TYPES = [
    { label: t('connector_page_feishu_msg_text'), value: 'text' },
    { label: t('connector_page_feishu_msg_rich_text'), value: 'rich_text' },
    { label: t('connector_page_feishu_msg_interactive'), value: 'interactive' },
  ]

  useEffect(() => {
    fetchConnectors()
  }, [])

  const fetchConnectors = async () => {
    setLoadingList(true)
    try {
      const res = await connectorApi.list()
      setConnectors(res.connectors || [])
    } catch {
      message.error(t('connector_page_list_fetch_failure'))
    } finally {
      setLoadingList(false)
    }
  }

  const handleSend = async (values: any) => {
    setSending(true)
    try {
      const res = await connectorApi.send('feishu', {
        target: values.webhook_url || undefined,
        content: values.content,
        msg_type: values.msg_type || 'text',
      })
      if (res.success) {
        message.success(t('connector_page_feishu_send_success'))
        form.resetFields(['content'])
      } else {
        message.error(`${t('connector_page_send_failure')}：${res.error || ''}`)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('connector_page_send_failure'))
    } finally {
      setSending(false)
    }
  }

  const feishu = connectors.find(c => c.name === 'feishu')

  return (
    <div>
      <Title level={2}>
        <ApiOutlined style={{ marginRight: 8 }} />
        {t('connector_page_title')}
      </Title>

      {/* Connector status cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {connectors.map(c => (
          <Col key={c.name} xs={24} sm={12} md={8} lg={6}>
            <Card
              loading={loadingList}
              size="small"
              style={{
                borderLeft: `4px solid ${c.configured ? '#52c41a' : '#d9d9d9'}`,
                height: '100%',
              }}
            >
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {/* Header row */}
                <Space>
                  {c.name === 'outlook' ? (
                    <MailOutlined style={{ color: c.configured ? '#0078d4' : '#bbb', fontSize: 16 }} />
                  ) : c.name === 'teams' ? (
                    <MessageOutlined style={{ color: c.configured ? '#6264a7' : '#bbb', fontSize: 16 }} />
                  ) : (
                    c.configured
                      ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                      : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                  )}
                  <Text strong>{c.display_name}</Text>
                  <Tag color={c.configured ? 'success' : 'default'}>
                    {c.configured ? t('connector_page_configured_tag') : t('connector_page_not_configured_tag')}
                  </Tag>
                </Space>

                {/* Capabilities badges */}
                {c.capabilities && (
                  <Space size={4} wrap>
                    <Tag
                      color={c.capabilities.send ? 'blue' : 'default'}
                      style={{ margin: 0, fontSize: 11 }}
                    >
                      {c.capabilities.send ? '✓ ' : '✗ '}{t('connector_page_feishu_send_title').includes('Send') ? 'Send' : '发送'}
                    </Tag>
                    <Tag
                      color={c.capabilities.receive ? 'purple' : 'default'}
                      style={{ margin: 0, fontSize: 11 }}
                    >
                      {c.capabilities.receive ? '✓ ' : '✗ '}{t('connector_page_feishu_send_title').includes('Send') ? 'Receive' : '接收'}
                    </Tag>
                  </Space>
                )}

                {/* Detail description */}
                {c.detail && (
                  <Text type="secondary" style={{ fontSize: 11, lineHeight: 1.4 }}>
                    {c.detail}
                  </Text>
                )}

                {/* Config button — jump to the matching section in ConnectorConfig */}
                <Button
                  size="small"
                  icon={<SettingOutlined />}
                  onClick={() => {
                    const sectionMap: Record<string, string> = {
                      outlook: 'email', email: 'email',
                      teams: 'teams',
                      feishu: 'feishu',
                      wechat: 'wechat', wechat_work: 'wechat',
                      line: 'line',
                      telegram: 'telegram',
                      discord: 'discord',
                      whatsapp: 'whatsapp',
                    }
                    const section = sectionMap[c.name] || c.name
                    // /system/connectors lives in the Runtime app, not Studio —
                    // bridge across instead of SPA-navigating (which 404s → /agents).
                    goToRuntime(`/system/connectors#section-${section}`, token, refreshToken)
                  }}
                  type={c.configured ? 'default' : 'primary'}
                  style={{ marginTop: 4, width: '100%' }}
                >
                  {c.configured ? '查看 / 修改配置' : '立即配置'}
                </Button>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>

      <Alert
        type="info"
        showIcon
        message="提示"
        description={
          <span>
            连接器的详细配置（API 密钥、Webhook URL、测试连接等）在
            <Button type="link" style={{ padding: '0 4px' }} onClick={() => goToRuntime('/system/connectors', token, refreshToken)}>
              系统设置 → 消息连接器配置
            </Button>
            页面进行。
          </span>
        }
        style={{ marginBottom: 24 }}
      />

      {/* Feishu send form */}
      <Card
        title={
          <Space>
            <span>{t('connector_page_feishu_send_title')}</span>
            {feishu && (
              <Tag color={feishu.configured ? 'success' : 'warning'}>
                {feishu.configured ? t('connector_page_feishu_configured_tag') : t('connector_page_feishu_custom_tag')}
              </Tag>
            )}
          </Space>
        }
      >
        {!feishu?.configured && (
          <Alert
            type="info"
            showIcon
            message={t('connector_page_feishu_unconfigured_alert')}
            description={t('connector_page_feishu_unconfigured_desc')}
            style={{ marginBottom: 20 }}
          />
        )}

        <Form
          form={form}
          layout="vertical"
          onFinish={handleSend}
          initialValues={{ msg_type: 'text' }}
        >
          <Form.Item
            label={t('connector_page_webhook_url_label')}
            name="webhook_url"
            extra={feishu?.configured
              ? t('connector_page_webhook_url_configured_extra')
              : t('connector_page_webhook_url_extra')}
          >
            <Input
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
              allowClear
            />
          </Form.Item>

          <Form.Item label={t('connector_page_msg_type_label')} name="msg_type">
            <Select options={FEISHU_MSG_TYPES} style={{ width: 180 }} />
          </Form.Item>

          <Form.Item
            label={t('connector_page_content_label')}
            name="content"
            rules={[{ required: true, message: t('connector_page_content_required') }]}
          >
            <TextArea
              rows={5}
              placeholder={t('connector_page_content_placeholder')}
              showCount
              maxLength={2000}
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={sending}
              icon={<SendOutlined />}
            >
              {t('connector_page_send_button')}
            </Button>
          </Form.Item>
        </Form>

        <Divider />

        <Title level={5}>{t('connector_page_usage_title')}</Title>
        <ul style={{ paddingLeft: 20, color: '#666' }}>
          <li>
            <Text type="secondary">
              <b>{t('connector_page_feishu_msg_text')}</b>：{t('connector_page_feishu_text_desc')}
            </Text>
          </li>
          <li>
            <Text type="secondary">
              <b>{t('connector_page_feishu_msg_rich_text')}</b>：{t('connector_page_feishu_rich_desc')}
            </Text>
          </li>
          <li>
            <Text type="secondary">
              <b>{t('connector_page_feishu_msg_interactive')}</b>：{t('connector_page_feishu_card_desc')}
            </Text>
          </li>
        </ul>
      </Card>
    </div>
  )
}

export default ConnectorPage
