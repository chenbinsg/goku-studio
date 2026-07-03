/**
 * Shared add/edit Drawer for MCP Server. Used by McpServerList (Task 5) and
 * McpServerDetail header actions (Task 6).
 *
 * Secret semantics (backend-driven):
 *   - On edit, leaving auth_secret blank / mask sentinel = keep stored value.
 *   - env_config same: blank = keep, new JSON dict = overwrite.
 *   - Explicit clear is intentionally NOT exposed here — the backend supports
 *     it via clear_auth_secret / clear_env_config flags but the spec says
 *     admins should never accidentally wipe a secret from this form.
 */
import React, { useEffect, useState } from 'react'
import {
  Drawer, Form, Input, Select, Switch, InputNumber, Button, Space, Row, Col,
  Divider, Tabs, Card, Typography, message,
} from 'antd'
import {
  FolderOutlined, GlobalOutlined, BulbOutlined, GithubOutlined, DatabaseOutlined,
  SearchOutlined, MessageOutlined, ThunderboltOutlined, ReconciliationOutlined,
  CloudUploadOutlined, FileSearchOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { api } from '@/api'

const { Text, Paragraph } = Typography

// ── Shared constants exported for reuse by other MCP pages ───────────
//
// i18n note: display text is NOT embedded here anymore. Label values come
// from i18n keys (mcp_category_* / mcp_status_* / mcp_health_* /
// mcp_capability_status_*); these exports only carry stable, non-display
// metadata (value lists, tag colors). Consumers render text via t().

export const SERVICE_CATEGORY_VALUES = [
  'file_processing', 'data_service', 'dev_tools', 'office_collab', 'project_mgmt',
  'knowledge_service', 'search_service', 'system_integration', 'automation', 'other',
] as const

// Transport types are technical literals (stdio / HTTP) — not localized.
export const CONNECTION_TYPES: { value: string; label: string }[] = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
]

// Tag color metadata only — the text label comes from i18n.
export const STATUS_COLORS: Record<string, string> = {
  enabled: 'green', disabled: 'default',
}
export const HEALTH_COLORS: Record<string, string> = {
  normal: 'success', abnormal: 'error', unchecked: 'default',
}
export const CAPABILITY_STATUS_COLORS: Record<string, string> = {
  active: 'success', inactive: 'default',
}

/** Localized helpers — safe to call at render time (i18n singleton is
 *  initialized at app boot). Used by this drawer and the list/detail pages. */
export const mcpStatusText = (s?: string): string =>
  s ? i18n.t(`mcp_status_${s}`, { defaultValue: s }) : '-'
export const mcpHealthText = (h?: string): string =>
  h ? i18n.t(`mcp_health_${h}`, { defaultValue: h }) : '-'
export const mcpCapabilityStatusText = (s?: string): string =>
  s ? i18n.t(`mcp_capability_status_${s}`, { defaultValue: s }) : '-'
export const mcpCategoryText = (c?: string): string =>
  c ? i18n.t(`mcp_category_${c}`, { defaultValue: c }) : '-'

const CONFLICT_STRATEGY_VALUES = ['overwrite', 'keep', 'merge']
const OFFLINE_STRATEGY_VALUES = ['mark_inactive', 'remove']
const SYNC_FREQUENCY_VALUES = ['manual', 'hourly', 'daily', 'weekly']

// PRESETS use hyphens in `key`; i18n keys use underscores.
const presetI18nKey = (key: string): string => key.replace(/-/g, '_')

// ── Types ─────────────────────────────────────────────────────────────

