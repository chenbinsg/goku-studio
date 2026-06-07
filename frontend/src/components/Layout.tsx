import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Grid } from 'antd'
import AiosLogo from './AiosLogo'
import CityClockWidget from './CityClockWidget'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  Layout as AntLayout,
  Menu,
  Avatar,
  Dropdown,
  Badge,
  Space,
  Typography,
  theme,
  Popover,
  List,
  Tag,
  Empty,
  Button,
  Tooltip,
  notification,
  Drawer,
} from 'antd'
import {
  DashboardOutlined,
  RobotOutlined,
  SafetyOutlined,
  CloudOutlined,
  ApartmentOutlined,
  SettingOutlined,
  BellOutlined,
  UserOutlined,
  LogoutOutlined,
  DownOutlined,
  MessageOutlined,
  ApiOutlined,
  SunOutlined,
  MoonOutlined,
  ExclamationCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  MenuOutlined,
  BarChartOutlined,
  DollarOutlined,
  MailOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { notificationApi, approvalApi, emailQueueApi, authApi } from '../api'
import LanguageSwitcher from './LanguageSwitcher'
import { usePermissions } from '../hooks/usePermissions'

const { Header, Sider, Content } = AntLayout
const { Text } = Typography
const { useBreakpoint } = Grid

const Layout: React.FC = () => {
  const { t } = useTranslation()
  const [collapsed] = useState(false)
  const screens = useBreakpoint()
  const isMobile = !screens.md   // < 768px
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [notifications, setNotifications] = useState<any[]>([])
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0)
  const prevApprovalCountRef = useRef(0)
  const navigate = useNavigate()
  const location = useLocation()
  const [newEmailCount, setNewEmailCount] = useState(0)
  const { user, logout } = useAuthStore()
  const { hasPermission, isSuperuser: isAdmin } = usePermissions()
  const { isDark, toggle: toggleTheme } = useThemeStore()
  const {
    token: { colorBgContainer },
  } = theme.useToken()

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await notificationApi.list({ unread_only: true, page: 1, size: 10 })
      setNotifications(res.items || [])
    } catch {
      // ignore
    }
  }, [])

  const fetchPendingApprovals = useCallback(async () => {
    try {
      const res = await approvalApi.list({ status: 'pending', page: 1, size: 20 })
      const items: any[] = res.items || []
      // Only count non-expired approvals (< 24h old)
      const now = Date.now()
      const active = items.filter(a => (now - new Date(a.created_at).getTime()) < 24 * 60 * 60 * 1000)
      const count = active.length
      // Show a toast notification when new approvals arrive
      if (count > prevApprovalCountRef.current && !location.pathname.startsWith('/approvals')) {
        notification.warning({
          key: 'pending-approval',
          message: t('layout_approval_notification_message'),
          description: t('layout_approval_notification_description', { count }),
          icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
          btn: (
            <Button size="small" type="primary" onClick={() => { navigate('/approvals'); notification.destroy('pending-approval') }}>
              {t('layout_approval_notification_button')}
            </Button>
          ),
          duration: 0,   // don't auto-close
        })
      } else if (count === 0) {
        notification.destroy('pending-approval')
      }
      prevApprovalCountRef.current = count
      setPendingApprovalCount(count)
    } catch {
      // ignore
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    fetchNotifications()
    const timer = setInterval(fetchNotifications, 30000)
    return () => clearInterval(timer)
  }, [fetchNotifications])

  useEffect(() => {
    fetchPendingApprovals()
    const timer = setInterval(fetchPendingApprovals, 15000)
    return () => clearInterval(timer)
  }, [fetchPendingApprovals])

  const fetchNewEmailCount = useCallback(async () => {
    try {
      const s = await emailQueueApi.stats()
      setNewEmailCount(s.new || 0)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchNewEmailCount()
    const timer = setInterval(fetchNewEmailCount, 30000)
    return () => clearInterval(timer)
  }, [fetchNewEmailCount])

  // ── Permission-filtered AI features submenu ───────────────────────────────
  // /agents and /memory and /knowledge stay visible to all — users need them.
  // Infrastructure/config items are gated by specific permissions.
  const aiChildren = [
    { key: '/agents',                    label: t('layout_agent_management_label') },
    hasPermission('agents.write')      && { key: '/agents/runtime',             label: '⚡ 并发运行状态' },
    hasPermission('tools.read')        && { key: '/tools',                      label: t('layout_tools_label') },
    // models page removed — LLM catalog is managed by Goku Router, not AIOS
    hasPermission('memory.read')       && { key: '/memory',                     label: t('layout_memory_label') },
    { key: '/knowledge',                 label: t('layout_knowledge_label') },
    hasPermission('knowledge.write')   && { key: '/agent-knowledge',            label: t('layout_agent_knowledge_label') },
    hasPermission('system.config.write') && { key: '/knowledge/external-sources', label: t('layout_external_sources_label') },
    hasPermission('skills.manage')     && { key: '/skills',                     label: t('layout_skills_label') },
  ].filter(Boolean) as { key: string; label: string }[]

  // ── 用户与访问管理（IAM）子菜单 ────────────────────────────────────────────
  // Groups: user CRUD + role CRUD + external identity sources (SSO / user sync).
  // Kept separate from system config so access can be granted independently.
  const iamChildren = [
    hasPermission('users.read') && { key: '/users',        label: t('layout_users_label') },
    hasPermission('roles.read') && { key: '/roles',        label: t('layout_roles_label') },
    isAdmin                     && { key: '/admin/sso',    label: t('layout_enterprise_sso_label', '企业 SSO') },
    isAdmin                     && { key: '/admin/zhuyun', label: t('layout_user_sync_label', '用户同步') },
    isAdmin                     && { key: '/admin/unicall', label: t('layout_unicall_label', 'UniCall 网关') },
  ].filter(Boolean) as { key: string; label: string }[]

  // ── Permission-filtered admin submenu ─────────────────────────────────────
  // Build the children list for the "系统管理" submenu based on the current
  // user's effective permissions.  Superusers always see everything.
  const adminChildren = [
    hasPermission('system.config.write') && { key: '/system/soul',       label: t('layout_agent_identity_label') },
    hasPermission('system.config.write') && { key: '/system/config',     label: t('layout_system_settings_label') },
    hasPermission('system.config.write') && { key: '/system/connectors', label: t('layout_channel_config_label', '渠道接入配置') },
    hasPermission('system.config.write') && { key: '/system/api-keys',   label: '开放 API Keys' },
    isAdmin                              && { key: '/system/proposals',   label: t('layout_proposals_label', '自我进化提案') },
    isAdmin                              && { key: '/org',                label: t('layout_org_label', '组织架构') },
    ...(iamChildren.length > 0 ? [{ key: 'iam', label: t('layout_iam_label', '用户与访问管理'), children: iamChildren }] : []),
    isAdmin                              && { key: '/tenants',            label: '租户管理' },
    isAdmin                              && { key: '/admin/stateful-policies', label: '状态动作策略' },
    isAdmin                              && { key: '/admin/stateful-audit',    label: '状态转移审计' },
    hasPermission('audit.logs.read')     && { key: '/audit/logs',        label: t('layout_audit_logs_label') },
  ].filter(Boolean) as any[]

  const menuItems = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('layout_dashboard_label') },
    { key: '/chat', icon: <MessageOutlined />, label: t('layout_chat_label') },
    { type: 'divider' as const },

    // ── 核心功能 ──
    { key: '/tasks/kanban', icon: <RobotOutlined />, label: t('layout_tasks_label') },
    { key: '/workflows', icon: <ApartmentOutlined />, label: t('layout_workflows_label') },
    { key: '/schedules', icon: <ClockCircleOutlined />, label: t('layout_schedules_label') },

    {
      key: '/approvals',
      icon: <SafetyOutlined />,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {t('layout_approvals_label')}
          {pendingApprovalCount > 0 && (
            <Badge count={pendingApprovalCount} size="small" style={{ marginLeft: 8 }} />
          )}
        </span>
      ),
    },
    {
      key: '/email-queue',
      icon: <MailOutlined />,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {t('layout_email_queue_label')}
          {newEmailCount > 0 && (
            <Badge count={newEmailCount} size="small" style={{ marginLeft: 8 }} />
          )}
        </span>
      ),
    },
    { type: 'divider' as const },

    // ── AI 能力（基础设施项按权限过滤）──
    {
      key: 'ai',
      icon: <CloudOutlined />,
      label: t('layout_section_ai_features'),
      children: aiChildren,
    },

    // ── 扩展（配置类，需 system.config 权限）──
    ...(hasPermission('mcp.manage')        ? [{ key: '/mcp',        icon: <ApiOutlined />,     label: t('layout_mcp_servers_label') }]           : []),
    ...(hasPermission('connectors.manage') ? [{ key: '/connectors', icon: <MessageOutlined />, label: t('layout_message_channels_label', '消息渠道') }]     : []),
    { type: 'divider' as const },

    // ── 文档中心 ──
    { key: '/docs', icon: <FileTextOutlined />, label: t('layout_docs_label') },
    { type: 'divider' as const },

    // ── 数据分析（需费用查看权限）──
    ...(hasPermission('costs.read') ? [
      { key: '/analytics', icon: <BarChartOutlined />, label: '互动分析' },
      { key: '/billing',   icon: <DollarOutlined />,   label: '智能体账单' },
    ] : []),
    { type: 'divider' as const },

    // ── 系统管理（仅对有权限的用户显示对应项）──
    ...(adminChildren.length > 0
      ? [
          {
            key: 'admin',
            icon: <SettingOutlined />,
            label: t('layout_section_admin'),
            children: adminChildren,
          },
        ]
      : []),
  ]

  const getSelectedKeys = () => {
    const path = location.pathname
    if (path === '/' || path === '/dashboard') return ['/dashboard']
    // All /tasks/* sub-routes highlight the Tasks menu item
    if (path.startsWith('/tasks')) return ['/tasks']
    return [path]
  }

  const handleMenuClick = ({ key }: { key: string }) => {
    navigate(key)
    if (isMobile) setDrawerOpen(false)
  }

  const handleLogout = async () => {
    try {
      const res = await authApi.logout()
      logout()
      if (res?.sso_logout_url) {
        window.location.href = res.sso_logout_url
        return
      }
    } catch {
      // Token already expired or network error — clear local state anyway
      logout()
    }
    navigate('/login')
  }

  const userMenuItems = [
    {
      key: '/profile',
      icon: <UserOutlined />,
      label: t('layout_user_profile'),
    },
    ...(isAdmin ? [{
      key: '/users',
      icon: <SettingOutlined />,
      label: t('layout_user_management'),
    }] : []),
    {
      type: 'divider' as const,
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: t('layout_logout'),
      onClick: handleLogout,
    },
  ]

  const sidebarContent = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AiosLogo collapsed={false} />
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 32 }}>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={getSelectedKeys()}
          items={menuItems}
          onClick={handleMenuClick}
          style={{ borderRight: 0 }}
        />
      </div>
      <div style={{ flexShrink: 0, padding: '8px 0', textAlign: 'center', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{t('layout_copyright')}</span>
      </div>
    </div>
  )

  return (
    <AntLayout>
      {/* Desktop sidebar */}
      {!isMobile && (
        <Sider
          trigger={null}
          collapsible
          collapsed={collapsed}
          theme="dark"
          width={220}
          style={{ display: 'flex', flexDirection: 'column', height: '100vh', position: 'sticky', top: 0 }}
        >
          {sidebarContent}
        </Sider>
      )}

      {/* Mobile drawer */}
      {isMobile && (
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={240}
          styles={{ body: { padding: 0, background: '#001529' }, header: { display: 'none' } }}
        >
          {sidebarContent}
        </Drawer>
      )}

      <AntLayout>
        <Header style={{
          background: colorBgContainer,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isMobile ? '0 12px' : '0 24px',
          height: isMobile ? 52 : 64,
        }}>
          {/* Mobile: hamburger; Desktop: city clock */}
          {isMobile ? (
            <Button
              type="text"
              icon={<MenuOutlined style={{ fontSize: 20 }} />}
              onClick={() => setDrawerOpen(true)}
            />
          ) : (
            <CityClockWidget isDark={isDark} />
          )}

          <Space size={isMobile ? 8 : 16}>
            {/* Language switcher — hidden on mobile */}
            {!isMobile && <LanguageSwitcher />}

            {/* Day / Night toggle */}
            <Tooltip title={isDark ? t('layout_tooltip_switch_day') : t('layout_tooltip_switch_night')}>
              <Button
                type="text"
                icon={isDark ? <SunOutlined style={{ fontSize: 18 }} /> : <MoonOutlined style={{ fontSize: 18 }} />}
                onClick={toggleTheme}
              />
            </Tooltip>

            {/* Notification bell */}
            <Popover
              title={t('layout_notification_title')}
              trigger="click"
              placement="bottomRight"
              content={
                notifications.length === 0 ? (
                  <Empty description={t('layout_notification_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <List
                    size="small"
                    style={{ width: 320, maxHeight: 400, overflow: 'auto' }}
                    dataSource={notifications}
                    renderItem={(item: any) => (
                      <List.Item
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          notificationApi.markRead(item.id)
                          setNotifications(prev => prev.filter(n => n.id !== item.id))
                        }}
                      >
                        <List.Item.Meta
                          title={
                            <Space>
                              <Tag color="blue">{t('layout_notification_tag')}</Tag>
                              <span style={{ fontSize: 12 }}>{item.title}</span>
                            </Space>
                          }
                          description={<span style={{ fontSize: 12 }}>{(item.content || '').slice(0, 60)}</span>}
                        />
                      </List.Item>
                    )}
                  />
                )
              }
            >
              <Badge count={notifications.length} size="small">
                <BellOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
              </Badge>
            </Popover>

            {/* User menu */}
            <Dropdown menu={{ items: userMenuItems, onClick: ({ key }) => { if (key !== 'logout') navigate(key) } }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar icon={<UserOutlined />} src={user?.avatar} size={isMobile ? 'small' : 'default'} />
                {!isMobile && <Text>{user?.username || 'Admin'}</Text>}
                {!isMobile && <DownOutlined />}
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{
          margin: isMobile ? '8px 8px' : 24,
          overflow: 'initial',
          // Reserve space for iOS home indicator
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 0px)' : 0,
        }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  )
}

export default Layout
