import React, { useEffect, useState } from 'react'
import {
  Table,
  Card,
  Typography,
  Button,
  Tag,
  Input,
  Select,
  Space,
  Modal,
  message,
  Tabs,
  Badge,
  Popconfirm,
  Descriptions,
} from 'antd'
import {
  DownloadOutlined,
  DeleteOutlined,
  ArrowUpOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ShopOutlined,
  AppstoreOutlined,
} from '@ant-design/icons'
import { pluginApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography

const PluginList: React.FC = () => {
  const { t } = useTranslation()
  const [installed, setInstalled] = useState<any[]>([])
  const [marketplace, setMarketplace] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [category, setCategory] = useState('')
  const [auditModal, setAuditModal] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('marketplace')

  const CATEGORIES = [
    { value: '', label: t('plugin_list_all_categories') },
    { value: 'data', label: t('plugin_list_data_processing') },
    { value: 'development', label: t('plugin_list_development_tools') },
    { value: 'productivity', label: t('plugin_list_productivity_tools') },
    { value: 'integration', label: t('plugin_list_integration') },
    { value: 'ai', label: t('plugin_list_ai_enhancement') },
  ]

  useEffect(() => {
    fetchInstalled()
    fetchMarketplace()
  }, [])

  const fetchInstalled = async () => {
    try {
      const res = await pluginApi.list()
      setInstalled(res.items || [])
    } catch {
      // ignore
    }
  }

  const fetchMarketplace = async (query = '', cat = '') => {
    setLoading(true)
    try {
      const res = await pluginApi.marketplace({ query, category: cat })
      setMarketplace(res.items || [])
    } catch {
      message.error(t('plugin_list_fetch_failure'))
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = () => {
    fetchMarketplace(searchQuery, category)
  }

  const handleInstall = async (skillId: string, version: string) => {
    try {
      await pluginApi.install({ plugin_id: skillId, version })
      message.success(t('plugin_list_install_success'))
      fetchInstalled()
      fetchMarketplace(searchQuery, category)
    } catch {
      message.error(t('plugin_list_install_failure'))
    }
  }

  const handleUninstall = async (pluginId: string) => {
    try {
      await pluginApi.uninstall(pluginId)
      message.success(t('plugin_list_uninstall_success'))
      fetchInstalled()
    } catch {
      message.error(t('plugin_list_uninstall_failure'))
    }
  }

  const handleUpgrade = async (pluginId: string, version: string) => {
    try {
      await pluginApi.upgrade(pluginId, { version })
      message.success(t('plugin_list_upgrade_success'))
      fetchInstalled()
    } catch {
      message.error(t('plugin_list_upgrade_failure'))
    }
  }

  const handleAudit = async (pluginId: string) => {
    try {
      const res = await pluginApi.audit(pluginId)
      setAuditModal(res)
    } catch {
      message.error(t('plugin_list_audit_failure'))
    }
  }

  const riskColor = (level: string) => {
    if (level === 'low') return 'green'
    if (level === 'medium') return 'orange'
    if (level === 'high') return 'red'
    return 'default'
  }

  const marketplaceColumns = [
    { title: t('plugin_list_column_name'), dataIndex: 'name', key: 'name', render: (v: string) => <Text strong>{v}</Text> },
    { title: t('plugin_list_column_desc'), dataIndex: 'description', key: 'description', ellipsis: true },
    { title: t('plugin_list_column_category'), dataIndex: 'category', key: 'category', render: (c: string) => <Tag>{c}</Tag> },
    { title: t('plugin_list_column_version'), dataIndex: 'latest_version', key: 'latest_version' },
    { title: t('plugin_list_column_author'), dataIndex: 'author', key: 'author' },
    {
      title: t('plugin_list_column_actions'),
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            type="primary"
            icon={<DownloadOutlined />}
            onClick={() => handleInstall(record.id, record.latest_version)}
            disabled={record.installed}
          >
            {record.installed ? t('plugin_list_installed_button') : t('plugin_list_install_button')}
          </Button>
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            onClick={() => handleAudit(record.id)}
          >
            {t('plugin_list_audit_button')}
          </Button>
        </Space>
      ),
    },
  ]

  const installedColumns = [
    { title: t('plugin_list_column_name'), dataIndex: 'name', key: 'name', render: (v: string) => <Text strong>{v}</Text> },
    { title: t('plugin_list_column_version'), dataIndex: 'version', key: 'version' },
    { title: t('plugin_list_column_category'), dataIndex: 'category', key: 'category', render: (c: string) => c ? <Tag>{c}</Tag> : '-' },
    {
      title: t('plugin_list_column_status'),
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => <Tag color={s === 'installed' ? 'green' : 'orange'}>{s}</Tag>,
    },
    { title: t('plugin_list_column_installed_at'), dataIndex: 'installed_at', key: 'installed_at' },
    {
      title: t('plugin_list_column_actions'),
      key: 'actions',
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            onClick={() => handleUpgrade(record.id, record.version)}
          >
            {t('plugin_list_upgrade_button')}
          </Button>
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            onClick={() => handleAudit(record.id)}
          >
            {t('plugin_list_audit_button')}
          </Button>
          <Popconfirm title={t('plugin_list_uninstall_confirm')} onConfirm={() => handleUninstall(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>
              {t('plugin_list_uninstall_button')}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title level={2}>
        <ShopOutlined /> {t('plugin_list_title')}
      </Title>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'marketplace',
            label: (
              <span>
                <AppstoreOutlined /> {t('plugin_list_browse_tab')}
              </span>
            ),
            children: (
              <Card>
                <Space style={{ marginBottom: 16, width: '100%' }}>
                  <Input
                    placeholder={t('plugin_list_search_placeholder')}
                    prefix={<SearchOutlined />}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onPressEnter={handleSearch}
                    style={{ width: 300 }}
                  />
                  <Select
                    value={category}
                    onChange={(v) => { setCategory(v); fetchMarketplace(searchQuery, v) }}
                    options={CATEGORIES}
                    style={{ width: 140 }}
                  />
                  <Button type="primary" onClick={handleSearch}>{t('plugin_list_search_button')}</Button>
                </Space>
                <Table
                  columns={marketplaceColumns}
                  dataSource={marketplace}
                  rowKey="id"
                  loading={loading}
                  pagination={{ pageSize: 10 }}
                />
              </Card>
            ),
          },
          {
            key: 'installed',
            label: (
              <span>
                <Badge count={installed.length} size="small" offset={[6, 0]}>
                  {t('plugin_list_installed_tab')}
                </Badge>
              </span>
            ),
            children: (
              <Card>
                <Table
                  columns={installedColumns}
                  dataSource={installed}
                  rowKey="id"
                  loading={loading}
                />
              </Card>
            ),
          },
        ]}
      />

      {/* Security audit modal */}
      <Modal
        title={t('plugin_list_audit_modal_title')}
        open={!!auditModal}
        onCancel={() => setAuditModal(null)}
        footer={<Button onClick={() => setAuditModal(null)}>{t('plugin_list_audit_close_button')}</Button>}
        width={600}
      >
        {auditModal && (
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label={t('plugin_list_audit_skill_label')}>
              {auditModal.skill_id}
            </Descriptions.Item>
            <Descriptions.Item label={t('plugin_list_audit_risk_label')}>
              <Tag color={riskColor(auditModal.risk_level)}>
                {auditModal.risk_level?.toUpperCase()}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('plugin_list_audit_permissions_label')}>
              {(auditModal.permissions || []).map((p: string) => (
                <Tag key={p}>{p}</Tag>
              ))}
            </Descriptions.Item>
            {auditModal.issues?.length > 0 && (
              <Descriptions.Item label={t('plugin_list_audit_issues_label')}>
                {auditModal.issues.map((issue: string, i: number) => (
                  <div key={i}><Tag color="red">{issue}</Tag></div>
                ))}
              </Descriptions.Item>
            )}
            <Descriptions.Item label={t('plugin_list_audit_time_label')}>
              {auditModal.audited_at}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  )
}

export default PluginList