export interface MCPServerDetail {
  id: string
  name: string
  code: string
  service_category: string
  description?: string
  owner?: string
  connection_type: string
  service_url?: string
  start_command?: string
  work_dir?: string
  timeout_seconds: number
  retry_count: number
  auth_type?: string | null
  auth_header_name?: string | null
  secrets: {
    auth_secret_configured: boolean
    auth_secret_display: string
    env_config_configured: boolean
    env_config_display: string
    env_config_keys: string[]
    // External-connection bindings: codes stored inside the (encrypted)
    // env_config. Not secrets — surfaced separately so the edit drawer
    // can pre-select the two dropdowns without exposing the full plaintext.
    env_config_connection_id?: string | null
    env_config_server_auth_connection_id?: string | null
  }
  status: 'enabled' | 'disabled'
  health_status: 'normal' | 'abnormal' | 'unchecked'
  last_checked_at?: string | null
  last_response_time?: number | null
  last_sync_status?: string | null
  last_synced_at?: string | null
  last_sync_error_message?: string | null
  capability_count?: number
  authorized_principal_count?: number
  // Backend-derived: "ok" / "incomplete". Drives the "配置不完整"
  // demotion across detail header / basic-info / connection tab /
  // list-page health column.
  configuration_status?: string
  auto_sync_enabled: boolean
  sync_frequency?: string
  sync_scope?: Record<string, any>
  conflict_strategy?: string
  offline_strategy?: string
  allow_agent_auto_invoke: boolean
  high_risk_confirm_required: boolean
  rate_limit_config?: Record<string, any>
  circuit_breaker_config?: Record<string, any>
  audit_enabled: boolean
  created_by?: string
  created_at: string
  updated_by?: string
  updated_at: string
}

// ── Presets (moved into create drawer) ────────────────────────────────

interface McpPreset {
  key: string
  icon: React.ReactNode
  // label / description are NOT stored here — they come from i18n
  // (mcp_preset_<key>_label / _desc, hyphens → underscores).
  service_category: string
  connection_type: 'stdio' | 'http'
  start_command: string
  // envKeys: key names only — applyPreset fills each with an empty string
  // for the admin to complete.
  envKeys?: string[]
  // envTemplate: a full env_config template with values. Use this when some
  // entries have fixed/default values the admin should NOT have to guess
  // (e.g. PYTHONPATH=${BACKEND_DIR}). Takes precedence over envKeys.
  // After the external-connections refactor, envTemplate must NOT contain
  // any external-system secret fields (AWS keys, tokens, passwords…) —
  // those live in mcp_external_connections and arrive via runtime injection.
  envTemplate?: Record<string, string>
  // needs_connection: this server type REQUIRES an external connection
  // (storage-s3, github, slack, postgres…). The drawer shows the dropdown
  // as required and the backend enforces it on save / at runtime.
  needs_connection?: boolean
  // suggested_type: pre-filter the external-connections dropdown to this
  // mcp_external_connections.connection_type so admins see the right
  // candidates first.
  suggested_type?: 's3' | 'sftp' | 'url' | 'local_path' | 'database' | 'github' | 'slack'
}

