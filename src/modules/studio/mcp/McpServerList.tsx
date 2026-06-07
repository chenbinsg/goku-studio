/**
 * MCP Server list page (Task 5). Shows stats, filter bar, table and
 * delegates add/edit to the shared ServerDrawer. Row "查看详情" navigates
 * to the detail page (Task 6) under /mcp/:id.
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Table, Button, Tag, Space, Typography, Modal, Input, Select, message,
  Card, Row, Col, Dropdown, Statistic, Tooltip, Empty,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, ApiOutlined,
  ThunderboltOutlined, SearchOutlined, EyeOutlined, SyncOutlined, MoreOutlined,
  PoweroffOutlined, PlayCircleOutlined, LinkOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '@/api'
import ServerDrawer, {
  SERVICE_CATEGORY_VALUES, STATUS_COLORS, HEALTH_COLORS, fmt,
  type MCPServerDetail,
} from './ServerDrawer'

const { Title, Text } = Typography

interface MCPServerListItem {
  id: string
  name: string
  code: string
  service_category: string
  description?: string
  owner?: string
  connection_type: string
  status: 'enabled' | 'disabled'
  health_status: 'normal' | 'abnormal' | 'unchecked'
  // Backend-derived: 'ok' / 'incomplete'. When 'incomplete', the health
  // column shows "配置不完整" instead of whatever transport-level status
  // says — a stale 'normal' on a token-less github server would mislead.
  configuration_status?: string
  last_checked_at?: string | null
  last_synced_at?: string | null
  capability_count: number
  authorized_principal_count: number
  created_at: string
  updated_at: string
}

interface MCPServerStats {
  total: number
  enabled: number
  disabled: number
  normal: number
  abnormal: number
  unchecked: number
}

const McpServerList: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [servers, setServers] = useState<MCPServerListItem[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<MCPServerStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  // Param names MUST match backend (camelCase for multi-word) — see
  // backend/app/routers/mcp_servers.py:list_mcp_servers Query aliases.
  // Earlier snake_case names (service_category/status_filter/health_status)
  // were silently ignored by FastAPI, so the filter bar was a no-op.
  const [filters, setFilters] = useState<{
    keyword?: string
    serviceCategory?: string
    status?: string
    healthStatus?: string
  }>({})
  const [pendingFilters, setPendingFilters] = useState<typeof filters>({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit'>('create')
  const [editingDetail, setEditingDetail] = useState<MCPServerDetail | null>(null)

  const fetchStats = async () => {
    try {
      const s = await api.get<MCPServerStats>('/mcp-servers/stats')
      setStats(s)
    } catch {
      message.error(t('mcp_server_list_msg_fetch_stats_failed'))
    }
  }

  const fetchList = async () => {
    setLoading(true)
    try {
      const res = await api.get<{ total: number; items: MCPServerListItem[] }>(
        '/mcp-servers',
        { params: { page, size, ...filters } },
      )
      setServers(res.items || [])
      setTotal(res.total || 0)
    } catch {
      message.error(t('mcp_server_list_msg_fetch_list_failed'))
      setServers([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchStats() }, [])
  useEffect(() => { fetchList() }, [page, size, filters])

  const onQuery = () => {
    setPage(1)
    setFilters({ ...pendingFilters })
  }

  const onReset = () => {
    setPendingFilters({})
    setPage(1)
    setFilters({})
  }

  const reloadAll = () => {
    fetchStats()
    fetchList()
  }

  const onCreate = () => {
    setDrawerMode('create')
    setEditingDetail(null)
    setDrawerOpen(true)
  }

  const onEdit = async (server: MCPServerListItem) => {
    try {
      const detail = await api.get<MCPServerDetail>(`/mcp-servers/${server.id}`)
      setEditingDetail(detail)
      setDrawerMode('edit')
      setDrawerOpen(true)
    } catch {
      message.error(t('mcp_server_list_msg_fetch_detail_failed'))
    }
  }

  // Task 6: route to detail page instead of opening edit drawer.
  const onViewDetail = (server: MCPServerListItem) => {
    navigate(`/mcp/${server.id}`)
  }

  const onTest = async (server: MCPServerListItem) => {
    const hide = message.loading(t('mcp_server_list_msg_testing', { name: server.name }), 0)
    try {
      const res = await api.post<any>(`/mcp-servers/${server.id}/test`, {})
      hide()
      if (res.status === 'normal') {
        message.success(t('mcp_server_list_msg_test_ok', {
          ms: res.response_time_ms,
          count: res.capabilities_discovered,
        }))
      } else {
        message.error(t('mcp_server_list_msg_test_fail', {
          type: res.error_type || '',
          message: res.error_message || '',
        }).trim())
      }
      reloadAll()
    } catch (e: any) {
      hide()
      message.error(e?.response?.data?.detail || t('mcp_server_list_msg_test_error'))
    }
  }

  const onSync = async (server: MCPServerListItem) => {
    const hide = message.loading(t('mcp_server_list_msg_syncing', { name: server.name }), 0)
    try {
      const res = await api.post<any>(`/mcp-servers/${server.id}/sync`, {})
      hide()
      const caps = res.capabilities || {}
      message.success(t('mcp_server_list_msg_sync_done', {
        status: res.status,
        added: caps.added || 0,
        updated: caps.updated || 0,
        removed: caps.removed || 0,
      }))
      reloadAll()
    } catch (e: any) {
      hide()
      message.error(e?.response?.data?.detail || t('mcp_server_list_msg_sync_error'))
    }
  }

  const onToggle = async (server: MCPServerListItem) => {
    const next = server.status === 'enabled' ? 'disable' : 'enable'
    try {
      await api.post(`/mcp-servers/${server.id}/${next}`, {})
      message.success(t(server.status === 'enabled'
        ? 'mcp_server_list_msg_disabled' : 'mcp_server_list_msg_enabled'))
      reloadAll()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('mcp_server_list_msg_action_error'))
    }
  }

  const onDelete = (server: MCPServerListItem) => {
    const needsDisable = server.status === 'enabled'
    Modal.confirm({
      title: t('mcp_server_list_delete_title', { name: server.name }),
      content: t(needsDisable
        ? 'mcp_server_list_delete_content_disable_first'
        : 'mcp_server_list_delete_content'),
      okText: t('mcp_server_list_delete_ok'),
      okType: 'danger',
      cancelText: t('mcp_server_list_delete_cancel'),
      onOk: async () => {
        try {
          if (needsDisable) {
            await api.post(`/mcp-servers/${server.id}/disable`, {})
          }
          await api.delete(`/mcp-servers/${server.id}`)
          message.success(t('mcp_server_list_msg_deleted'))
          reloadAll()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('mcp_server_list_msg_delete_failed'))
        }
      },
    })
  }

  const moreMenu = (server: MCPServerListItem): MenuProps['items'] => [
    { key: 'edit', icon: <EditOutlined />, label: t('mcp_server_list_action_edit'), onClick: () => onEdit(server) },
    { key: 'sync', icon: <SyncOutlined />, label: t('mcp_server_list_action_sync'), onClick: () => onSync(server) },
    {
      key: 'toggle',
      icon: server.status === 'enabled' ? <PoweroffOutlined /> : <PlayCircleOutlined />,
      label: t(server.status === 'enabled'
        ? 'mcp_server_list_action_disable'
        : 'mcp_server_list_action_enable'),
      onClick: () => onToggle(server),
    },
    { type: 'divider' },
    { key: 'delete', icon: <DeleteOutlined />, label: t('mcp_server_list_action_delete'), danger: true, onClick: () => onDelete(server) },
  ]

  // 注:columns 通过 useMemo 缓存,deps 留 [t] 以便切语言时表头跟着重渲染。
  const columns = useMemo(() => ([
    {
      title: t('mcp_server_list_col_name'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      ellipsis: true,
      render: (name: string, record: MCPServerListItem) => (
        <Space style={{ whiteSpace: 'nowrap' }}>
          <ApiOutlined style={{ color: '#1890ff' }} />
          <a onClick={() => onViewDetail(record)}>{name}</a>
        </Space>
      ),
    },
    { title: t('mcp_server_list_col_code'), dataIndex: 'code', key: 'code', width: 160, ellipsis: true,
      render: (v: string) => <Text code style={{ whiteSpace: 'nowrap' }}>{v}</Text> },
    {
      title: t('mcp_server_list_col_category'),
      dataIndex: 'service_category',
      key: 'service_category',
      width: 110,
      render: (c: string) => <Tag>{t(`mcp_category_${c}`, { defaultValue: c })}</Tag>,
    },
    {
      title: t('mcp_server_list_col_connection_type'),
      dataIndex: 'connection_type',
      key: 'connection_type',
      width: 100,
      render: (c: string) => <Tag>{c.toUpperCase()}</Tag>,
    },
    {
      title: t('mcp_server_list_col_status'),
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: string) => (
        <Tag color={STATUS_COLORS[s] || 'default'}>{t(`mcp_status_${s}`, { defaultValue: s })}</Tag>
      ),
    },
    {
      title: t('mcp_server_list_col_health'),
      dataIndex: 'health_status',
      key: 'health_status',
      width: 110,
      render: (h: string, row: MCPServerListItem) => {
        // configuration_status='incomplete' (needs-connection server with
        // no binding) demotes whatever transport-level health says —
        // backend is the single source of truth, see
        // _compute_configuration_status in services/mcp_servers.py.
        if (row.configuration_status === 'incomplete') {
          return <Tag color="error">{t('mcp_health_incomplete')}</Tag>
        }
        return (
          <Tag color={HEALTH_COLORS[h] || 'default'}>{t(`mcp_health_${h}`, { defaultValue: h })}</Tag>
        )
      },
    },
    {
      title: t('mcp_server_list_col_capability_count'),
      dataIndex: 'capability_count',
      key: 'capability_count',
      width: 100,
      align: 'right' as const,
      render: (n: number) => <Tag color="blue">{n ?? 0}</Tag>,
    },
    {
      title: t('mcp_server_list_col_authorized_count'),
      dataIndex: 'authorized_principal_count',
      key: 'authorized_principal_count',
      width: 120,
      align: 'right' as const,
      render: (n: number) => <Tag color="geekblue">{n ?? 0}</Tag>,
    },
    {
      title: t('mcp_server_list_col_last_checked'),
      dataIndex: 'last_checked_at',
      key: 'last_checked_at',
      width: 170,
      render: fmt,
    },
    {
      title: t('mcp_server_list_col_actions'),
      key: 'actions',
      width: 220,
      fixed: 'right' as const,
      render: (_: any, record: MCPServerListItem) => (
        <Space size="small">
          <Tooltip title={t('mcp_server_list_action_view')}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => onViewDetail(record)} />
          </Tooltip>
          <Tooltip title={t('mcp_server_list_action_test')}>
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => onTest(record)} />
          </Tooltip>
          <Dropdown menu={{ items: moreMenu(record) }} trigger={['click']}>
            <Button size="small" icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      ),
    },
  ]), [t])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <Title level={2} style={{ margin: 0 }}>{t('mcp_server_list_page_title')}</Title>
          <Text type="secondary">{t('mcp_server_list_page_description')}</Text>
        </div>
        <Space>
          <Tooltip title={t('mcp_server_list_external_conn_tooltip')}>
            <Button icon={<LinkOutlined />} onClick={() => navigate('/mcp-connections')}>
              {t('mcp_server_list_external_conn_button')}
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={reloadAll}>{t('mcp_server_list_refresh_button')}</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>{t('mcp_server_list_add_button')}</Button>
        </Space>
      </div>

      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <Card><Statistic title={t('mcp_server_list_stats_total')} value={stats?.total ?? 0} /></Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title={t('mcp_server_list_stats_running')}
              value={stats ? Math.min(stats.enabled, stats.normal) : 0}
              valueStyle={{ color: '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title={t('mcp_server_list_stats_abnormal')} value={stats?.abnormal ?? 0} valueStyle={{ color: '#cf1322' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic title={t('mcp_server_list_stats_disabled')} value={stats?.disabled ?? 0} valueStyle={{ color: '#8c8c8c' }} />
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col xs={24} sm={12} md={6}>
            <Input
              placeholder={t('mcp_server_list_filter_keyword_placeholder')}
              allowClear
              prefix={<SearchOutlined />}
              value={pendingFilters.keyword || ''}
              onChange={(e) => setPendingFilters({ ...pendingFilters, keyword: e.target.value })}
              onPressEnter={onQuery}
            />
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Select
              placeholder={t('mcp_server_list_filter_category_placeholder')}
              allowClear
              style={{ width: '100%' }}
              value={pendingFilters.serviceCategory}
              onChange={(v) => setPendingFilters({ ...pendingFilters, serviceCategory: v })}
              options={SERVICE_CATEGORY_VALUES.map((v) => ({ value: v, label: t(`mcp_category_${v}`) }))}
            />
          </Col>
          <Col xs={12} sm={6} md={3}>
            <Select
              placeholder={t('mcp_server_list_filter_status_placeholder')}
              allowClear
              style={{ width: '100%' }}
              value={pendingFilters.status}
              onChange={(v) => setPendingFilters({ ...pendingFilters, status: v })}
              options={[
                { value: 'enabled', label: t('mcp_status_enabled') },
                { value: 'disabled', label: t('mcp_status_disabled') },
              ]}
            />
          </Col>
          <Col xs={12} sm={6} md={4}>
            <Select
              placeholder={t('mcp_server_list_filter_health_placeholder')}
              allowClear
              style={{ width: '100%' }}
              value={pendingFilters.healthStatus}
              onChange={(v) => setPendingFilters({ ...pendingFilters, healthStatus: v })}
              options={[
                { value: 'normal', label: t('mcp_health_normal') },
                { value: 'abnormal', label: t('mcp_health_abnormal') },
                { value: 'unchecked', label: t('mcp_health_unchecked') },
              ]}
            />
          </Col>
          <Col>
            <Space>
              <Button type="primary" onClick={onQuery}>{t('mcp_server_list_filter_query_button')}</Button>
              <Button onClick={onReset}>{t('mcp_server_list_filter_reset_button')}</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={servers}
        columns={columns}
        scroll={{ x: 1400 }}
        locale={{ emptyText: <Empty description={t('mcp_server_list_empty')} /> }}
        pagination={{
          current: page,
          pageSize: size,
          total,
          showSizeChanger: true,
          showTotal: (n) => t('mcp_server_list_pagination_total', { count: n }),
          onChange: (p, ps) => { setPage(p); setSize(ps) },
        }}
      />

      <ServerDrawer
        open={drawerOpen}
        mode={drawerMode}
        detail={editingDetail}
        onClose={() => setDrawerOpen(false)}
        onSaved={reloadAll}
      />
    </div>
  )
}

export default McpServerList
