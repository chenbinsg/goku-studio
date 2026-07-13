/**
 * MCP Server detail page (Task 6).
 *
 * Route: /mcp/:id (registered in App.tsx; menu unchanged).
 *
 * Layout:
 *   - Top summary card (name/code/category/connection/status/health + counts
 *     + last_checked_at) and 4 actions (test/sync/edit/enable-disable).
 *   - 6 Tabs that lazy-load their data on activation:
 *       基本信息 / 连接配置 / 能力 / 健康监控 / 调用日志 / 变更记录
 *   - 授权调用方 is no longer a standalone Tab. Each capability row in the
 *     能力 Tab opens a 「管理」 drawer (CapabilityManageDrawer) holding its
 *     详情 / 授权模式 / 限额 / 授权调用方 in one place.
 *
 * Naming: ALL UI strings use "MCP 能力" / "能力" / "MCP Capability".
 * Never "MCP Tools". The Tools/Capability separation is enforced at the
 * type level — capability_count from MCPServerDetail, never "tool_count".
 *
 * AI Tool permission / risk / confirm / auto-invoke knobs are
 * deliberately absent from this page. Those belong in
 * "AI 能力 > 工具管理".
 */
import React, { useCallback, useEffect, useState } from 'react'
import {
  Card, Descriptions, Tag, Space, Button, Typography, Tabs, Table, Modal,
  Form, Input, Select, message, Row, Col, Statistic, DatePicker, Empty,
  Spin, Result, Alert, InputNumber, Switch, Drawer, Collapse,
} from 'antd'
import {
  ThunderboltOutlined, SyncOutlined, EditOutlined, PoweroffOutlined,
  PlayCircleOutlined, ArrowLeftOutlined, ReloadOutlined, PlusOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { api } from '@/api'
import ServerDrawer, {
  STATUS_COLORS, HEALTH_COLORS, CAPABILITY_STATUS_COLORS,
  mcpStatusText, mcpHealthText, mcpCapabilityStatusText, mcpCategoryText, fmt,
  type MCPServerDetail as ServerDetail,
} from './ServerDrawer'

const { Title, Text, Paragraph } = Typography
const { RangePicker } = DatePicker

// ── Shared formatters ─────────────────────────────────────────────────
// Tag text is localized via the mcp*Text helpers (i18n singleton); the
// COLORS maps carry only the stable color metadata. These stay plain
// functions (not hooks) so they can be passed straight as column render
// callbacks — i18n picks up the active language at render time.

function statusTag(status?: string) {
  if (!status) return <Tag>-</Tag>
  return <Tag color={STATUS_COLORS[status] || 'default'}>{mcpStatusText(status)}</Tag>
}

function healthTag(status?: string) {
  if (!status) return <Tag>-</Tag>
  return <Tag color={HEALTH_COLORS[status] || 'default'}>{mcpHealthText(status)}</Tag>
}

function capabilityStatusTag(status?: string) {
  if (!status) return <Tag>-</Tag>
  return <Tag color={CAPABILITY_STATUS_COLORS[status] || 'default'}>{mcpCapabilityStatusText(status)}</Tag>
}

function jsonPreview(v: any): string {
  if (v == null) return '-'
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
  try {
    const s = JSON.stringify(v)
    return s.length > 200 ? s.slice(0, 200) + '…' : s
  } catch { return String(v) }
}

// ── Tab 1: 基本信息 ───────────────────────────────────────────────────

// Render a server's "effective" health: when the backend marks
// configuration_status='incomplete' (needs-connection server with no
// binding), demote whatever transport-level health_status says — a
// green "正常" on a github server with no token would mislead admins.
// Exported so the list page uses the same logic.
export function effectiveHealthTag(
  health_status: string | undefined,
  configuration_status: string | undefined,
): React.ReactNode {
  if (configuration_status === 'incomplete') {
    return <Tag color="error">{i18n.t('mcp_health_incomplete')}</Tag>
  }
  return healthTag(health_status)
}

const BasicInfoTab: React.FC<{ detail: ServerDetail }> = ({ detail }) => {
  const { t } = useTranslation()
  return (
    <Card>
      <Descriptions column={2} bordered size="small" styles={{ label: { width: 140 } }}>
        <Descriptions.Item label={t('mcp_detail_basic_name')}>{detail.name}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_code')}><Text code>{detail.code}</Text></Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_category')}>
          <Tag>{mcpCategoryText(detail.service_category)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_owner')}>{detail.owner || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_status')}>{statusTag(detail.status)}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_health')}>
          {effectiveHealthTag(detail.health_status, detail.configuration_status)}
        </Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_created_by')}>{detail.created_by || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_created_at')}>{fmt(detail.created_at)}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_updated_by')}>{detail.updated_by || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_updated_at')}>{fmt(detail.updated_at)}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_basic_description')} span={2}>
          <Paragraph style={{ marginBottom: 0 }}>{detail.description || '-'}</Paragraph>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  )
}

// ── Tab 2: 连接配置 ───────────────────────────────────────────────────

// env_config keys the per-type runtime injector OWNS — any of these
// appearing in env_config is illegal data (spec section 七:
// "不兼容旧模式 — 直接视为非法配置"). Same list as the backend
// FORBIDDEN_ENV_CONFIG_FIELDS, mirrored here for UI surface checks.
const ILLEGAL_ENV_PREFIXES = ['AWS_', 'SFTP_', 'DB_', 'URL_', 'GITHUB_', 'SLACK_']
const ILLEGAL_ENV_EXACT = new Set([
  'S3_BUCKET', 'S3_ALLOWED_BUCKETS', 'S3_ALLOWED_PREFIXES',
  'S3_ENDPOINT_URL', 'S3_FORCE_PATH_STYLE',
  'S3_UPLOAD_URL_EXPIRES_SECONDS', 'S3_DOWNLOAD_URL_EXPIRES_SECONDS',
  'LOCAL_ALLOWED_DIRS',
  // Generic secret-shaped names also forbidden by the backend.
  'AUTH_SECRET', 'TOKEN', 'API_KEY', 'ACCESS_TOKEN',
  'AUTHORIZATION', 'AUTHORIZATION_HEADER', 'X-API-KEY',
  'PASSWORD', 'PRIVATE_KEY',
])

function isIllegalEnvKey(k: string): boolean {
  const up = k.toUpperCase()
  return ILLEGAL_ENV_PREFIXES.some((p) => up.startsWith(p)) || ILLEGAL_ENV_EXACT.has(up)
}