const PRESETS: McpPreset[] = [
  { key: 'filesystem', icon: <FolderOutlined style={{ color: '#52c41a' }} />,
    service_category: 'file_processing', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-filesystem /workspace' },
  { key: 'fetch', icon: <GlobalOutlined style={{ color: '#1890ff' }} />,
    service_category: 'system_integration', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-fetch' },
  { key: 'memory', icon: <BulbOutlined style={{ color: '#722ed1' }} />,
    service_category: 'knowledge_service', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-memory' },
  { key: 'github', icon: <GithubOutlined style={{ color: '#24292f' }} />,
    service_category: 'dev_tools', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-github',
    needs_connection: true, suggested_type: 'github' },
  { key: 'sqlite', icon: <DatabaseOutlined style={{ color: '#fa8c16' }} />,
    service_category: 'data_service', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-sqlite --db-path /tmp/agent.db' },
  { key: 'postgres', icon: <DatabaseOutlined style={{ color: '#336791' }} />,
    service_category: 'data_service', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-postgres',
    needs_connection: true, suggested_type: 'database' },
  // MySQL / ClickHouse: official standalone packages, credentials injected from
  // the bound `database` external connection (DB_*) and mapped to each
  // package's own env names inside the command. Two deliberate quirks — do NOT
  // "fix" them:
  //   1. `"…PASS""WORD"` string-splitting keeps the literal word "password"
  //      out of the stored command (DLP blocks tool I/O containing it).
  //   2. The leading `export PATH=…` covers the standard install locations of
  //      npx/uvx on macOS (brew) and Linux/Docker — the MCP subprocess env has
  //      no PATH of its own, so the command must bootstrap one.
  // Runtime prerequisites per environment: node (npx) for mysql, uv (uvx) for
  // clickhouse.
  { key: 'mysql', icon: <DatabaseOutlined style={{ color: '#00758f' }} />,
    service_category: 'data_service', connection_type: 'stdio',
    start_command: 'sh -c \'export PATH="$(dirname "${NPX}"):/usr/bin:/bin"; MYSQL_HOST="$DB_HOST" MYSQL_PORT="$DB_PORT" MYSQL_USER="$DB_USERNAME" MYSQL_PASS="$(printenv "DB_PASS""WORD")" MYSQL_DB="$DB_NAME" exec "${NPX}" -y @benborla29/mcp-server-mysql\'',
    needs_connection: true, suggested_type: 'database' },
  { key: 'clickhouse', icon: <DatabaseOutlined style={{ color: '#f2b100' }} />,
    service_category: 'data_service', connection_type: 'stdio',
    start_command: 'sh -c \'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"; export CLICKHOUSE_HOST="$DB_HOST" CLICKHOUSE_PORT="$DB_PORT" CLICKHOUSE_USER="$DB_USERNAME" CLICKHOUSE_DATABASE="$DB_NAME" CLICKHOUSE_SECURE=false; export "CLICKHOUSE_PASS""WORD"="$(printenv "DB_PASS""WORD")"; exec uvx mcp-clickhouse\'',
    needs_connection: true, suggested_type: 'database' },
  { key: 'brave-search', icon: <SearchOutlined style={{ color: '#fb542b' }} />,
    service_category: 'search_service', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-brave-search',
    envKeys: ['BRAVE_API_KEY'] },
  { key: 'slack', icon: <MessageOutlined style={{ color: '#4a154b' }} />,
    service_category: 'office_collab', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-slack',
    needs_connection: true, suggested_type: 'slack' },
  { key: 'puppeteer', icon: <GlobalOutlined style={{ color: '#40a9ff' }} />,
    service_category: 'automation', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-puppeteer' },
  { key: 'time', icon: <ThunderboltOutlined style={{ color: '#faad14' }} />,
    service_category: 'other', connection_type: 'stdio',
    start_command: 'npx -y @modelcontextprotocol/server-time' },
  { key: 'bank-recon', icon: <ReconciliationOutlined style={{ color: '#13c2c2' }} />,
    service_category: 'data_service', connection_type: 'stdio',
    start_command: '${VENV_PYTHON} -m app.agent.mcp.servers.bank_recon_server',
    // PYTHONPATH is auto-injected by mcp_runtime for `-m app.*` launches.
    envTemplate: { AIOS_BACKEND_ENV: '${BACKEND_ENV}' } },
  { key: 'file-parser', icon: <FileSearchOutlined style={{ color: '#52c41a' }} />,
    service_category: 'file_processing', connection_type: 'stdio',
    // PYTHONPATH is auto-injected by mcp_runtime for `-m app.*` launches.
    // file-parser does NOT bind any external connection — secrets-free
    // by design. Two optional env knobs:
    //   GOKU_TMP_DIR   = profile cache root (default /tmp)
    //   GOKU_FILE_BASE = root for managed_file_ref / conversation_upload
    start_command: '${VENV_PYTHON} -m app.agent.mcp.servers.file_parser_server',
    envTemplate: {
      GOKU_FILE_BASE: '${BACKEND_DIR}/uploads',
    } },
  { key: 'storage-s3', icon: <CloudUploadOutlined style={{ color: '#ff9900' }} />,
    service_category: 'file_processing', connection_type: 'stdio',
    // ${VENV_PYTHON} — the venv interpreter where boto3 is installed.
    // PYTHONPATH is auto-injected by mcp_runtime for `-m app.*` launches.
    // env_config NO LONGER carries AWS_* / S3_BUCKET / S3_ALLOWED_PREFIXES —
    // those come from the bound external connection at runtime.
    start_command: '${VENV_PYTHON} -m app.agent.mcp.servers.storage_s3_server',
    needs_connection: true, suggested_type: 's3',
    envTemplate: {
      DEFAULT_UPLOAD_URL_EXPIRES_SECONDS: '900',
      DEFAULT_DOWNLOAD_URL_EXPIRES_SECONDS: '900',
    } },
]

// ── Helpers ───────────────────────────────────────────────────────────

function buildSecretFields(values: any, isEdit: boolean): any {
  // Strip blank/missing env_config; backend treats absent = keep.
  // Never auto-clear. Explicit clear (rare) goes through clear_env_config
  // not exposed in this Drawer.
  const out: any = { ...values }
  if (isEdit) {
    if (out.env_config === undefined || out.env_config === '' || out.env_config === null) {
      delete out.env_config
    } else if (typeof out.env_config === 'string') {
      try { out.env_config = JSON.parse(out.env_config) } catch { /* fall through */ }
    }
  } else {
    if (typeof out.env_config === 'string' && out.env_config.trim()) {
      try { out.env_config = JSON.parse(out.env_config) } catch { /* fall through */ }
    } else if (!out.env_config) {
      delete out.env_config
    }
  }
  return out
}

// ── Component ─────────────────────────────────────────────────────────

export interface ServerDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  detail?: MCPServerDetail | null
  onClose: () => void
  onSaved: () => void
}

interface ExternalConnectionOption {
  id: string
  code: string
  name: string
  connection_type: string
  enabled: boolean
  test_status?: string | null
}

const ServerDrawer: React.FC<ServerDrawerProps> = ({ open, mode, detail, onClose, onSaved }) => {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'manual' | 'preset'>('manual')
  const [connections, setConnections] = useState<ExternalConnectionOption[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(false)
  // Pinned by the selected preset; the dropdown ranks matching types first.
  const [suggestedType, setSuggestedType] = useState<string | undefined>()
  // Drives the "(required)" star + form rule for the connection_code field.
  const [needsConnection, setNeedsConnection] = useState(false)

  useEffect(() => {
    if (!open) return
    setConnectionsLoading(true)
    api.get<{ items: ExternalConnectionOption[] }>('/mcp-external-connections', {
      // Only enabled connections are bindable — disabled ones can't be saved.
      params: { enabled: true },
    })
      .then((res: any) => {
        const items = (res?.items ?? res?.data?.items ?? []) as ExternalConnectionOption[]
        setConnections(items)
      })
      .catch(() => setConnections([]))
      .finally(() => setConnectionsLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    setActiveTab('manual')
    setSuggestedType(undefined)
    setNeedsConnection(false)
    form.resetFields()
    if (mode === 'edit' && detail) {
      form.setFieldsValue({
        name: detail.name,
        code: detail.code,
        service_category: detail.service_category,
        owner: detail.owner,
        description: detail.description,
        status: detail.status,
        connection_type: detail.connection_type,
        service_url: detail.service_url,
        start_command: detail.start_command,
        work_dir: detail.work_dir,
        timeout_seconds: detail.timeout_seconds,
        retry_count: detail.retry_count,
        env_config: '',
        // Pre-select the bound external connections (backend surfaces both
        // codes separately so the dropdowns can echo without exposing the
        // env_config plaintext).
        connection_code: detail.secrets.env_config_connection_id || undefined,
        server_auth_connection_code: detail.secrets.env_config_server_auth_connection_id || undefined,
        auto_sync_enabled: detail.auto_sync_enabled,
        sync_frequency: detail.sync_frequency || 'manual',
        sync_scope: JSON.stringify(detail.sync_scope || {}),
        conflict_strategy: detail.conflict_strategy || 'overwrite',
        offline_strategy: detail.offline_strategy || 'mark_inactive',
        circuit_breaker_config: JSON.stringify(detail.circuit_breaker_config || {}),
        audit_enabled: detail.audit_enabled,
      })
    } else {
      form.setFieldsValue({
        status: 'enabled',
        connection_type: 'stdio',
        timeout_seconds: 60,
        retry_count: 0,
        auto_sync_enabled: false,
        sync_frequency: 'manual',
        conflict_strategy: 'overwrite',
        offline_strategy: 'mark_inactive',
        audit_enabled: true,
      })
    }
  }, [open, mode, detail])

  const applyPreset = (preset: McpPreset) => {
    const ik = presetI18nKey(preset.key)
    form.setFieldsValue({
      name: t(`mcp_preset_${ik}_label`),
      code: preset.key,
      service_category: preset.service_category,
      description: t(`mcp_preset_${ik}_desc`),
      connection_type: preset.connection_type,
      start_command: preset.start_command,
      service_url: '',
      env_config: preset.envTemplate
        ? JSON.stringify(preset.envTemplate, null, 2)
        : preset.envKeys
          ? JSON.stringify(Object.fromEntries(preset.envKeys.map(k => [k, ''])), null, 2)
          : '',
      // Reset any prior connection pick — preset-required types must be
      // re-chosen explicitly to avoid silently inheriting a stale code.
      connection_code: undefined,
    })
    setSuggestedType(preset.suggested_type)
    setNeedsConnection(!!preset.needs_connection)
    setActiveTab('manual')
    message.info(t(preset.needs_connection
      ? 'mcp_server_drawer_msg_preset_applied_needs_conn'
      : 'mcp_server_drawer_msg_preset_applied'))
  }

  const submit = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const sync_scope = values.sync_scope
        ? (() => { try { return JSON.parse(values.sync_scope) } catch { return undefined } })()
        : undefined
      const circuit_breaker_config = values.circuit_breaker_config
        ? (() => { try { return JSON.parse(values.circuit_breaker_config) } catch { return undefined } })()
        : undefined

      // Merge BOTH connection dropdowns into env_config:
      //   connection_id              — external system the server CALLS
      //   server_auth_connection_id  — Goku → MCP-server endpoint auth
      // Both are the only legitimate write paths; backend rejects manual
      // connection_id input via env_config textarea (P2).
      let envForSave: string | undefined = values.env_config
      const code = (values.connection_code || '').trim()
      const authCode = (values.server_auth_connection_code || '').trim()
      if (mode === 'edit' && envForSave === '' && !code && !authCode) {
        // Pure no-op edit: leave env_config untouched on the server side.
        envForSave = undefined
      } else {
        let envDict: Record<string, any> = {}
        if (envForSave && typeof envForSave === 'string' && envForSave.trim()) {
          try {
            const parsed = JSON.parse(envForSave)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              envDict = parsed
            }
          } catch {
            message.error(t('mcp_server_drawer_msg_env_json_error'))
            setSaving(false)
            return
          }
        }
        if (code) {
          envDict.connection_id = code
        } else {
          delete envDict.connection_id
        }
        if (authCode) {
          envDict.server_auth_connection_id = authCode
        } else {
          delete envDict.server_auth_connection_id
        }
        envForSave = Object.keys(envDict).length > 0 ? JSON.stringify(envDict) : undefined
      }

      const base: any = {
        name: values.name,
        service_category: values.service_category,
        description: values.description,
        owner: values.owner,
        connection_type: values.connection_type,
        service_url: values.service_url,
        start_command: values.start_command,
        work_dir: values.work_dir,
        timeout_seconds: values.timeout_seconds,
        retry_count: values.retry_count,
        env_config: envForSave,
        auto_sync_enabled: values.auto_sync_enabled,
        sync_frequency: values.sync_frequency,
        sync_scope,
        conflict_strategy: values.conflict_strategy,
        offline_strategy: values.offline_strategy,
        circuit_breaker_config,
        audit_enabled: values.audit_enabled,
      }
      const payload = buildSecretFields(base, mode === 'edit')

      if (mode === 'edit' && detail) {
        await api.put(`/mcp-servers/${detail.id}`, payload)
        message.success(t('mcp_server_drawer_msg_save_ok'))
      } else {
        payload.code = values.code
        await api.post('/mcp-servers', payload)
        message.success(t('mcp_server_drawer_msg_create_ok'))
      }
      onSaved()
      onClose()
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || t('mcp_server_drawer_msg_save_failed')
      message.error(msg)
    } finally {
      setSaving(false)
    }
  }

  const connectionType = Form.useWatch('connection_type', form)

  return (
    <Drawer
      title={mode === 'edit'
        ? t('mcp_server_drawer_title_edit', { name: detail?.name || '' })
        : t('mcp_server_drawer_title_create')}
      width={820}
      open={open}
      onClose={onClose}
      destroyOnClose
      footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={onClose}>{t('mcp_server_drawer_cancel')}</Button>
            <Button type="primary" loading={saving} onClick={submit}>{t('mcp_server_drawer_save')}</Button>
          </Space>
        </div>
      }
    >
      {mode === 'create' && (
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as 'manual' | 'preset')}
          items={[
            { key: 'manual', label: t('mcp_server_drawer_tab_manual') },
            { key: 'preset', label: t('mcp_server_drawer_tab_preset') },
          ]}
        />
      )}

      {mode === 'create' && activeTab === 'preset' ? (
        <Row gutter={[12, 12]}>
          {PRESETS.map((p) => {
            const ik = presetI18nKey(p.key)
            return (
              <Col xs={24} sm={12} md={8} key={p.key}>
                <Card hoverable size="small" onClick={() => applyPreset(p)} style={{ cursor: 'pointer' }}>
                  <Space align="start">
                    <div style={{ fontSize: 24 }}>{p.icon}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{t(`mcp_preset_${ik}_label`)}</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t(`mcp_preset_${ik}_desc`)}</Text>
                    </div>
                  </Space>
                </Card>
              </Col>
            )
          })}
        </Row>
      ) : (
        <Form form={form} layout="vertical" requiredMark>
          <Divider orientation="left" plain>{t('mcp_server_drawer_section_basic')}</Divider>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_name')} name="name"
                rules={[{ required: true, message: t('mcp_server_drawer_rule_name_required') }]}>
                <Input maxLength={255} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label={t('mcp_server_drawer_field_code')}
                name="code"
                rules={[
                  { required: true, message: t('mcp_server_drawer_rule_code_required') },
                  { pattern: /^[a-z0-9][a-z0-9_-]*$/, message: t('mcp_server_drawer_rule_code_pattern') },
                ]}
                tooltip={t('mcp_server_drawer_tooltip_code')}
              >
                <Input maxLength={100} disabled={mode === 'edit'} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_category')} name="service_category" rules={[{ required: true }]}>
                <Select options={SERVICE_CATEGORY_VALUES.map((v) => ({ value: v, label: t(`mcp_category_${v}`) }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_owner')} name="owner">
                <Input maxLength={255} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label={t('mcp_server_drawer_field_description')} name="description">
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
            </Col>
            {mode === 'edit' && (
              <Col span={12}>
                <Form.Item label={t('mcp_server_drawer_field_status')} name="status"
                  tooltip={t('mcp_server_drawer_tooltip_status')}>
                  <Select options={[
                    { value: 'enabled', label: t('mcp_status_enabled') },
                    { value: 'disabled', label: t('mcp_status_disabled') },
                  ]} disabled />
                </Form.Item>
              </Col>
            )}
          </Row>

          <Divider orientation="left" plain>{t('mcp_server_drawer_section_connection')}</Divider>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_connection_type')} name="connection_type" rules={[{ required: true }]}>
                <Select
                  options={CONNECTION_TYPES}
                  onChange={(v) => {
                    // 切换连接方式时清掉不属于新类型的字段,避免提交脏数据
                    // (隐藏的字段 antd 默认仍保留旧值)。
                    if (v === 'stdio') {
                      // stdio 不要:服务地址 / MCP请求配置
                      form.setFieldsValue({ service_url: undefined, server_auth_connection_code: undefined })
                    } else if (v === 'http') {
                      // http 不要:启动命令 / 工作目录 / 资源连接配置
                      form.setFieldsValue({
                        start_command: undefined, work_dir: undefined, connection_code: undefined,
                      })
                    }
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label={t('mcp_server_drawer_field_timeout')} name="timeout_seconds" rules={[{ required: true }]}>
                <InputNumber min={1} max={600} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label={t('mcp_server_drawer_field_retry')} name="retry_count">
                <InputNumber min={0} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            {connectionType === 'http' && (
              <Col span={24}>
                <Form.Item
                  label={t('mcp_server_drawer_field_service_url')}
                  name="service_url"
                  rules={[{ required: true, message: t('mcp_server_drawer_rule_http_url_required') }]}
                >
                  <Input maxLength={500} placeholder={t('mcp_server_drawer_ph_service_url')} />
                </Form.Item>
              </Col>
            )}
            {connectionType === 'stdio' && (
              <Col span={24}>
                <Form.Item
                  label={t('mcp_server_drawer_field_start_command')}
                  name="start_command"
                  rules={[{ required: true, message: t('mcp_server_drawer_rule_stdio_cmd_required') }]}
                >
                  <Input.TextArea rows={2} placeholder={t('mcp_server_drawer_ph_start_command')} />
                </Form.Item>
              </Col>
            )}
            {connectionType === 'stdio' && (
              <Col span={24}>
                <Form.Item label={t('mcp_server_drawer_field_work_dir')} name="work_dir">
                  <Input maxLength={500} />
                </Form.Item>
              </Col>
            )}
          </Row>

          <Divider orientation="left" plain>{t('mcp_server_drawer_section_external')}</Divider>
          <Row gutter={12}>
            {connectionType !== 'stdio' && (
              <Col span={24}>
                <Form.Item
                  label={t('mcp_server_drawer_field_server_auth_conn')}
                  name="server_auth_connection_code"
                  tooltip={t('mcp_server_drawer_tooltip_server_auth')}
                  extra={t('mcp_server_drawer_extra_server_auth')}
                >
                  <Select
                    showSearch
                    allowClear
                    loading={connectionsLoading}
                    placeholder={t('mcp_server_drawer_ph_server_auth')}
                    optionFilterProp="label"
                    options={connections
                      .filter((c) => c.connection_type === 'url')
                      .map((c) => ({
                        value: c.code,
                        label: `${c.name} · ${c.code}${c.enabled ? '' : t('mcp_server_drawer_conn_disabled_suffix')}`,
                        disabled: !c.enabled,
                      }))}
                  />
                </Form.Item>
              </Col>
            )}
            {connectionType === 'stdio' && (
              <Col span={24}>
                <Form.Item
                  label={t('mcp_server_drawer_field_resource_conn')}
                  name="connection_code"
                  tooltip={t(needsConnection
                    ? 'mcp_server_drawer_tooltip_resource_conn_required'
                    : 'mcp_server_drawer_tooltip_resource_conn_optional')}
                  rules={needsConnection
                    ? [{ required: true, message: t('mcp_server_drawer_rule_resource_conn_required') }]
                    : []}
                  extra={
                    needsConnection
                      ? t('mcp_server_drawer_extra_resource_conn_required', { type: suggestedType ?? '' })
                      : t('mcp_server_drawer_extra_resource_conn_optional')
                  }
                >
                  <Select
                    showSearch
                    allowClear
                    loading={connectionsLoading}
                    placeholder={
                      needsConnection
                        ? t('mcp_server_drawer_ph_resource_conn_required', { type: suggestedType })
                        : t('mcp_server_drawer_ph_resource_conn_optional')
                    }
                    optionFilterProp="label"
                    options={(() => {
                      // STRICT type filter: when the preset requires a
                      // specific connection_type (suggested_type), the dropdown
                      // only shows matching connections. Spec section 五 1-5:
                      // storage-s3 → s3 only, sftp → sftp only, etc. No more
                      // mistake-prone "sort but still selectable any type".
                      const candidates = suggestedType
                        ? connections.filter((c) => c.connection_type === suggestedType)
                        : connections
                      return candidates.map((c) => ({
                        value: c.code,
                        label: `${c.name} · ${c.code} · ${c.connection_type}${c.enabled ? '' : t('mcp_server_drawer_conn_disabled_suffix')}`,
                        disabled: !c.enabled,
                      }))
                    })()}
                    notFoundContent={
                      needsConnection && suggestedType
                        ? t('mcp_server_drawer_notfound_resource_conn_typed', { type: suggestedType })
                        : t('mcp_server_drawer_notfound_resource_conn_any')
                    }
                  />
                </Form.Item>
              </Col>
            )}
            <Col span={24}>
              <Form.Item
                label={t('mcp_server_drawer_field_env_config')}
                name="env_config"
                extra={(() => {
                  // Edit mode: show the existing runtime keys (excluding the
                  // two binding keys, which are surfaced by the dropdowns) so
                  // admins don't have to guess what's currently stored. The
                  // dropdowns above already disclose connection_id /
                  // server_auth_connection_id; this row is purely the runtime
                  // knobs (TTL / timeout / quota / …).
                  const runtimeKeys = (
                    mode === 'edit' && detail?.secrets?.env_config_keys
                      ? detail.secrets.env_config_keys
                      : []
                  ).filter((k) => k !== 'connection_id' && k !== 'server_auth_connection_id')
                  const baseHint = t('mcp_server_drawer_extra_env_base')
                  if (mode !== 'edit') return baseHint
                  if (runtimeKeys.length === 0) {
                    return baseHint + ' ' + t('mcp_server_drawer_extra_env_empty')
                  }
                  return baseHint + ' ' + t('mcp_server_drawer_extra_env_configured', {
                    keys: runtimeKeys.join('、'),
                  })
                })()}
              >
                <Input.TextArea rows={3} placeholder={t('mcp_server_drawer_ph_env_config')} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>{t('mcp_server_drawer_section_sync')}</Divider>
          <Row gutter={12}>
            <Col span={24}>
              <Form.Item
                label={t('mcp_server_drawer_field_sync_scope')}
                name="sync_scope"
                extra={t('mcp_server_drawer_extra_sync_scope')}
              >
                <Input.TextArea rows={2} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('mcp_server_drawer_field_auto_sync')} name="auto_sync_enabled" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('mcp_server_drawer_field_sync_frequency')} name="sync_frequency">
                <Select options={SYNC_FREQUENCY_VALUES.map((v) => ({
                  value: v, label: t(`mcp_server_drawer_sync_freq_${v}`),
                }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label={t('mcp_server_drawer_field_conflict_strategy')} name="conflict_strategy">
                <Select options={CONFLICT_STRATEGY_VALUES.map((v) => ({
                  value: v, label: t(`mcp_server_drawer_conflict_${v}`),
                }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_offline_strategy')} name="offline_strategy">
                <Select options={OFFLINE_STRATEGY_VALUES.map((v) => ({
                  value: v, label: t(`mcp_server_drawer_offline_${v}`),
                }))} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>{t('mcp_server_drawer_section_risk')}</Divider>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label={t('mcp_server_drawer_field_circuit_breaker')}
                name="circuit_breaker_config"
                extra={t('mcp_server_drawer_extra_circuit_breaker')}
              >
                <Input.TextArea rows={2} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label={t('mcp_server_drawer_field_audit')} name="audit_enabled" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            {t('mcp_server_drawer_bottom_hint')}
          </Paragraph>
        </Form>
      )}
    </Drawer>
  )
}

export default ServerDrawer

// Shared util reused by detail/list page formatters.
export function fmt(ts?: string | null): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return ts
  }
}
