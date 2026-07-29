/**
 * MCP 外部连接管理 —— 平台托管的外部系统连接配置 + 加密 secret。
 *
 * 属于 MCP 管理模块的公共基础能力。它不是 MCP Server,不替代 MCP Server
 * 实例;MCP Server 通过 env_config.connection_id 引用一个默认连接。
 *
 * secret 字段在 API 永远是脱敏值(「已配置 ********」);编辑时保持脱敏值
 * 不动 = 保留原密文,改成别的值 = 重新加密。
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Table, Button, Tag, Space, Typography, Input, Select, Switch, Drawer,
  Form, message, Card, Empty, Modal, Tooltip, Breadcrumb, Checkbox, Alert,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, EditOutlined,
  DeleteOutlined, PoweroffOutlined, PlayCircleOutlined, LinkOutlined,
  ArrowLeftOutlined, DownloadOutlined,
} from '@ant-design/icons'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { api } from '@/api'
import { downloadExport, fetchExistingCodes, McpImportButton } from './mcpTransfer'

const { Title, Text } = Typography

interface Connection {
  id: string
  code: string
  name: string
  connection_type: string
  enabled: boolean
  test_status?: string | null
  last_tested_at?: string | null
  created_at: string
  updated_at: string
  config?: Record<string, any>
  secret?: Record<string, any>
  allowed_scopes?: Record<string, any>
  last_test_error?: string | null
}

// An MCP server that currently binds a connection (from the /usage probe).
interface UsingServer {
  id: string
  code: string
  name: string
  binding_keys: string[]
}

// Connection-type values; labels come from i18n (mcp_conn_type_<value>).
const CONNECTION_TYPE_VALUES = [
  's3', 'sftp', 'url', 'local_path', 'database', 'github', 'slack',
]
const typeLabel = (v: string): string => i18n.t(`mcp_conn_type_${v}`, { defaultValue: v })

// 每种连接类型的 config / secret / allowed_scopes 模板 —— 选类型时预填,
// 让管理员看到该类型期望的字段(对应技术标准的配置结构示例)。
const TYPE_TEMPLATES: Record<string, { config: any; secret: any; allowed_scopes: any }> = {
  s3: {
    config: { region: 'ap-northeast-1', endpoint_url: null, force_path_style: false },
    secret: { aws_access_key_id: '', aws_secret_access_key: '' },
    allowed_scopes: { allowed_buckets: [], allowed_prefixes: [] },
  },
  sftp: {
    config: { host: '', port: 22, username: '', auth_type: 'password' },
    secret: { password: '' },
    allowed_scopes: { allowed_paths: [] },
  },
  url: {
    config: { timeout_seconds: 30, max_download_size: 104857600 },
    secret: { authorization_header: '' },
    allowed_scopes: { allowed_domains: [], deny_private_ip: true },
  },
  local_path: {
    config: {},
    secret: {},
    allowed_scopes: { allowed_dirs: [] },
  },
  database: {
    config: { db_type: 'mysql', host: '', port: 3306, database: '', username: '' },
    secret: { password: '' },
    allowed_scopes: { read_only: true, allowed_tables: [] },
  },
  github: {
    config: { api_base_url: 'https://api.github.com' },
    secret: { token: '' },
    allowed_scopes: { allowed_orgs: [], allowed_repos: [] },
  },
  slack: {
    config: { workspace: '' },
    secret: { bot_token: '' },
    allowed_scopes: { allowed_channels: [] },
  },
}

function testStatusTag(s?: string | null) {
  if (s === 'ok') return <Tag color="success">{i18n.t('mcp_conn_test_ok')}</Tag>
  if (s === 'failed') return <Tag color="error">{i18n.t('mcp_conn_test_failed')}</Tag>
  return <Tag>{i18n.t('mcp_conn_test_untested')}</Tag>
}

function fmt(v?: string | null): string {
  if (!v) return '-'
  try { return new Date(v).toLocaleString() } catch { return v }
}

const McpExternalConnections: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [items, setItems] = useState<Connection[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | undefined>()
  const [enabledFilter, setEnabledFilter] = useState<boolean | undefined>()
  const [keyword, setKeyword] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [saving, setSaving] = useState(false)
  // 批量导出:默认不显示复选框,点「导出」进入选择模式才出现;
  // 勾选存 code,后端导出接口按 code 过滤
  const [exportMode, setExportMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [selectedCodes, setSelectedCodes] = useState<string[]>([])
  // Delete confirmation: target + the MCP servers currently binding it +
  // the "I understand this unbinds them" checkbox gate.
  const [deleteTarget, setDeleteTarget] = useState<Connection | null>(null)
  const [deleteUsage, setDeleteUsage] = useState<UsingServer[]>([])
  const [deleteAck, setDeleteAck] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [form] = Form.useForm()

  const exitExportMode = () => {
    setExportMode(false)
    setSelectedKeys([])
    setSelectedCodes([])
  }

  const onExportSelected = async () => {
    await downloadExport('/mcp-external-connections', 'mcp-connections', selectedCodes)
    exitExportMode()
  }

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = {}
      if (typeFilter) params.connection_type = typeFilter
      if (enabledFilter !== undefined) params.enabled = enabledFilter
      if (keyword.trim()) params.keyword = keyword.trim()
      const res = await api.get<{ items: Connection[] }>('/mcp-external-connections', { params })
      setItems(res.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_conn_msg_load_list_failed'))
    } finally {
      setLoading(false)
    }
  }, [typeFilter, enabledFilter, keyword])

  useEffect(() => { reload() }, [reload])

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      connection_type: 's3', enabled: true,
      config: JSON.stringify(TYPE_TEMPLATES.s3.config, null, 2),
      secret: JSON.stringify(TYPE_TEMPLATES.s3.secret, null, 2),
      allowed_scopes: JSON.stringify(TYPE_TEMPLATES.s3.allowed_scopes, null, 2),
    })
    setDrawerOpen(true)
  }

  const openEdit = async (row: Connection) => {
    try {
      const d = await api.get<Connection>(`/mcp-external-connections/${row.id}`)
      setEditing(d)
      form.resetFields()
      form.setFieldsValue({
        code: d.code, name: d.name, connection_type: d.connection_type, enabled: d.enabled,
        config: JSON.stringify(d.config || {}, null, 2),
        secret: JSON.stringify(d.secret || {}, null, 2),
        allowed_scopes: JSON.stringify(d.allowed_scopes || {}, null, 2),
      })
      setDrawerOpen(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_conn_msg_load_detail_failed'))
    }
  }

  const onTypeChange = (t: string) => {
    if (editing) return // 编辑态不改类型
    const tpl = TYPE_TEMPLATES[t]
    form.setFieldsValue({
      config: JSON.stringify(tpl.config, null, 2),
      secret: JSON.stringify(tpl.secret, null, 2),
      allowed_scopes: JSON.stringify(tpl.allowed_scopes, null, 2),
    })
  }

  const submit = async () => {
    let v: any
    try { v = await form.validateFields() } catch { return }
    const parse = (s: string, label: string) => {
      try { return JSON.parse(s || '{}') }
      catch { throw new Error(t('mcp_conn_msg_json_invalid', { label })) }
    }
    let config, secret, scopes
    try {
      config = parse(v.config, 'config')
      secret = parse(v.secret, 'secret')
      scopes = parse(v.allowed_scopes, 'allowed_scopes')
    } catch (e: any) { message.error(e.message); return }

    setSaving(true)
    try {
      if (editing) {
        await api.patch(`/mcp-external-connections/${editing.id}`, {
          name: v.name, enabled: v.enabled,
          config, secret, allowed_scopes: scopes,
        })
        message.success(t('mcp_conn_msg_saved'))
      } else {
        await api.post('/mcp-external-connections', {
          code: v.code, name: v.name, connection_type: v.connection_type,
          enabled: v.enabled, config, secret, allowed_scopes: scopes,
        })
        message.success(t('mcp_conn_msg_created'))
      }
      setDrawerOpen(false)
      reload()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_conn_msg_save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const onTest = async (row: Connection) => {
    const hide = message.loading(t('mcp_conn_msg_testing', { name: row.name }), 0)
    try {
      const r = await api.post<any>(`/mcp-external-connections/${row.id}/test`, {})
      hide()
      if (r.test_status === 'ok') {
        message.success(t('mcp_conn_msg_test_ok', { detail: r.detail || '' }))
      } else {
        message.error(t('mcp_conn_msg_test_failed', { error: r.last_test_error || r.detail || '' }))
      }
      reload()
    } catch (e: any) {
      hide()
      message.error(e?.response?.data?.detail || t('mcp_conn_msg_test_error'))
    }
  }

  const onToggle = async (row: Connection) => {
    try {
      await api.post(`/mcp-external-connections/${row.id}/${row.enabled ? 'disable' : 'enable'}`, {})
      message.success(t(row.enabled ? 'mcp_conn_msg_disabled' : 'mcp_conn_msg_enabled'))
      reload()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_conn_msg_action_error'))
    }
  }

  const onDelete = async (row: Connection) => {
    // Check which MCP servers bind this connection before deleting — a used
    // connection needs explicit "unbind" confirmation (checkbox) so we never
    // silently break a server's binding.
    let servers: UsingServer[] = []
    try {
      const res: any = await api.get(`/mcp-external-connections/${row.id}/usage`)
      servers = res?.servers || []
    } catch {
      // usage probe failed — fall through to a plain confirm; the backend
      // still guards with a 409 if the connection turns out to be in use.
    }
    setDeleteTarget(row)
    setDeleteUsage(servers)
    setDeleteAck(false)
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const qs = deleteUsage.length ? '?unbind=true' : ''
      await api.delete(`/mcp-external-connections/${deleteTarget.id}${qs}`)
      message.success(t('mcp_conn_msg_deleted'))
      setDeleteTarget(null)
      reload()
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      message.error(
        (detail && (detail.message || detail)) || t('mcp_conn_msg_delete_failed'),
      )
    } finally {
      setDeleting(false)
    }
  }

  const columns = [
    { title: t('mcp_conn_col_code'), dataIndex: 'code', key: 'code', width: 180, ellipsis: true,
      render: (v: string) => <Text code style={{ whiteSpace: 'nowrap' }}>{v}</Text> },
    { title: t('mcp_conn_col_name'), dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
    { title: t('mcp_conn_col_type'), dataIndex: 'connection_type', key: 'type', width: 140,
      render: (v: string) => <Tag>{typeLabel(v)}</Tag> },
    { title: t('mcp_conn_col_status'), dataIndex: 'enabled', key: 'enabled', width: 90,
      render: (v: boolean) => v
        ? <Tag color="green">{t('mcp_status_enabled')}</Tag>
        : <Tag>{t('mcp_status_disabled')}</Tag> },
    { title: t('mcp_conn_col_test'), dataIndex: 'test_status', key: 'test', width: 100, render: testStatusTag },
    { title: t('mcp_conn_col_last_tested'), dataIndex: 'last_tested_at', key: 'tested_at', width: 170, render: fmt },
    { title: t('mcp_conn_col_updated'), dataIndex: 'updated_at', key: 'updated_at', width: 170, render: fmt },
    {
      title: t('mcp_conn_col_actions'), key: 'act', width: 280, fixed: 'right' as const,
      render: (_: any, row: Connection) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>{t('mcp_conn_action_edit')}</Button>
          <Tooltip title={t('mcp_conn_action_test')}>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => onTest(row)} />
          </Tooltip>
          <Tooltip title={t('mcp_transfer_export_row')}>
            <Button size="small" icon={<DownloadOutlined />}
                    onClick={() => downloadExport('/mcp-external-connections', 'mcp-connections', [row.code])} />
          </Tooltip>
          <Button size="small" icon={row.enabled ? <PoweroffOutlined /> : <PlayCircleOutlined />}
                  onClick={() => onToggle(row)}>
            {t(row.enabled ? 'mcp_conn_action_disable' : 'mcp_conn_action_enable')}
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(row)} />
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Breadcrumb
        style={{ marginBottom: 12 }}
        items={[
          { title: <Link to="/mcp">{t('mcp_server_list_page_title')}</Link> },
          { title: t('mcp_conn_page_title') },
        ]}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <Title level={2} style={{ margin: 0 }}><LinkOutlined /> {t('mcp_conn_page_title')}</Title>
          <Text type="secondary">{t('mcp_conn_page_description')}</Text>
        </div>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/mcp')}>
            {t('mcp_conn_btn_back')}
          </Button>
          {exportMode ? (
            <>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                disabled={selectedCodes.length === 0}
                onClick={onExportSelected}
              >
                {t('mcp_transfer_export_selected')}
                {selectedCodes.length > 0 ? ` (${selectedCodes.length})` : ''}
              </Button>
              <Button onClick={exitExportMode}>{t('mcp_transfer_export_cancel')}</Button>
            </>
          ) : (
            <Tooltip title={t('mcp_transfer_export_tooltip')}>
              <Button icon={<DownloadOutlined />} onClick={() => setExportMode(true)}>
                {t('mcp_transfer_export_button')}
              </Button>
            </Tooltip>
          )}
          <McpImportButton path="/mcp-external-connections" onDone={reload} />
          <Button icon={<ReloadOutlined />} onClick={reload}>{t('mcp_conn_btn_refresh')}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('mcp_conn_btn_add')}</Button>
        </Space>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select placeholder={t('mcp_conn_filter_type_placeholder')} allowClear style={{ width: 160 }}
                  value={typeFilter} onChange={setTypeFilter}
                  options={CONNECTION_TYPE_VALUES.map((v) => ({ value: v, label: t(`mcp_conn_type_${v}`) }))} />
          <Select placeholder={t('mcp_conn_filter_status_placeholder')} allowClear style={{ width: 120 }}
                  value={enabledFilter as any}
                  onChange={(v) => setEnabledFilter(v as any)}
                  options={[
                    { value: true, label: t('mcp_status_enabled') },
                    { value: false, label: t('mcp_status_disabled') },
                  ]} />
          <Input placeholder={t('mcp_conn_filter_keyword_placeholder')} allowClear style={{ width: 220 }}
                 value={keyword} onChange={(e) => setKeyword(e.target.value)}
                 onPressEnter={reload} />
        </Space>
      </Card>

      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        rowSelection={{
          // 选择列常驻占位(48px),避免进出导出模式时表格列挪动;
          // 非导出模式只是不渲染复选框
          selectedRowKeys: selectedKeys,
          columnWidth: 48,
          fixed: true,
          hideSelectAll: !exportMode,
          renderCell: exportMode ? undefined : () => null,
          onChange: (keys, rows) => {
            setSelectedKeys(keys)
            setSelectedCodes(rows.map((r) => r.code))
          },
        }}
        scroll={{ x: 1378 }}
        locale={{ emptyText: <Empty description={t('mcp_conn_empty')} /> }}
        pagination={{ pageSize: 20, showTotal: (n) => t('mcp_conn_pagination_total', { count: n }) }}
      />

      <Drawer
        open={drawerOpen}
        title={editing
          ? t('mcp_conn_drawer_title_edit', { name: editing.name })
          : t('mcp_conn_drawer_title_create')}
        width={640}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>{t('mcp_conn_drawer_cancel')}</Button>
            <Button type="primary" loading={saving} onClick={submit}>{t('mcp_conn_drawer_save')}</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label={t('mcp_conn_field_code')}
                     validateFirst
                     validateTrigger={['onChange', 'onBlur']}
                     rules={[
                       { required: true, message: t('mcp_conn_rule_code_required') },
                       {
                         // 输入后立即查库做唯一性校验,重复当场标红提醒
                         validateTrigger: 'onBlur',
                         validator: async (_, value) => {
                           if (!value || editing) return
                           const taken = await fetchExistingCodes('/mcp-external-connections', [value])
                           if (taken.includes(value)) {
                             throw new Error(t('mcp_transfer_code_taken'))
                           }
                         },
                       },
                     ]}>
            <Input placeholder={t('mcp_conn_ph_code')} disabled={!!editing} />
          </Form.Item>
          <Form.Item name="name" label={t('mcp_conn_field_name')}
                     rules={[{ required: true, message: t('mcp_conn_rule_name_required') }]}>
            <Input placeholder={t('mcp_conn_ph_name')} />
          </Form.Item>
          <Form.Item name="connection_type" label={t('mcp_conn_field_type')}
                     rules={[{ required: true }]}>
            <Select options={CONNECTION_TYPE_VALUES.map((v) => ({ value: v, label: t(`mcp_conn_type_${v}`) }))}
                    disabled={!!editing} onChange={onTypeChange} />
          </Form.Item>
          <Form.Item name="enabled" label={t('mcp_conn_field_enabled')} valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="config" label={t('mcp_conn_field_config')}>
            <Input.TextArea rows={5} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="secret" label={t('mcp_conn_field_secret')}
                     extra={t('mcp_conn_extra_secret')}>
            <Input.TextArea rows={4} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="allowed_scopes" label={t('mcp_conn_field_allowed_scopes')}>
            <Input.TextArea rows={4} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        open={!!deleteTarget}
        title={t('mcp_conn_delete_title', { name: deleteTarget?.name })}
        okText={t('mcp_conn_delete_ok')}
        okButtonProps={{
          danger: true,
          loading: deleting,
          // A connection in use requires the explicit unbind acknowledgement.
          disabled: deleteUsage.length > 0 && !deleteAck,
        }}
        cancelText={t('mcp_conn_delete_cancel')}
        onOk={doDelete}
        onCancel={() => setDeleteTarget(null)}
        confirmLoading={deleting}
        maskClosable={!deleting}
      >
        {deleteUsage.length === 0 ? (
          <Text>{t('mcp_conn_delete_content')}</Text>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('mcp_conn_delete_inuse_title', { count: deleteUsage.length })}
              description={t('mcp_conn_delete_inuse_desc')}
            />
            <div style={{ maxHeight: 180, overflow: 'auto', marginBottom: 12 }}>
              {deleteUsage.map((s) => (
                <div key={s.id} style={{ padding: '4px 0' }}>
                  <Tag color="blue">{s.code}</Tag>
                  <Text>{s.name}</Text>
                </div>
              ))}
            </div>
            <Checkbox
              checked={deleteAck}
              onChange={(e) => setDeleteAck(e.target.checked)}
            >
              {t('mcp_conn_delete_ack')}
            </Checkbox>
          </>
        )}
      </Modal>
    </div>
  )
}

export default McpExternalConnections