const ConnectionTab: React.FC<{
  detail: ServerDetail
  onTest: () => void
  onEdit: () => void
}> = ({ detail, onTest, onEdit }) => {
  const { t } = useTranslation()
  const connectionCode = detail.secrets.env_config_connection_id
  const serverAuthCode = detail.secrets.env_config_server_auth_connection_id
  const isStdio = detail.connection_type === 'stdio'
  // env_config keys excluding the two internal binding keys (shown above
  // as separate rows). What's left = runtime params.
  const runtimeKeys = (detail.secrets.env_config_keys || []).filter(
    (k) => k !== 'connection_id' && k !== 'server_auth_connection_id',
  )
  const illegalKeys = runtimeKeys.filter(isIllegalEnvKey)
  // Backend is the single source of truth — _compute_configuration_status
  // matches start_command against _NEEDS_CONNECTION_BY_COMMAND and checks
  // env_config.connection_id. Mirroring that list in the frontend was a
  // duplication trap (PRs forget one side); we just read the verdict.
  const missingRequiredBinding = detail.configuration_status === 'incomplete'

  return (
    <Card
      title={t('mcp_detail_conn_title')}
      extra={
        <Space>
          <Button icon={<ThunderboltOutlined />} onClick={onTest}>{t('mcp_detail_header_test')}</Button>
          <Button type="primary" icon={<EditOutlined />} onClick={onEdit}>{t('mcp_detail_conn_btn_edit')}</Button>
        </Space>
      }
    >
      {missingRequiredBinding && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('mcp_detail_conn_incomplete_msg')}
          description={
            <>
              {t('mcp_detail_conn_incomplete_desc_pre')} <Text code>{detail.start_command}</Text>
              {t('mcp_detail_conn_incomplete_desc_post')}
            </>
          }
        />
      )}
      {illegalKeys.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('mcp_detail_conn_illegal_msg')}
          description={
            <>
              {t('mcp_detail_conn_illegal_desc_pre')} {illegalKeys.map((k) => <Text code key={k}>{k}</Text>).reduce<React.ReactNode[]>((acc, el, i) => {
                if (i > 0) acc.push('、')
                acc.push(el)
                return acc
              }, [])} {t('mcp_detail_conn_illegal_desc_post')}
            </>
          }
        />
      )}
      <Descriptions column={1} bordered size="small" styles={{ label: { width: 160 } }}>
        <Descriptions.Item label={t('mcp_detail_conn_field_type')}><Tag>{detail.connection_type.toUpperCase()}</Tag></Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_timeout')}>{t('mcp_detail_conn_timeout_unit', { n: detail.timeout_seconds })}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_retry')}>{detail.retry_count}</Descriptions.Item>

        {/* 只展示与连接方式相关的字段 */}
        {!isStdio && (
          <Descriptions.Item label={t('mcp_detail_conn_field_url')}>
            <Text code copyable={!!detail.service_url}>{detail.service_url || '-'}</Text>
          </Descriptions.Item>
        )}
        {isStdio && (
          <Descriptions.Item label={t('mcp_detail_conn_field_command')}>
            <Text code copyable={!!detail.start_command}>{detail.start_command || '-'}</Text>
          </Descriptions.Item>
        )}
        {isStdio && (
          <Descriptions.Item label={t('mcp_detail_conn_field_workdir')}>{detail.work_dir || '-'}</Descriptions.Item>
        )}
        {!isStdio && (
          <Descriptions.Item label={t('mcp_detail_conn_field_server_auth')}>
            {serverAuthCode
              ? <Text code>{serverAuthCode}</Text>
              : <Text type="secondary">{t('mcp_detail_unconfigured')}</Text>}
          </Descriptions.Item>
        )}
        {isStdio && (
          <Descriptions.Item label={t('mcp_detail_conn_field_resource')}>
            {connectionCode ? (
              <Text code>{connectionCode}</Text>
            ) : missingRequiredBinding ? (
              <Tag color="error">{t('mcp_detail_conn_incomplete_msg')}</Tag>
            ) : (
              <Text type="secondary">{t('mcp_detail_unconfigured')}</Text>
            )}
          </Descriptions.Item>
        )}

        <Descriptions.Item label={t('mcp_detail_conn_field_runtime')}>
          {runtimeKeys.length === 0 ? (
            <Text type="secondary">-</Text>
          ) : runtimeKeys.filter((k) => !isIllegalEnvKey(k)).length === 0 ? (
            <Text type="secondary">{t('mcp_detail_conn_runtime_no_legal')}</Text>
          ) : (
            <Space size={4} wrap>
              {runtimeKeys.filter((k) => !isIllegalEnvKey(k)).map((k) => (
                <Tag key={k}>{k}</Tag>
              ))}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_last_result')}>
          {missingRequiredBinding ? (
            // Spec section 七 § 7 + 二 § 3: never show "正常" health on
            // a server with incomplete external-connection binding —
            // the green tag would mislead admins; the server can't
            // actually serve calls until they bind a connection.
            <Tag color="error">{t('mcp_health_incomplete')}</Tag>
          ) : (
            healthTag(detail.health_status)
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_last_resp')}>
          {detail.last_response_time != null ? `${detail.last_response_time} ms` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_last_test_at')}>{fmt(detail.last_checked_at)}</Descriptions.Item>
        <Descriptions.Item label={t('mcp_detail_conn_field_sync_status')}>
          {detail.last_sync_status
            ? <Tag color={
                detail.last_sync_status === 'success' ? 'success'
                : detail.last_sync_status === 'partial_success' ? 'warning'
                : 'error'
              }>{
                detail.last_sync_status === 'success' ? t('mcp_detail_conn_sync_success')
                : detail.last_sync_status === 'partial_success' ? t('mcp_detail_conn_sync_partial')
                : t('mcp_detail_conn_sync_failed')
              }</Tag>
            : <Text type="secondary">{t('mcp_detail_conn_sync_never')}</Text>}
        </Descriptions.Item>
        {detail.last_sync_error_message && (
          <Descriptions.Item label={t('mcp_detail_conn_field_sync_error')}>
            <Text type="warning">{detail.last_sync_error_message}</Text>
          </Descriptions.Item>
        )}
      </Descriptions>
    </Card>
  )
}

// ── Tab 3: 能力 (Capabilities + Resources + Prompts) ─────────────────

interface MCPCapability {
  id: string
  capability_name: string
  description?: string
  input_schema?: any
  output_schema?: any
  input_params?: string[]
  status: 'active' | 'inactive'
  authorization_mode?: 'required' | 'public'
  quota_enabled?: boolean
  quota_period?: string | null
  quota_limit?: number | null
  rate_limit?: number | null
  last_synced_at?: string | null
  last_called_at?: string | null
}

interface BlacklistEntry {
  id: string
  mcp_capability_id: string
  principal_type: string
  principal_id: string
  principal_name?: string | null
  reason?: string | null
  created_at: string
}

const CapabilitiesTab: React.FC<{
  serverId: string
  /** Called after a successful test-invoke so the call-log tab can refresh. */
  onCallLogged?: () => void
  /** Bumped by the parent after a capability sync so the table re-fetches. */
  reloadKey?: number
}> = ({ serverId, onCallLogged, reloadKey }) => {
  const { t } = useTranslation()
  const [caps, setCaps] = useState<MCPCapability[]>([])
  const [resources, setResources] = useState<any[]>([])
  const [prompts, setPrompts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [invoking, setInvoking] = useState<MCPCapability | null>(null)
  const [invokeForm] = Form.useForm()
  const [invokeBusy, setInvokeBusy] = useState(false)
  const [invokeResult, setInvokeResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  // 每个能力一个「管理」抽屉:详情 / 授权模式 / 限额 / 授权调用方
  const [manageCap, setManageCap] = useState<MCPCapability | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [capRes, resRes, promptRes] = await Promise.all([
        api.get<{ items: MCPCapability[] }>(`/mcp-servers/${serverId}/capabilities`),
        api.get<{ items: any[] }>(`/mcp-servers/${serverId}/resources`).catch(() => ({ items: [] })),
        api.get<{ items: any[] }>(`/mcp-servers/${serverId}/prompts`).catch(() => ({ items: [] })),
      ])
      setCaps(capRes.items || [])
      setResources(resRes.items || [])
      setPrompts(promptRes.items || [])
    } catch (e: any) {
      setError(e?.response?.data?.detail || t('mcp_detail_cap_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [serverId, t])

  useEffect(() => { reload() }, [reload, reloadKey])

  const doInvoke = async () => {
    if (!invoking) return
    setInvokeBusy(true)
    setInvokeResult(null)
    try {
      const argsRaw = invokeForm.getFieldValue('arguments') || '{}'
      let parsed: any
      try { parsed = JSON.parse(argsRaw) }
      catch { message.error(t('mcp_detail_invoke_args_json_invalid')); setInvokeBusy(false); return }
      const res = await api.post<any>(
        `/mcp-servers/${serverId}/capabilities/${invoking.id}/test-invoke`,
        { arguments: parsed },
      )
      setInvokeResult(res)
      if (res.result === 'success') {
        message.success(t('mcp_detail_invoke_msg_ok', { ms: res.response_time_ms }))
      } else {
        message.error(t('mcp_detail_invoke_msg_fail', {
          message: res.error_message || res.error_type || '',
        }))
      }
      onCallLogged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_invoke_msg_error'))
    } finally {
      setInvokeBusy(false)
    }
  }

  // 行内最多 3 行 + 末尾省略号(hover/click 整 cell 看全文 via title)。
  // 用 -webkit-line-clamp:多行截断的浏览器原生方案,所有现代浏览器都支持。
  const clamp3: React.CSSProperties = {
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  }

  const capColumns = [
    // 能力名:短(get_file_profile)和长(server.tool)都要兼容。
    // 200px + 允许换行 + 复制按钮,够用。
    { title: t('mcp_detail_cap_col_name'), dataIndex: 'capability_name', key: 'name', width: 200,
      render: (v: string) => (
        <Text strong copyable={{ text: v, tooltips: [t('mcp_detail_cap_copy'), t('mcp_detail_cap_copied')] }}
              style={{ wordBreak: 'break-all' }}>{v}</Text>
      ) },
    // 描述:大头,360px;限 3 行,溢出省略;title 属性 hover 看全文。
    { title: t('mcp_detail_cap_col_description'), dataIndex: 'description', key: 'description', width: 360,
      render: (v?: string) => (
        <div style={clamp3} title={v || ''}>
          <Text type={v ? undefined : 'secondary'}>{v || '-'}</Text>
        </div>
      ) },
    { title: t('mcp_detail_cap_col_status'), dataIndex: 'status', key: 'status', width: 80, render: capabilityStatusTag },
    // 入参列显示参数名摘要(带 * 的为必填);完整 JSON Schema 在「管理」抽屉里。
    // 出参列已移除:MCP 协议的工具发现基本不提供 outputSchema,该列永远为空。
    { title: t('mcp_detail_cap_col_input_schema'), dataIndex: 'input_params', key: 'input_params', width: 200,
      render: (v?: string[]) => (v && v.length > 0)
        ? <Space size={4} wrap>{v.map((p) => <Tag key={p} style={{ marginRight: 0 }}>{p}</Tag>)}</Space>
        : <Text type="secondary">-</Text> },
    {
      title: t('mcp_detail_cap_col_auth_mode'), dataIndex: 'authorization_mode', key: 'auth_mode', width: 100,
      render: (v?: string) => (v || 'required') === 'public'
        ? <Tag color="green">{t('mcp_detail_cap_mode_public')}</Tag>
        : <Tag color="blue">{t('mcp_detail_cap_mode_required')}</Tag>,
    },
    {
      title: t('mcp_detail_cap_col_quota'), key: 'quota', width: 140,
      render: (_: any, r: MCPCapability) => {
        const parts: React.ReactNode[] = []
        if (r.quota_enabled && r.quota_limit != null) {
          parts.push(<Tag key="t">{t('mcp_detail_cap_quota_total', { value: quotaText(r.quota_limit, r.quota_period) })}</Tag>)
        }
        if (r.rate_limit != null) {
          parts.push(<Tag key="r" color="orange">{t('mcp_detail_cap_quota_rate', { n: r.rate_limit })}</Tag>)
        }
        return parts.length ? <Space size={4}>{parts}</Space> : <Text type="secondary">{t('mcp_detail_cap_quota_unlimited')}</Text>
      },
    },
    { title: t('mcp_detail_cap_col_last_synced'), dataIndex: 'last_synced_at', key: 'last_synced_at', width: 150, render: fmt },
    { title: t('mcp_detail_cap_col_last_called'), dataIndex: 'last_called_at', key: 'last_called_at', width: 150, render: fmt },
    {
      title: t('mcp_detail_cap_col_actions'),
      key: 'actions',
      width: 170,
      fixed: 'right' as const,
      render: (_: any, row: MCPCapability) => (
        <Space size="small">
          <Button
            size="small"
            type="primary"
            disabled={row.status !== 'active'}
            onClick={() => {
              setInvoking(row)
              invokeForm.setFieldsValue({ arguments: '{}' })
              setInvokeResult(null)
            }}
          >{t('mcp_detail_cap_btn_invoke')}</Button>
          <Button size="small" onClick={() => setManageCap(row)}>{t('mcp_detail_cap_btn_manage')}</Button>
        </Space>
      ),
    },
  ]

  const resColumns = [
    { title: t('mcp_detail_res_col_name'), dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
    { title: t('mcp_detail_res_col_uri'), dataIndex: 'uri', key: 'uri', width: 280, ellipsis: true,
      render: (v: string) => <Text code style={{ whiteSpace: 'nowrap' }}>{v}</Text> },
    { title: t('mcp_detail_res_col_mime'), dataIndex: 'mime_type', key: 'mime_type', width: 130, render: (v?: string) => v || '-' },
    { title: t('mcp_detail_res_col_description'), dataIndex: 'description', key: 'description', width: 240, ellipsis: true,
      render: (v?: string) => v || '-' },
    { title: t('mcp_detail_res_col_status'), dataIndex: 'status', key: 'status', width: 90, render: capabilityStatusTag },
    { title: t('mcp_detail_res_col_last_synced'), dataIndex: 'last_synced_at', key: 'last_synced_at', width: 170, render: fmt },
  ]

  const promptColumns = [
    { title: t('mcp_detail_prompt_col_name'), dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
    { title: t('mcp_detail_prompt_col_scene'), dataIndex: 'scene', key: 'scene', width: 150, render: (v?: string) => v || '-' },
    {
      title: t('mcp_detail_prompt_col_args'), dataIndex: 'arguments_json', key: 'args', width: 240, ellipsis: true,
      render: (v?: any) => v && v.length > 0
        ? <Text code style={{ whiteSpace: 'nowrap' }}>{jsonPreview(v)}</Text> : '-',
    },
    { title: t('mcp_detail_prompt_col_description'), dataIndex: 'description', key: 'description', width: 240, ellipsis: true,
      render: (v?: string) => v || '-' },
    { title: t('mcp_detail_prompt_col_status'), dataIndex: 'status', key: 'status', width: 90, render: capabilityStatusTag },
    { title: t('mcp_detail_prompt_col_last_synced'), dataIndex: 'last_synced_at', key: 'last_synced_at', width: 170, render: fmt },
  ]

  if (error) {
    return <Result status="error" title={t('mcp_detail_cap_load_failed')} subTitle={error} extra={<Button onClick={reload}>{t('mcp_detail_retry')}</Button>} />
  }

  return (
    <Spin spinning={loading}>
      <Card title={t('mcp_detail_cap_card_title')} style={{ marginBottom: 12 }} extra={<Button size="small" icon={<ReloadOutlined />} onClick={reload}>{t('mcp_detail_refresh')}</Button>}>
        <Table
          rowKey="id"
          size="small"
          dataSource={caps}
          columns={capColumns}
          pagination={false}
          scroll={{ x: 1600 }}
          locale={{ emptyText: <Empty description={t('mcp_detail_cap_empty')} /> }}
        />
      </Card>

      <Card title={t('mcp_detail_cap_resources_title')} style={{ marginBottom: 12 }}>
        <Table
          rowKey="id"
          size="small"
          dataSource={resources}
          columns={resColumns}
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: <Empty description={t('mcp_detail_cap_resources_empty')} /> }}
        />
      </Card>

      <Card title={t('mcp_detail_cap_prompts_title')}>
        <Table
          rowKey="id"
          size="small"
          dataSource={prompts}
          columns={promptColumns}
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: <Empty description={t('mcp_detail_cap_prompts_empty')} /> }}
        />
      </Card>

      {/* Test invoke modal */}
      <Modal
        open={!!invoking}
        title={t('mcp_detail_invoke_title', { name: invoking?.capability_name || '' })}
        onCancel={() => setInvoking(null)}
        footer={
          <Space>
            <Button onClick={() => setInvoking(null)}>{t('mcp_detail_invoke_close')}</Button>
            <Button type="primary" loading={invokeBusy} onClick={doInvoke}>{t('mcp_detail_invoke_call')}</Button>
          </Space>
        }
        width={720}
      >
        <Form form={invokeForm} layout="vertical">
          <Form.Item label={t('mcp_detail_invoke_args_label')} name="arguments" extra={t('mcp_detail_invoke_args_extra')}>
            <Input.TextArea rows={6} placeholder='{"key": "value"}' />
          </Form.Item>
        </Form>
        {invokeResult && (
          <Card size="small" type="inner" title={t('mcp_detail_invoke_result_title')}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label={t('mcp_detail_invoke_result_label')}>
                <Tag color={invokeResult.result === 'success' ? 'success' : 'error'}>
                  {invokeResult.result === 'success' ? t('mcp_detail_invoke_result_success') : t('mcp_detail_invoke_result_failed')}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('mcp_detail_invoke_duration')}>{invokeResult.response_time_ms} ms</Descriptions.Item>
              <Descriptions.Item label={t('mcp_detail_invoke_output')}>
                <pre style={{ margin: 0, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
                  {invokeResult.output_summary || '-'}
                </pre>
              </Descriptions.Item>
              {invokeResult.error_message && (
                <Descriptions.Item label={t('mcp_detail_invoke_error')}>
                  <Text type="danger">{invokeResult.error_message}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>
        )}
      </Modal>

      {/* 能力管理抽屉:详情 / 授权模式 / 限额 / 授权调用方 */}
      <CapabilityManageDrawer
        serverId={serverId}
        capability={manageCap}
        onClose={() => setManageCap(null)}
        onSaved={reload}
      />
    </Spin>
  )
}// ── 能力管理抽屉:授权 / 模式 / 限额 (spec §7) ──────────────────────────
//
// 「授权调用方」不再单独占一个 Tab —— 每个能力一个「管理」抽屉
// (CapabilityManageDrawer),内含:能力详情 / 授权模式 / 限额 / 授权调用方。
// required 模式默认拒绝;public 模式靠黑名单排除。
//
// APIs:
//   GET    /mcp-servers/{sid}/authorization-summary    — 按能力汇总
//   GET    /mcp-servers/{sid}/authorized-principals    — 授权列表
//   POST   /mcp-servers/{sid}/authorized-principals    — 新增授权
//   PATCH  .../authorized-principals/{aid}             — 编辑
//   POST   .../authorized-principals/{aid}/enable|disable
//   DELETE .../authorized-principals/{aid}             — 删除(软删)
//   PATCH  /mcp-servers/{sid}/capabilities/{cid}/quota — 能力总限额 + 速率
//   PATCH  .../capabilities/{cid}/authorization-mode   — 授权模式
//   GET/POST/DELETE .../capabilities/{cid}/blacklist   — 公开模式黑名单

interface AuthorizationItem {
  authorization_id: string
  principal_type: string
  principal_id: string
  principal_name?: string
  mcp_capability_id: string
  mcp_capability_name: string
  capability_status?: string
  enabled: boolean
  quota_period?: string | null
  allocated_quota?: number | null
  quota_used: number
  quota_remaining?: number | null
  parameter_mapping_json?: Record<string, any> | null
  parameter_defaults_json?: Record<string, any> | null
  created_at: string
  updated_at: string
}

interface CapSummary {
  mcp_capability_id: string
  name: string
  status: string
  authorization_mode?: 'required' | 'public'
  quota_enabled: boolean
  quota_period?: string | null
  quota_limit?: number | null
  quota_used: number
  quota_reset_at?: string | null
  authorized_quota_sum: number
  remaining_authorizable_quota?: number | null
  authorized_principal_count: number
}

interface PrincipalOption { id: string; name: string }

// Quota-period values; labels come from i18n (mcp_detail_period_<value>).
const PERIOD_VALUES = ['minute', 'hour', 'day', 'month']
const periodLabel = (v?: string | null): string =>
  v ? i18n.t(`mcp_detail_period_${v}`, { defaultValue: v }) : ''
/** Period <Select> options, rebuilt at render so they follow the language. */
const periodOptions = () => PERIOD_VALUES.map(v => ({ value: v, label: periodLabel(v) }))

// First-version principal types the UI offers. workflow / system_job
// are reserved on the backend but not surfaced here yet. Labels are
// product names (AI Tool / Agent) — same across locales, not translated.
const PRINCIPAL_TYPES = [
  { value: 'ai_tool', label: 'AI Tool' },
  { value: 'agent', label: 'Agent' },
]
const PRINCIPAL_TYPE_LABEL: Record<string, string> =
  Object.fromEntries(PRINCIPAL_TYPES.map(p => [p.value, p.label]))

function quotaText(limit?: number | null, period?: string | null): string {
  if (limit == null) return '-'
  return `${limit}/${periodLabel(period)}`
}

// Per-capability management drawer opened from the 能力 Tab's 「管理」 button.
// One place for: 能力详情 / 授权模式(+黑名单) / 限额(总量+速率) / 授权调用方.
// Scoped to a single capability — the authorization list/summary are fetched
// server-wide then filtered to this capability id.
const CapabilityManageDrawer: React.FC<{
  serverId: string
  /** null = closed. The capability row object opened from the 能力 table. */
  capability: MCPCapability | null
  onClose: () => void
  /** Reload the capability table after mode / quota changes. */
  onSaved: () => void
}> = ({ serverId, capability, onClose, onSaved }) => {
  const { t } = useTranslation()
  const open = !!capability
  const capId = capability?.id || ''
  const capName = capability?.capability_name || ''

  const [aiTools, setAiTools] = useState<PrincipalOption[]>([])
  const [agents, setAgents] = useState<PrincipalOption[]>([])
  const [modeValue, setModeValue] = useState<'required' | 'public'>('required')
  const [modeSaving, setModeSaving] = useState(false)
  const [blacklist, setBlacklist] = useState<BlacklistEntry[]>([])
  const [blAddForm] = Form.useForm()
  const [quotaForm] = Form.useForm()
  const [quotaSaving, setQuotaSaving] = useState(false)
  const [authz, setAuthz] = useState<AuthorizationItem[]>([])
  const [capSummary, setCapSummary] = useState<CapSummary | null>(null)
  const [loading, setLoading] = useState(false)
  // 参数补丁(schema overrides):三层展示 + 编辑
  const [capDetail, setCapDetail] = useState<MCPCapability | null>(null)
  const [ovrText, setOvrText] = useState('')
  const [ovrSaving, setOvrSaving] = useState(false)

  const loadCapDetail = useCallback(async () => {
    if (!capId) return
    try {
      const d = await api.get<MCPCapability & { schema_overrides?: any; effective_input_schema?: any }>(
        `/mcp-servers/${serverId}/capabilities/${capId}`)
      setCapDetail(d)
      const params = (d as any).schema_overrides?.params || {}
      const editable: Record<string, any> = {}
      Object.entries(params).forEach(([k, v]: [string, any]) => {
        editable[k] = { ...(v.description ? { description: v.description } : {}), ...(v.type ? { type: v.type } : {}) }
      })
      setOvrText(Object.keys(editable).length ? JSON.stringify(editable, null, 2) : '')
    } catch { setCapDetail(null) }
  }, [serverId, capId])

  const saveOverrides = async () => {
    let params: any = {}
    if (ovrText.trim()) {
      try { params = JSON.parse(ovrText) } catch { message.error(t('mcp_ovr_invalid_json')); return }
    }
    setOvrSaving(true)
    try {
      await api.put(`/mcp-servers/${serverId}/capabilities/${capId}/schema-overrides`, { params })
      message.success(t('mcp_ovr_saved'))
      await loadCapDetail()
    } catch (e: any) {
      message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || String(e))
    } finally { setOvrSaving(false) }
  }

  // authz create / edit modal
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [editing, setEditing] = useState<AuthorizationItem | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const watchedPrincipalType = Form.useWatch('principal_type', form)

  const loadPrincipals = useCallback(async () => {
    const [toolRes, agentRes] = await Promise.all([
      api.get<{ tools: { id?: string; name: string }[] }>('/tools'),
      api.get<{ items: { id: string; name: string }[] }>('/agents', { params: { size: 200 } })
        .catch(() => ({ items: [] as { id: string; name: string }[] })),
    ])
    setAiTools((toolRes.tools || []).filter(t => !!t.id).map(t => ({ id: t.id as string, name: t.name })))
    setAgents((agentRes.items || []).map(a => ({ id: a.id, name: a.name })))
  }, [])

  React.useEffect(() => { if (open) loadCapDetail() }, [open, loadCapDetail])

  const reload = useCallback(async () => {
    if (!capId) return
    setLoading(true)
    try {
      const [sumRes, authRes, blRes] = await Promise.all([
        api.get<{ capabilities: CapSummary[] }>(`/mcp-servers/${serverId}/authorization-summary`),
        api.get<{ items: AuthorizationItem[] }>(`/mcp-servers/${serverId}/authorized-principals`),
        api.get<{ items: BlacklistEntry[] }>(`/mcp-servers/${serverId}/capabilities/${capId}/blacklist`)
          .catch(() => ({ items: [] as BlacklistEntry[] })),
      ])
      setCapSummary((sumRes.capabilities || []).find(c => c.mcp_capability_id === capId) || null)
      setAuthz((authRes.items || []).filter(a => a.mcp_capability_id === capId))
      setBlacklist(blRes.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [serverId, capId, t])

  // Re-init when a capability is opened. Guard on capability so the effect is
  // a no-op while the drawer is closed.
  useEffect(() => {
    if (!capability) return
    setModeValue((capability.authorization_mode || 'required') as 'required' | 'public')
    quotaForm.setFieldsValue({
      enabled: !!capability.quota_enabled,
      limit: capability.quota_limit ?? undefined,
      period: capability.quota_period || undefined,
      rate_limit: capability.rate_limit ?? undefined,
    })
    blAddForm.resetFields()
    blAddForm.setFieldsValue({ principal_type: 'ai_tool' })
    loadPrincipals().catch(() => message.error(t('mcp_detail_mgr_load_principals_failed')))
    reload()
  }, [capability, quotaForm, blAddForm, loadPrincipals, reload, t])

  // ── 授权模式 ──
  const switchMode = async (next: 'required' | 'public') => {
    setModeSaving(true)
    try {
      await api.patch(`/mcp-servers/${serverId}/capabilities/${capId}/authorization-mode`, { mode: next })
      setModeValue(next)
      if (next === 'public') reload()
      else setBlacklist([])
      message.success(t('mcp_detail_mgr_mode_switched', {
        mode: next === 'public' ? t('mcp_detail_mgr_mode_public_label') : t('mcp_detail_mgr_mode_required_label'),
      }))
      onSaved()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_mode_switch_failed'))
    } finally {
      setModeSaving(false)
    }
  }

  const submitBlacklist = async () => {
    try {
      const v = await blAddForm.validateFields()
      await api.post(`/mcp-servers/${serverId}/capabilities/${capId}/blacklist`, v)
      blAddForm.resetFields()
      blAddForm.setFieldsValue({ principal_type: 'ai_tool' })
      reload()
      message.success(t('mcp_detail_mgr_blacklist_added'))
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_blacklist_add_failed'))
    }
  }

  const removeBlacklist = async (id: string) => {
    try {
      await api.delete(`/mcp-servers/${serverId}/capabilities/${capId}/blacklist/${id}`)
      reload()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_delete_failed'))
    }
  }

  // ── 限额(总量 + 速率) ──
  const submitQuota = async () => {
    try {
      const v = await quotaForm.validateFields()
      setQuotaSaving(true)
      await api.patch(`/mcp-servers/${serverId}/capabilities/${capId}/quota`, {
        enabled: !!v.enabled,
        limit: v.enabled ? v.limit : null,
        period: v.enabled ? v.period : null,
        rate_limit: v.rate_limit || null,
      })
      message.success(t('mcp_detail_mgr_quota_updated'))
      reload()
      onSaved()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_quota_save_failed'))
    } finally {
      setQuotaSaving(false)
    }
  }

  // ── 授权调用方 ──
  const principalOptions = watchedPrincipalType === 'agent' ? agents : aiTools
  const allocCeiling: number | undefined = capSummary?.quota_enabled
    ? (capSummary.remaining_authorizable_quota ?? 0) + (formMode === 'edit' ? (editing?.allocated_quota || 0) : 0)
    : undefined

  const openCreate = () => {
    form.resetFields()
    form.setFieldsValue({ enabled: true, principal_type: 'ai_tool' })
    setFormMode('create'); setEditing(null); setFormOpen(true)
  }
  const openEdit = (row: AuthorizationItem) => {
    form.resetFields()
    form.setFieldsValue({
      principal_type: row.principal_type,
      principal_id: row.principal_id,
      enabled: row.enabled,
      allocated_quota: row.allocated_quota ?? undefined,
      quota_period: row.quota_period || undefined,
      parameter_mapping_json: JSON.stringify(row.parameter_mapping_json || {}, null, 2),
      parameter_defaults_json: JSON.stringify(row.parameter_defaults_json || {}, null, 2),
    })
    setFormMode('edit'); setEditing(row); setFormOpen(true)
  }
  const submitAuthz = async () => {
    try {
      const v = await form.validateFields()
      const parseJSON = (s: string | undefined, label: string): any => {
        if (!s || !s.trim()) return undefined
        try { return JSON.parse(s) }
        catch { throw new Error(t('mcp_detail_mgr_authz_json_invalid', { label })) }
      }
      let mapping: any, defaults: any
      try {
        mapping = parseJSON(v.parameter_mapping_json, t('mcp_detail_mgr_authz_label_mapping'))
        defaults = parseJSON(v.parameter_defaults_json, t('mcp_detail_mgr_authz_label_defaults'))
      } catch (e: any) { message.error(e.message); return }
      setSaving(true)
      if (formMode === 'create') {
        await api.post(`/mcp-servers/${serverId}/authorized-principals`, {
          principal_type: v.principal_type,
          principal_id: v.principal_id,
          mcp_capability_id: capId,
          enabled: v.enabled,
          allocated_quota: v.allocated_quota ?? null,
          quota_period: v.quota_period || null,
          parameter_mapping_json: mapping,
          parameter_defaults_json: defaults,
        })
        message.success(t('mcp_detail_mgr_authz_created'))
      } else if (editing) {
        await api.patch(`/mcp-servers/${serverId}/authorized-principals/${editing.authorization_id}`, {
          enabled: v.enabled,
          allocated_quota: v.allocated_quota ?? null,
          quota_period: v.quota_period || null,
          parameter_mapping_json: mapping,
          parameter_defaults_json: defaults,
        })
        message.success(t('mcp_detail_mgr_authz_updated'))
      }
      setFormOpen(false)
      reload()
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_authz_save_failed'))
    } finally {
      setSaving(false)
    }
  }
  const toggleAuthz = async (row: AuthorizationItem) => {
    const action = row.enabled ? 'disable' : 'enable'
    try {
      await api.post(`/mcp-servers/${serverId}/authorized-principals/${row.authorization_id}/${action}`, {})
      message.success(t(row.enabled ? 'mcp_detail_mgr_authz_disabled' : 'mcp_detail_mgr_authz_enabled'))
      reload()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_mgr_authz_action_error'))
    }
  }
  const revokeAuthz = (row: AuthorizationItem) => {
    Modal.confirm({
      title: t('mcp_detail_mgr_authz_revoke_title', { name: row.principal_name || row.principal_id }),
      content: t('mcp_detail_mgr_authz_revoke_content'),
      okText: t('mcp_detail_mgr_authz_revoke_ok'), okType: 'danger',
      cancelText: t('mcp_detail_mgr_authz_revoke_cancel'),
      onOk: async () => {
        try {
          await api.delete(`/mcp-servers/${serverId}/authorized-principals/${row.authorization_id}`)
          message.success(t('mcp_detail_mgr_authz_revoked'))
          reload()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('mcp_detail_mgr_delete_failed'))
        }
      },
    })
  }

  const authzColumns = [
    { title: t('mcp_detail_mgr_authz_col_ptype'), dataIndex: 'principal_type', key: 'ptype', width: 100,
      render: (v: string) => <Tag>{PRINCIPAL_TYPE_LABEL[v] || v}</Tag> },
    { title: t('mcp_detail_mgr_authz_col_principal'), dataIndex: 'principal_name', key: 'pname', ellipsis: true,
      render: (v: string | undefined, r: AuthorizationItem) => v || r.principal_id },
    { title: t('mcp_detail_mgr_authz_col_status'), dataIndex: 'enabled', key: 'enabled', width: 80,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('mcp_detail_mgr_authz_status_active') : t('mcp_detail_mgr_authz_status_disabled')}</Tag> },
    { title: t('mcp_detail_mgr_authz_col_alloc'), dataIndex: 'allocated_quota', key: 'alloc', width: 90, align: 'right' as const,
      render: (v?: number | null) => v == null ? t('mcp_detail_mgr_authz_alloc_unlimited') : v },
    { title: t('mcp_detail_mgr_authz_col_used'), dataIndex: 'quota_used', key: 'used', width: 70, align: 'right' as const,
      render: (v: number) => v ?? 0 },
    { title: t('mcp_detail_mgr_authz_col_period'), dataIndex: 'quota_period', key: 'period', width: 80,
      render: (v?: string | null) => v ? periodLabel(v) : '-' },
    { title: t('mcp_detail_mgr_authz_col_actions'), key: 'act', width: 180,
      render: (_: any, r: AuthorizationItem) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>{t('mcp_detail_mgr_authz_edit')}</Button>
          <Button size="small" onClick={() => toggleAuthz(r)}>{r.enabled ? t('mcp_detail_mgr_authz_disable') : t('mcp_detail_mgr_authz_enable')}</Button>
          <Button size="small" danger onClick={() => revokeAuthz(r)}>{t('mcp_detail_mgr_delete')}</Button>
        </Space>
      ) },
  ]

  const quotaAlert = capSummary?.quota_enabled ? (
    <Alert type="info" showIcon style={{ marginBottom: 12 }}
      message={<Space size={16} wrap>
        <span>{t('mcp_detail_mgr_authz_quota_alert_total')} <b>{quotaText(capSummary.quota_limit, capSummary.quota_period)}</b></span>
        <span>{t('mcp_detail_mgr_authz_quota_alert_authorized')} <b>{capSummary.authorized_quota_sum}</b></span>
        <span style={{ color: (allocCeiling ?? 0) > 0 ? '#3f8600' : '#cf1322' }}>
          {t('mcp_detail_mgr_authz_quota_alert_ceiling')} <b>{allocCeiling ?? 0}</b></span>
      </Space>} />
  ) : (
    <Alert type="warning" showIcon style={{ marginBottom: 12 }}
      message={t('mcp_detail_mgr_authz_quota_disabled_msg')}
      description={t('mcp_detail_mgr_authz_quota_disabled_desc')} />
  )

  const collapseItems = [
    {
      key: 'detail',
      label: t('mcp_detail_mgr_section_detail'),
      children: capability ? (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_name')}>{capability.capability_name}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_description')}>{capability.description || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_status')}>{capabilityStatusTag(capability.status)}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_input_schema')}>
            <pre style={{ margin: 0, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify((capDetail as any)?.input_schema ?? capability.input_schema ?? null, null, 2)}</pre>
          </Descriptions.Item>
          <Descriptions.Item label={t('mcp_ovr_effective_schema')}>
            <pre style={{ margin: 0, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify((capDetail as any)?.effective_input_schema ?? capability.input_schema, null, 2)}</pre>
          </Descriptions.Item>
          <Descriptions.Item label={t('mcp_ovr_editor_label')}>
            <div>
              <Space wrap style={{ marginBottom: 6 }}>
                {Object.entries(((capDetail as any)?.schema_overrides?.params) || {}).map(([k, v]: [string, any]) => (
                  <Tag key={k} color={v.status === 'active' ? 'green' : 'orange'}>
                    {k}: {v.status === 'active' ? t('mcp_ovr_status_active')
                      : v.status === 'stale_param_missing' ? t('mcp_ovr_status_param_missing')
                      : t('mcp_ovr_status_upstream_changed')}
                  </Tag>
                ))}
              </Space>
              <Input.TextArea
                rows={5}
                value={ovrText}
                onChange={(e) => setOvrText(e.target.value)}
                placeholder={t('mcp_ovr_placeholder')}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('mcp_ovr_hint')}</Text>
                <Button size="small" type="primary" loading={ovrSaving} onClick={saveOverrides}>
                  {t('mcp_ovr_save')}
                </Button>
              </div>
            </div>
          </Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_last_synced')}>{fmt(capability.last_synced_at)}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_mgr_detail_last_called')}>{fmt(capability.last_called_at)}</Descriptions.Item>
        </Descriptions>
      ) : null,
    },
    {
      key: 'mode',
      label: t('mcp_detail_mgr_section_mode'),
      children: (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <Switch
              checkedChildren={t('mcp_detail_mgr_mode_required_label')} unCheckedChildren={t('mcp_detail_mgr_mode_public_label')}
              checked={modeValue === 'required'} loading={modeSaving}
              onChange={(c) => switchMode(c ? 'required' : 'public')}
            />
            <Text type="secondary">
              {modeValue === 'required'
                ? t('mcp_detail_mgr_mode_required_hint')
                : t('mcp_detail_mgr_mode_public_hint')}
            </Text>
          </div>
          {modeValue === 'public' && (
            <Card title={t('mcp_detail_mgr_blacklist_title')} size="small">
              <Form form={blAddForm} layout="inline" onFinish={submitBlacklist}
                style={{ marginBottom: 12, flexWrap: 'wrap', rowGap: 8 }}>
                <Form.Item name="principal_type" rules={[{ required: true }]} initialValue="ai_tool">
                  <Select style={{ width: 110 }} options={PRINCIPAL_TYPES} />
                </Form.Item>
                <Form.Item shouldUpdate={(p, c) => p.principal_type !== c.principal_type} noStyle>
                  {({ getFieldValue }) => (
                    <Form.Item name="principal_id" rules={[{ required: true, message: t('mcp_detail_mgr_blacklist_select_required') }]}>
                      <Select style={{ width: 200 }} showSearch placeholder={t('mcp_detail_mgr_blacklist_select_principal')} optionFilterProp="label"
                        options={(getFieldValue('principal_type') === 'agent' ? agents : aiTools)
                          .map(p => ({ value: p.id, label: p.name }))} />
                    </Form.Item>
                  )}
                </Form.Item>
                <Form.Item name="reason">
                  <Input placeholder={t('mcp_detail_mgr_blacklist_reason')} style={{ width: 180 }} maxLength={500} />
                </Form.Item>
                <Form.Item>
                  <Button type="primary" htmlType="submit">{t('mcp_detail_mgr_blacklist_add')}</Button>
                </Form.Item>
              </Form>
              <Table rowKey="id" size="small" dataSource={blacklist} pagination={false}
                locale={{ emptyText: <Empty description={t('mcp_detail_mgr_blacklist_empty')} /> }}
                columns={[
                  { title: t('mcp_detail_mgr_blacklist_col_type'), dataIndex: 'principal_type', width: 90,
                    render: (v: string) => <Tag>{PRINCIPAL_TYPE_LABEL[v] || v}</Tag> },
                  { title: t('mcp_detail_mgr_blacklist_col_principal'), dataIndex: 'principal_name', ellipsis: true,
                    render: (v: any, r: BlacklistEntry) => v || r.principal_id },
                  { title: t('mcp_detail_mgr_blacklist_col_reason'), dataIndex: 'reason', ellipsis: true, render: (v?: string) => v || '-' },
                  { title: t('mcp_detail_mgr_blacklist_col_actions'), key: 'act', width: 70,
                    render: (_: any, r: BlacklistEntry) => (
                      <Button size="small" danger onClick={() => removeBlacklist(r.id)}>{t('mcp_detail_mgr_delete')}</Button>) },
                ]} />
            </Card>
          )}
        </>
      ),
    },
    {
      key: 'quota',
      label: t('mcp_detail_mgr_section_quota'),
      children: (
        <Form form={quotaForm} layout="vertical">
          <Form.Item label={t('mcp_detail_mgr_quota_total_label')} name="enabled" valuePropName="checked"
            tooltip={t('mcp_detail_mgr_quota_total_tooltip')}>
            <Switch checkedChildren={t('mcp_detail_mgr_quota_enable')} unCheckedChildren={t('mcp_detail_mgr_quota_unlimited')} />
          </Form.Item>
          <Form.Item shouldUpdate={(p, c) => p.enabled !== c.enabled} noStyle>
            {({ getFieldValue }) => getFieldValue('enabled') ? (
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label={t('mcp_detail_mgr_quota_period')} name="period" rules={[{ required: true, message: t('mcp_detail_mgr_quota_period_required') }]}>
                    <Select options={periodOptions()} placeholder={t('mcp_detail_mgr_quota_period_placeholder')} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label={t('mcp_detail_mgr_quota_limit')} name="limit" rules={[{ required: true, message: t('mcp_detail_mgr_quota_limit_required') }]}>
                    <InputNumber min={1} style={{ width: '100%' }} placeholder={t('mcp_detail_mgr_quota_limit_placeholder')} />
                  </Form.Item>
                </Col>
              </Row>
            ) : null}
          </Form.Item>
          <Form.Item label={t('mcp_detail_mgr_quota_rate_label')} name="rate_limit"
            tooltip={t('mcp_detail_mgr_quota_rate_tooltip')}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder={t('mcp_detail_mgr_quota_rate_placeholder')} />
          </Form.Item>
          <Button type="primary" loading={quotaSaving} onClick={submitQuota}>{t('mcp_detail_mgr_quota_save')}</Button>
        </Form>
      ),
    },
    {
      key: 'authz',
      label: authz.length
        ? t('mcp_detail_mgr_section_authz_count', { count: authz.length })
        : t('mcp_detail_mgr_section_authz'),
      children: modeValue === 'public' ? (
        <Text type="secondary">{t('mcp_detail_mgr_authz_public_hint')}</Text>
      ) : (
        <>
          {quotaAlert}
          <div style={{ marginBottom: 12 }}>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>{t('mcp_detail_mgr_authz_add')}</Button>
          </div>
          <Table rowKey="authorization_id" size="small" dataSource={authz} columns={authzColumns}
            pagination={false} scroll={{ x: 720 }}
            locale={{ emptyText: <Empty description={t('mcp_detail_mgr_authz_empty')} /> }} />
        </>
      ),
    },
  ]

  return (
    <Drawer
      open={open}
      title={capName ? t('mcp_detail_mgr_drawer_title', { name: capName }) : t('mcp_detail_mgr_drawer_title_empty')}
      width={760}
      onClose={onClose}
      destroyOnClose
    >
      <Spin spinning={loading}>
        <Collapse defaultActiveKey={['detail', 'mode', 'quota', 'authz']} items={collapseItems} />
      </Spin>

      {/* 授权调用方 新增 / 编辑 */}
      <Modal
        open={formOpen}
        title={formMode === 'create'
          ? t('mcp_detail_mgr_authz_modal_create', { name: capName })
          : t('mcp_detail_mgr_authz_modal_edit', { name: editing?.principal_name || editing?.principal_id || '' })}
        onCancel={() => setFormOpen(false)} onOk={submitAuthz}
        confirmLoading={saving} okText={t('mcp_detail_mgr_authz_save')} cancelText={t('mcp_detail_mgr_authz_cancel')} width={600} destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Row gutter={12}>
            <Col span={10}>
              <Form.Item label={t('mcp_detail_mgr_authz_field_ptype')} name="principal_type"
                rules={[{ required: true, message: t('mcp_detail_mgr_authz_ptype_required') }]}>
                <Select disabled={formMode === 'edit'} options={PRINCIPAL_TYPES}
                  onChange={() => form.setFieldsValue({ principal_id: undefined })} />
              </Form.Item>
            </Col>
            <Col span={14}>
              <Form.Item label={t('mcp_detail_mgr_authz_field_principal')} name="principal_id"
                rules={[{ required: true, message: t('mcp_detail_mgr_authz_principal_required') }]}
                tooltip={formMode === 'edit' ? t('mcp_detail_mgr_authz_principal_locked') : undefined}>
                <Select disabled={formMode === 'edit'} showSearch optionFilterProp="label"
                  placeholder={watchedPrincipalType === 'agent' ? t('mcp_detail_mgr_authz_principal_ph_agent') : t('mcp_detail_mgr_authz_principal_ph_tool')}
                  options={principalOptions.map(p => ({ value: p.id, label: p.name }))} />
              </Form.Item>
            </Col>
          </Row>
          {quotaAlert}
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label={t('mcp_detail_mgr_authz_field_alloc')} name="allocated_quota"
                tooltip={t('mcp_detail_mgr_authz_alloc_tooltip')}
                rules={[{ validator: (_, val) => {
                  if (val == null || val === '') return Promise.resolve()
                  if (allocCeiling != null && val > allocCeiling) {
                    return Promise.reject(new Error(t('mcp_detail_mgr_authz_alloc_over', { max: allocCeiling })))
                  }
                  return Promise.resolve()
                } }]}>
                <InputNumber min={0} max={allocCeiling} disabled={!capSummary?.quota_enabled}
                  style={{ width: '100%' }}
                  placeholder={capSummary?.quota_enabled ? t('mcp_detail_mgr_authz_alloc_ph_range', { max: allocCeiling ?? 0 }) : t('mcp_detail_mgr_authz_alloc_ph_unlimited')} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mcp_detail_mgr_authz_field_period')} name="quota_period"
                tooltip={capSummary?.quota_enabled ? t('mcp_detail_mgr_authz_period_tooltip') : undefined}>
                <Select allowClear placeholder={t('mcp_detail_mgr_authz_field_period')} options={periodOptions()}
                  disabled={!!(capSummary?.quota_enabled && capSummary.quota_period)} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label={t('mcp_detail_mgr_authz_field_status')} name="enabled" valuePropName="checked"
            tooltip={t('mcp_detail_mgr_authz_status_tooltip')}>
            <Switch checkedChildren={t('mcp_detail_mgr_authz_status_active')} unCheckedChildren={t('mcp_detail_mgr_authz_status_disabled')} />
          </Form.Item>
          <Form.Item label={t('mcp_detail_mgr_authz_field_mapping')} name="parameter_mapping_json"
            tooltip={t('mcp_detail_mgr_authz_mapping_tooltip')}>
            <Input.TextArea rows={3} placeholder='{"query": "search_term"}' />
          </Form.Item>
          <Form.Item label={t('mcp_detail_mgr_authz_field_defaults')} name="parameter_defaults_json"
            tooltip={t('mcp_detail_mgr_authz_defaults_tooltip')}>
            <Input.TextArea rows={3} placeholder='{"limit": 50}' />
          </Form.Item>
        </Form>
      </Modal>
    </Drawer>
  )
}

// ── Tab 5: 健康监控 ───────────────────────────────────────────────────

interface HealthState {
  server_id: string
  health_status: string
  last_checked_at?: string | null
  last_response_time?: number | null
  last_sync_status?: string | null
  last_error_type?: string | null
  last_error_message?: string | null
  consecutive_failures: number
  last_recovered_at?: string | null
}

const HealthTab: React.FC<{ serverId: string; reloadKey: number }> = ({ serverId, reloadKey }) => {
  const { t } = useTranslation()
  const [state, setState] = useState<HealthState | null>(null)
  const [records, setRecords] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, r] = await Promise.all([
        api.get<HealthState>(`/mcp-servers/${serverId}/health`),
        api.get<{ total: number; items: any[] }>(
          `/mcp-servers/${serverId}/health-records`,
          { params: { offset: (page - 1) * size, limit: size } },
        ),
      ])
      setState(s)
      setRecords(r.items || [])
      setTotal(r.total || 0)
    } catch (e: any) {
      setError(e?.response?.data?.detail || t('mcp_detail_health_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [serverId, page, size, t])

  useEffect(() => { reload() }, [reload, reloadKey])

  if (error) {
    return <Result status="error" title={t('mcp_detail_health_load_failed')} subTitle={error} extra={<Button onClick={reload}>{t('mcp_detail_retry')}</Button>} />
  }

  const recordColumns = [
    { title: t('mcp_detail_health_col_checked_at'), dataIndex: 'checked_at', key: 'checked_at', width: 170, render: fmt },
    {
      title: t('mcp_detail_health_col_status'), dataIndex: 'status', key: 'status', width: 90,
      render: (s: string) => <Tag color={s === 'normal' ? 'success' : 'error'}>{s === 'normal' ? t('mcp_detail_health_status_normal') : t('mcp_detail_health_status_abnormal')}</Tag>,
    },
    { title: t('mcp_detail_health_col_resp'), dataIndex: 'response_time', key: 'rt', width: 110, render: (v?: number) => v != null ? `${v} ms` : '-' },
    {
      title: t('mcp_detail_health_col_result'), dataIndex: 'status', key: 'result', width: 80,
      render: (s: string) => s === 'normal' ? t('mcp_detail_health_result_success') : t('mcp_detail_health_result_failed'),
    },
    { title: t('mcp_detail_health_col_error_type'), dataIndex: 'error_type', key: 'et', width: 150, ellipsis: true, render: (v?: string) => v || '-' },
    { title: t('mcp_detail_health_col_error_msg'), dataIndex: 'error_message', key: 'em', width: 300, ellipsis: true, render: (v?: string) => v || '-' },
  ]

  return (
    <Spin spinning={loading}>
      <Card title={t('mcp_detail_health_card_state')} style={{ marginBottom: 12 }} extra={<Button size="small" icon={<ReloadOutlined />} onClick={reload}>{t('mcp_detail_refresh')}</Button>}>
        <Row gutter={12}>
          <Col xs={12} sm={6}><Statistic title={t('mcp_detail_health_stat_status')} valueRender={() => healthTag(state?.health_status)} value={state?.health_status || '-'} /></Col>
          <Col xs={12} sm={6}><Statistic title={t('mcp_detail_health_stat_failures')} value={state?.consecutive_failures ?? 0} valueStyle={{ color: (state?.consecutive_failures || 0) > 0 ? '#cf1322' : undefined }} /></Col>
          <Col xs={12} sm={6}><Statistic title={t('mcp_detail_health_stat_last_resp')} value={state?.last_response_time != null ? `${state.last_response_time} ms` : '-'} /></Col>
          <Col xs={12} sm={6}><Statistic title={t('mcp_detail_health_stat_sync')} value={state?.last_sync_status || '-'} /></Col>
        </Row>
        <Descriptions column={2} size="small" style={{ marginTop: 12 }}>
          <Descriptions.Item label={t('mcp_detail_health_desc_last_checked')}>{fmt(state?.last_checked_at)}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_health_desc_last_recovered')}>{fmt(state?.last_recovered_at)}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_health_desc_last_error_type')}>{state?.last_error_type || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('mcp_detail_health_desc_last_error_msg')}>{state?.last_error_message || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={t('mcp_detail_health_card_records')}>
        <Table
          rowKey="id"
          size="small"
          dataSource={records}
          columns={recordColumns}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description={t('mcp_detail_health_empty')} /> }}
          pagination={{
            current: page, pageSize: size, total,
            showSizeChanger: true,
            showTotal: (n) => t('mcp_server_list_pagination_total', { count: n }),
            onChange: (p, ps) => { setPage(p); setSize(ps) },
          }}
        />
      </Card>
    </Spin>
  )
}

// ── Tab 6: 调用日志 ───────────────────────────────────────────────────

const CallLogsTab: React.FC<{
  serverId: string
  /** Bumped from outside to trigger reload after a Capability test-invoke. */
  reloadKey: number
}> = ({ serverId, reloadKey }) => {
  const { t } = useTranslation()
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<any>({})
  const [pending, setPending] = useState<any>({})

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: any = { offset: (page - 1) * size, limit: size }
      if (filters.user_id) params.user_id = filters.user_id
      if (filters.ai_tool_id) params.ai_tool_id = filters.ai_tool_id
      if (filters.capability_id) params.capability_id = filters.capability_id
      if (filters.result) params.result = filters.result
      if (filters.invoke_type) params.invoke_type = filters.invoke_type
      if (filters.start) params.start = filters.start
      if (filters.end) params.end = filters.end
      const res = await api.get<{ total: number; items: any[] }>(
        `/mcp-servers/${serverId}/call-logs`, { params },
      )
      setItems(res.items || [])
      setTotal(res.total || 0)
    } catch (e: any) {
      setError(e?.response?.data?.detail || t('mcp_detail_calls_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [serverId, page, size, filters, t])

  useEffect(() => { reload() }, [reload, reloadKey])

  const onQuery = () => { setPage(1); setFilters({ ...pending }) }
  const onReset = () => { setPending({}); setPage(1); setFilters({}) }

  const columns = [
    { title: t('mcp_detail_calls_col_time'), dataIndex: 'called_at', key: 'called_at', render: fmt, width: 160 },
    { title: t('mcp_detail_calls_col_user'), dataIndex: 'user_name', key: 'user', width: 100, render: (v?: string) => v || '-' },
    { title: t('mcp_detail_calls_col_session'), dataIndex: 'session_id', key: 'session', width: 100,
      render: (v?: string) => v ? <Text code>{v.slice(0, 8)}…</Text> : '-' },
    { title: t('mcp_detail_calls_col_tool'), dataIndex: 'ai_tool_name', key: 'tool', width: 140, ellipsis: true,
      render: (v?: string) => v || <Text type="secondary">{t('mcp_detail_calls_tool_mcp_test')}</Text> },
    { title: t('mcp_detail_calls_col_server'), dataIndex: 'mcp_server_name', key: 'server', width: 140, ellipsis: true,
      render: (v?: string) => v || '-' },
    { title: t('mcp_detail_calls_col_capability'), dataIndex: 'mcp_capability_name', key: 'cap', width: 200, ellipsis: true },
    {
      title: t('mcp_detail_calls_col_invoke_type'), dataIndex: 'invoke_type', key: 'itype', width: 110,
      render: (v: string) => ({
        agent_auto: t('mcp_detail_calls_invoke_agent_auto'),
        user_confirmed: t('mcp_detail_calls_invoke_user_confirmed'),
        mcp_test: t('mcp_detail_calls_invoke_mcp_test'),
      }[v] || v),
    },
    { title: t('mcp_detail_calls_col_input'), dataIndex: 'input_summary', key: 'input', width: 220, ellipsis: true,
      render: (v: any) => <Text code style={{ whiteSpace: 'nowrap' }}>{jsonPreview(v)}</Text> },
    { title: t('mcp_detail_calls_col_output'), dataIndex: 'output_summary', key: 'output', width: 220, ellipsis: true,
      render: (v: any) => <Text code style={{ whiteSpace: 'nowrap' }}>{jsonPreview(v)}</Text> },
    {
      title: t('mcp_detail_calls_col_result'), dataIndex: 'result', key: 'result', width: 90,
      render: (v: string) => <Tag color={v === 'success' ? 'success' : 'error'}>{v === 'success' ? t('mcp_detail_calls_result_success') : t('mcp_detail_calls_result_failed')}</Tag>,
    },
    { title: t('mcp_detail_calls_col_resp'), dataIndex: 'response_time', key: 'rt', width: 100, render: (v?: number) => v != null ? `${v} ms` : '-' },
    { title: t('mcp_detail_calls_col_error'), dataIndex: 'error_message', key: 'err', width: 200, ellipsis: true, render: (v?: string) => v || '-' },
  ]

  if (error) {
    return <Result status="error" title={t('mcp_detail_calls_load_failed')} subTitle={error} extra={<Button onClick={reload}>{t('mcp_detail_retry')}</Button>} />
  }

  return (
    <Card
      title={t('mcp_detail_calls_card_title')}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={reload}>{t('mcp_detail_refresh')}</Button>}
    >
      {/* 筛选条 + 操作按钮同行;格子和 = 24 刚好,小屏下自然换行。
          gutter 加垂直分量,换行时不会贴在一起。 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }} align="middle">
        <Col xs={24} md={7}>
          <RangePicker
            showTime
            style={{ width: '100%' }}
            onChange={(range) => {
              setPending({
                ...pending,
                start: range?.[0]?.toISOString(),
                end: range?.[1]?.toISOString(),
              })
            }}
          />
        </Col>
        <Col xs={12} md={4}>
          <Input placeholder={t('mcp_detail_calls_filter_user')} allowClear value={pending.user_id}
            onChange={(e) => setPending({ ...pending, user_id: e.target.value })} />
        </Col>
        <Col xs={12} md={4}>
          <Input placeholder={t('mcp_detail_calls_filter_tool')} allowClear value={pending.ai_tool_id}
            onChange={(e) => setPending({ ...pending, ai_tool_id: e.target.value })} />
        </Col>
        <Col xs={12} md={3}>
          <Select
            placeholder={t('mcp_detail_calls_filter_result')} allowClear style={{ width: '100%' }}
            value={pending.result}
            onChange={(v) => setPending({ ...pending, result: v })}
            options={[
              { value: 'success', label: t('mcp_detail_calls_result_success') },
              { value: 'failed', label: t('mcp_detail_calls_result_failed') },
            ]}
          />
        </Col>
        <Col xs={12} md={3}>
          <Select
            placeholder={t('mcp_detail_calls_filter_invoke_type')} allowClear style={{ width: '100%' }}
            value={pending.invoke_type}
            onChange={(v) => setPending({ ...pending, invoke_type: v })}
            options={[
              { value: 'agent_auto', label: t('mcp_detail_calls_invoke_agent_auto') },
              { value: 'user_confirmed', label: t('mcp_detail_calls_invoke_user_confirmed') },
              { value: 'mcp_test', label: t('mcp_detail_calls_invoke_mcp_test') },
            ]}
          />
        </Col>
        <Col xs={24} md={3} style={{ textAlign: 'right' }}>
          <Space>
            <Button type="primary" onClick={onQuery}>{t('mcp_detail_calls_filter_query')}</Button>
            <Button onClick={onReset}>{t('mcp_detail_calls_filter_reset')}</Button>
          </Space>
        </Col>
      </Row>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        scroll={{ x: 1800 }}
        locale={{ emptyText: <Empty description={t('mcp_detail_calls_empty')} /> }}
        pagination={{
          current: page, pageSize: size, total,
          showSizeChanger: true,
          showTotal: (n) => t('mcp_server_list_pagination_total', { count: n }),
          onChange: (p, ps) => { setPage(p); setSize(ps) },
        }}
      />
    </Card>
  )
}

// ── Tab 7: 变更记录 ───────────────────────────────────────────────────

const ChangesTab: React.FC<{ serverId: string }> = ({ serverId }) => {
  const { t } = useTranslation()
  const [items, setItems] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ total: number; items: any[] }>(
        `/mcp-servers/${serverId}/changes`,
        { params: { offset: (page - 1) * size, limit: size } },
      )
      setItems(res.items || [])
      setTotal(res.total || 0)
    } catch (e: any) {
      setError(e?.response?.data?.detail || t('mcp_detail_changes_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [serverId, page, size, t])

  useEffect(() => { reload() }, [reload])

  const RESOURCE_LABEL: Record<string, string> = {
    mcp_server: t('mcp_detail_changes_res_mcp_server'),
    mcp_capability: t('mcp_detail_changes_res_mcp_capability'),
    mcp_capability_authorization: t('mcp_detail_changes_res_authorization'),
  }

  const ACTION_LABEL: Record<string, string> = {
    'mcp_server.create': t('mcp_detail_changes_action_server_create'),
    'mcp_server.update': t('mcp_detail_changes_action_server_update'),
    'mcp_server.delete': t('mcp_detail_changes_action_server_delete'),
    'mcp_server.connection_test': t('mcp_detail_changes_action_connection_test'),
    'mcp_server.capability_sync': t('mcp_detail_changes_action_capability_sync'),
    'mcp_capability.update': t('mcp_detail_changes_action_capability_update'),
    'mcp_capability.quota_update': t('mcp_detail_changes_action_quota_update'),
    'mcp_capability_authorization.create': t('mcp_detail_changes_action_authz_create'),
    'mcp_capability_authorization.update': t('mcp_detail_changes_action_authz_update'),
    'mcp_capability_authorization.delete': t('mcp_detail_changes_action_authz_delete'),
    'mcp_capability_authorization.enable': t('mcp_detail_changes_action_authz_enable'),
    'mcp_capability_authorization.disable': t('mcp_detail_changes_action_authz_disable'),
  }

  const columns = [
    { title: t('mcp_detail_changes_col_time'), dataIndex: 'created_at', key: 'at', render: fmt, width: 160 },
    { title: t('mcp_detail_changes_col_user'), dataIndex: 'user_name', key: 'op', width: 100, render: (v?: string) => v || '-' },
    {
      title: t('mcp_detail_changes_col_action'), dataIndex: 'action', key: 'action', width: 220,
      render: (v: string) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {ACTION_LABEL[v] ? <Tag color="blue">{ACTION_LABEL[v]}</Tag> : <Text code>{v}</Text>}
        </span>
      ),
    },
    { title: t('mcp_detail_changes_col_resource'), dataIndex: 'resource_type', key: 'rtype', width: 130, render: (v: string) => <Tag>{RESOURCE_LABEL[v] || v}</Tag> },
    {
      title: t('mcp_detail_changes_col_before'), key: 'before', width: 280,
      render: (_: any, row: any) => {
        const ch = row.details?.changes
        if (!ch) return '-'
        return <pre style={{ margin: 0, fontSize: 12, maxHeight: 100, overflow: 'auto' }}>{JSON.stringify(
          Object.fromEntries(Object.entries(ch).map(([k, v]: any) => [k, v.before])), null, 2,
        )}</pre>
      },
    },
    {
      title: t('mcp_detail_changes_col_after'), key: 'after', width: 280,
      render: (_: any, row: any) => {
        const ch = row.details?.changes
        if (!ch) return '-'
        return <pre style={{ margin: 0, fontSize: 12, maxHeight: 100, overflow: 'auto' }}>{JSON.stringify(
          Object.fromEntries(Object.entries(ch).map(([k, v]: any) => [k, v.after])), null, 2,
        )}</pre>
      },
    },
    {
      title: t('mcp_detail_changes_col_note'), key: 'note', width: 300, ellipsis: true,
      render: (_: any, row: any) => {
        const d = row.details || {}
        const action: string = row.action || ''
        const parts: string[] = []

        if (action === 'mcp_server.connection_test') {
          const ok = d.status === 'normal'
          parts.push(ok
            ? t('mcp_detail_changes_note_connected', { ms: d.response_time_ms ?? '?' })
            : t('mcp_detail_changes_note_abnormal'))
          if (d.error_type) parts.push(t('mcp_detail_changes_note_error', { type: d.error_type }))
          if (d.capabilities_discovered != null) parts.push(t('mcp_detail_changes_note_discovered', { count: d.capabilities_discovered }))
        } else if (action === 'mcp_server.capability_sync') {
          if (d.status) parts.push(d.status === 'success'
            ? t('mcp_detail_changes_note_sync_ok')
            : t('mcp_detail_changes_note_sync_fail', { status: d.status }))
          const summary = (label: string, x?: any) =>
            x && (x.added || x.updated || x.removed)
              ? `${label} +${x.added || 0}/~${x.updated || 0}/-${x.removed || 0}` : ''
          ;[
            summary(t('mcp_detail_changes_note_summary_caps'), d.capabilities),
            summary(t('mcp_detail_changes_note_summary_resources'), d.resources),
            summary(t('mcp_detail_changes_note_summary_prompts'), d.prompts),
          ].filter(Boolean).forEach(s => parts.push(s))
          if (d.error_type) parts.push(t('mcp_detail_changes_note_error', { type: d.error_type }))
        } else {
          if (d.server_code) parts.push(`code=${d.server_code}`)
          if (d.capability_name) parts.push(t('mcp_detail_changes_note_cap_eq', { name: d.capability_name }))
          if (d.ai_tool_id) parts.push(`AI Tool=${d.ai_tool_id}`)
        }
        return parts.join('；') || '-'
      },
    },
  ]

  if (error) {
    return <Result status="error" title={t('mcp_detail_changes_load_failed')} subTitle={error} extra={<Button onClick={reload}>{t('mcp_detail_retry')}</Button>} />
  }

  return (
    <Card title={t('mcp_detail_changes_card_title')} extra={<Button size="small" icon={<ReloadOutlined />} onClick={reload}>{t('mcp_detail_refresh')}</Button>}>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        scroll={{ x: 1500 }}
        locale={{ emptyText: <Empty description={t('mcp_detail_changes_empty')} /> }}
        pagination={{
          current: page, pageSize: size, total,
          showSizeChanger: true,
          showTotal: (n) => t('mcp_server_list_pagination_total', { count: n }),
          onChange: (p, ps) => { setPage(p); setSize(ps) },
        }}
      />
    </Card>
  )
}

// ── Main ──────────────────────────────────────────────────────────────

const McpServerDetail: React.FC = () => {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  // Starts true: the component always fetches on mount. If it started
  // false, the first render (before the fetch useEffect runs) would have
  // loading=false + detail=null + error=null → fall straight through to
  // the `error || !detail` branch and flash the error page for one frame.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('basic')
  const [editOpen, setEditOpen] = useState(false)
  // Bumped to trigger health-tab reload on test-connection,
  // and call-log tab reload on test-invoke.
  const [healthReloadKey, setHealthReloadKey] = useState(0)
  const [callLogReloadKey, setCallLogReloadKey] = useState(0)
  const [capReloadKey, setCapReloadKey] = useState(0)

  const reloadDetail = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      // capability_count + authorized_principal_count now live on the detail body
      // (added when fix landed for "MCP 能力数 displays -" bug). No need to
      // round-trip back to the list endpoint.
      const d = await api.get<ServerDetail>(`/mcp-servers/${id}`)
      setDetail(d)
    } catch (e: any) {
      setError(e?.response?.data?.detail || t('mcp_detail_load_failed'))
    } finally {
      setLoading(false)
    }
  }, [id, t])

  useEffect(() => { reloadDetail() }, [reloadDetail])

  const onTest = async () => {
    if (!detail) return
    const hide = message.loading(t('mcp_detail_msg_testing', { name: detail.name }), 0)
    try {
      const res = await api.post<any>(`/mcp-servers/${detail.id}/test`, {})
      hide()
      if (res.status === 'normal') {
        message.success(t('mcp_detail_msg_test_ok', {
          ms: res.response_time_ms, count: res.capabilities_discovered,
        }))
      } else {
        message.error(t('mcp_detail_msg_test_fail', {
          type: res.error_type || '', message: res.error_message || '',
        }).trim())
      }
      reloadDetail()
      setHealthReloadKey(k => k + 1)
    } catch (e: any) {
      hide()
      message.error(e?.response?.data?.detail || t('mcp_detail_msg_test_error'))
    }
  }

  const onSync = async () => {
    if (!detail) return
    const hide = message.loading(t('mcp_detail_msg_syncing', { name: detail.name }), 0)
    try {
      const res = await api.post<any>(`/mcp-servers/${detail.id}/sync`, {})
      hide()
      const caps = res.capabilities || {}
      message.success(t('mcp_detail_msg_sync_done', {
        status: res.status,
        added: caps.added || 0, updated: caps.updated || 0, removed: caps.removed || 0,
      }))
      reloadDetail()
      setCapReloadKey(k => k + 1)  // re-fetch the 能力 Tab table
    } catch (e: any) {
      hide()
      message.error(e?.response?.data?.detail || t('mcp_detail_msg_sync_error'))
    }
  }

  const onToggle = async () => {
    if (!detail) return
    const next = detail.status === 'enabled' ? 'disable' : 'enable'
    try {
      await api.post(`/mcp-servers/${detail.id}/${next}`, {})
      message.success(t(detail.status === 'enabled' ? 'mcp_detail_msg_disabled' : 'mcp_detail_msg_enabled'))
      reloadDetail()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_detail_msg_action_error'))
    }
  }

  if (loading && !detail) {
    return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
  }
  if (error || !detail) {
    return (
      <Result
        status="error"
        title={t('mcp_detail_load_failed_title')}
        subTitle={error || t('mcp_detail_unknown_error')}
        extra={
          <Space>
            <Button onClick={() => navigate('/mcp')}>{t('mcp_detail_back_to_list')}</Button>
            <Button type="primary" onClick={reloadDetail}>{t('mcp_detail_retry')}</Button>
          </Space>
        }
      />
    )
  }

  return (
    <div>
      {/* Top summary card */}
      <Card style={{ marginBottom: 12 }}>
        <Row gutter={12} align="middle" style={{ marginBottom: 12 }}>
          <Col flex="auto">
            <Space size="small" align="center">
              <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/mcp')}>{t('mcp_detail_header_back')}</Button>
              <Title level={3} style={{ margin: 0 }}>{detail.name}</Title>
              <Text code>{detail.code}</Text>
              {statusTag(detail.status)}
              {effectiveHealthTag(detail.health_status, detail.configuration_status)}
            </Space>
          </Col>
          <Col>
            <Space>
              <Button icon={<ThunderboltOutlined />} onClick={onTest}>{t('mcp_detail_header_test')}</Button>
              <Button icon={<SyncOutlined />} onClick={onSync}>{t('mcp_detail_header_sync')}</Button>
              <Button icon={<EditOutlined />} onClick={() => setEditOpen(true)}>{t('mcp_detail_header_edit')}</Button>
              <Button
                icon={detail.status === 'enabled' ? <PoweroffOutlined /> : <PlayCircleOutlined />}
                onClick={onToggle}
              >
                {detail.status === 'enabled' ? t('mcp_detail_header_disable') : t('mcp_detail_header_enable')}
              </Button>
            </Space>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_category')} valueRender={() => <Tag>{mcpCategoryText(detail.service_category)}</Tag>} value={detail.service_category} /></Col>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_connection')} valueRender={() => <Tag>{detail.connection_type.toUpperCase()}</Tag>} value={detail.connection_type} /></Col>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_capability_count')} value={detail.capability_count ?? 0} /></Col>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_authorized_count')} value={detail.authorized_principal_count ?? 0} /></Col>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_last_checked')} valueRender={() => <Text style={{ fontSize: 16 }}>{fmt(detail.last_checked_at)}</Text>} value={detail.last_checked_at || '-'} /></Col>
          <Col xs={12} sm={4}><Statistic title={t('mcp_detail_stat_last_synced')} valueRender={() => <Text style={{ fontSize: 16 }}>{fmt(detail.last_synced_at)}</Text>} value={detail.last_synced_at || '-'} /></Col>
        </Row>

        {/* Surface sync + health hints so the user understands why a sync
            says "已同步" but the page still looks empty / health unchecked.
            See the bug report: GitHub MCP showed last_synced_at + 能力数=-
            and the user had no signal about partial_success / unchecked. */}
        {/* Only fire when there's an actual error message persisted. After
            the Method-not-found fix, partial_success now only flags REAL
            partial failures (e.g. capability bucket succeeded but resources
            bucket hit a network error). Servers that simply don't implement
            resources/prompts come back as 'success'. */}
        {detail.last_sync_status === 'partial_success' && detail.last_sync_error_message && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message={t('mcp_detail_alert_sync_partial_title')}
            description={
              <Space direction="vertical" size={2}>
                <Text>{detail.last_sync_error_message}</Text>
              </Space>
            }
          />
        )}
        {detail.last_sync_status === 'failed' && (
          <Alert
            style={{ marginTop: 12 }}
            type="error"
            showIcon
            message={t('mcp_detail_alert_sync_failed_title')}
            description={detail.last_sync_error_message || t('mcp_detail_alert_sync_failed_desc')}
            action={<Button size="small" onClick={onTest}>{t('mcp_detail_header_test')}</Button>}
          />
        )}
        {detail.health_status === 'unchecked' && (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={t('mcp_detail_alert_unchecked_title')}
            description={t('mcp_detail_alert_unchecked_desc')}
            action={<Button size="small" type="primary" onClick={onTest}>{t('mcp_detail_header_test')}</Button>}
          />
        )}
      </Card>

      {/* Tabs */}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        destroyOnHidden
        items={[
          { key: 'basic', label: t('mcp_detail_tab_basic'), children: <BasicInfoTab detail={detail} /> },
          {
            key: 'connection', label: t('mcp_detail_tab_connection'),
            children: <ConnectionTab detail={detail} onTest={onTest} onEdit={() => setEditOpen(true)} />,
          },
          {
            key: 'capabilities', label: t('mcp_detail_tab_capabilities'),
            children: <CapabilitiesTab
              serverId={detail.id}
              onCallLogged={() => setCallLogReloadKey(k => k + 1)}
              reloadKey={capReloadKey}
            />,
          },
          {
            key: 'health', label: t('mcp_detail_tab_health'),
            children: <HealthTab serverId={detail.id} reloadKey={healthReloadKey} />,
          },
          {
            key: 'calls', label: t('mcp_detail_tab_calls'),
            children: <CallLogsTab serverId={detail.id} reloadKey={callLogReloadKey} />,
          },
          { key: 'changes', label: t('mcp_detail_tab_changes'), children: <ChangesTab serverId={detail.id} /> },
        ]}
      />

      <ServerDrawer
        open={editOpen}
        mode="edit"
        detail={detail}
        onClose={() => setEditOpen(false)}
        onSaved={reloadDetail}
      />
    </div>
  )
}

export default McpServerDetail
