<<<<<<< HEAD
import React from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button, Tooltip, Space, theme as antTheme } from 'antd'
=======
/**
 * StudioLayout — sidebar navigation for Goku Studio.
 *
 * Mirrors the Studio section of goku-core's Layout.tsx but scoped to Studio
 * pages only.  Includes a "Return to Runtime" button that sends the user back
 * to goku-core with their JWT so they don't need to re-login.
 */
import React, { useState, useEffect } from 'react'
import {
  Layout as AntLayout,
  Menu,
  Avatar,
  Dropdown,
  Space,
  Typography,
  theme,
  Button,
  Tooltip,
  Drawer,
} from 'antd'
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
import {
  RobotOutlined,
  ApartmentOutlined,
  ToolOutlined,
  ApiOutlined,
  BookOutlined,
  DatabaseOutlined,
<<<<<<< HEAD
  ThunderboltOutlined,
  AppstoreOutlined,
  LinkOutlined,
  FileTextOutlined,
  ArrowLeftOutlined,
  BulbOutlined,
  EditOutlined,
  BulbFilled,
  BranchesOutlined,
  AuditOutlined,
  LogoutOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import LanguageSwitcher from './LanguageSwitcher'

const { Sider, Content, Header } = Layout

const RUNTIME_URL = (import.meta.env.VITE_RUNTIME_URL as string | undefined) || 'http://localhost:5106'

function goToRuntime(token: string | null, refreshToken: string | null) {
=======
  BulbOutlined,
  AppstoreOutlined,
  MessageOutlined,
  FileTextOutlined,
  UserOutlined,
  LogoutOutlined,
  ArrowLeftOutlined,
  SunOutlined,
  MoonOutlined,
  MenuOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { usePermissions } from '../hooks/usePermissions'

const { Sider, Content, Header } = AntLayout
const { Text } = Typography

const RUNTIME_URL = (import.meta.env.VITE_RUNTIME_URL as string | undefined) || 'http://localhost:5106'

function goToRuntime(path: string, token: string | null, refreshToken: string | null) {
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
  const params = new URLSearchParams()
  if (token) params.set('_token', token)
  if (refreshToken) params.set('_refresh_token', refreshToken)
  const qs = params.toString()
<<<<<<< HEAD
  window.location.href = `${RUNTIME_URL}${qs ? `?${qs}` : ''}`
}

export default function StudioLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { token, refreshToken, logout } = useAuthStore()
  const { isDark, toggle } = useThemeStore()
  const { t } = useTranslation()
  const { token: colorToken } = antTheme.useToken()

  const menuItems = [
    // ── Builder ─────────────────────────────────────────────────────────────
    { key: '/agents',      icon: <RobotOutlined />,      label: t('layout_agent_management_label', 'Agents') },
    { key: '/workflows',   icon: <ApartmentOutlined />,  label: t('layout_workflows_label', 'Workflows') },
    { key: '/tools',       icon: <ToolOutlined />,        label: t('layout_tools_label', 'Tools') },
    { key: '/mcp',         icon: <ApiOutlined />,         label: t('layout_mcp_servers_label', 'MCP Servers') },
    { key: '/knowledge',   icon: <BookOutlined />,        label: t('layout_knowledge_label', 'Knowledge') },
    { key: '/memory',      icon: <DatabaseOutlined />,    label: t('layout_memory_label', 'Memory') },
    { key: '/skills',      icon: <ThunderboltOutlined />, label: t('layout_skills_label', 'Skills') },
    { key: '/plugins',     icon: <AppstoreOutlined />,    label: t('layout_plugins_label', 'Plugins') },
    { key: '/connectors',  icon: <LinkOutlined />,        label: t('layout_message_connectors_label', 'Connectors') },
    { key: '/docs',        icon: <FileTextOutlined />,    label: t('layout_docs_label', 'Doc Center') },
    // ── Agent config ────────────────────────────────────────────────────────
    { type: 'divider' as const, key: 'divider-admin' },
    { key: '/system/soul',             icon: <EditOutlined />,     label: t('layout_agent_identity_label', '全局指令') },
    { key: '/system/proposals',        icon: <BulbFilled />,       label: t('layout_proposals_label', '自我进化提案') },
    { key: '/admin/stateful-policies', icon: <BranchesOutlined />, label: t('layout_stateful_policies_label', '状态动作策略') },
    { key: '/admin/stateful-audit',    icon: <AuditOutlined />,    label: t('layout_stateful_audit_label', '状态转移审计') },
  ]

  const selectedKey = menuItems.find(item =>
    item.key && item.key !== 'divider-admin' && location.pathname.startsWith(item.key)
  )?.key || '/agents'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme={isDark ? 'dark' : 'light'}
        width={220}
        style={{ borderRight: '1px solid var(--border-color, #f0f0f0)' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Logo */}
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid rgba(128,128,128,0.15)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}>
            <img
              src="/icon-512.png"
              alt="Goku"
              style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
            />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Goku Studio</span>
          </div>

          <Menu
            mode="inline"
            theme={isDark ? 'dark' : 'light'}
            selectedKeys={[selectedKey]}
            items={menuItems.map(item =>
              item.type === 'divider'
                ? { type: 'divider' as const, key: item.key }
                : {
                    key: item.key,
                    icon: item.icon,
                    label: item.label,
                    onClick: () => navigate(item.key),
                  }
            )}
            style={{ borderRight: 0, flex: 1, overflowY: 'auto' }}
          />

          {/* Bottom actions */}
          <div style={{
            padding: '12px 16px',
            borderTop: '1px solid rgba(128,128,128,0.15)',
            display: 'flex', flexDirection: 'column', gap: 8,
            flexShrink: 0,
          }}>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => goToRuntime(token, refreshToken)}
              style={{ width: '100%' }}
            >
              {t('return_to_runtime', '返回运行台')}
            </Button>
            <Button
              type="text"
              danger
              icon={<LogoutOutlined />}
              onClick={() => { logout(); window.location.href = RUNTIME_URL }}
              style={{ width: '100%', textAlign: 'left' }}
            >
              {t('logout', 'Logout')}
            </Button>
          </div>
        </div>
      </Sider>

      <Layout>
        <Header style={{
          background: colorToken.colorBgContainer,
          borderBottom: `1px solid ${colorToken.colorBorderSecondary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: '0 24px',
          height: 48,
        }}>
          <Space size={12}>
            <LanguageSwitcher />
            <Tooltip title={isDark ? t('light_mode', 'Light mode') : t('dark_mode', 'Dark mode')}>
              <Button type="text" icon={<BulbOutlined />} onClick={toggle} />
            </Tooltip>
          </Space>
        </Header>
        <Content style={{ padding: '24px', overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
=======
  window.location.href = `${RUNTIME_URL}${path}${qs ? `?${qs}` : ''}`
}

export default function StudioLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { token: colorToken } = theme.useToken()
  const { isDark, toggle: toggleTheme } = useThemeStore()
  const { user, token, refreshToken, logout } = useAuthStore()
  const { hasPermission, isSuperuser: isAdmin } = usePermissions()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)

  // Determine which menu item is selected
  const selectedKey = '/' + location.pathname.split('/')[1]

  const handleLogout = async () => {
    logout()
    window.location.href = `${RUNTIME_URL}/login`
  }

  const userMenu = [
    {
      key: 'return',
      icon: <ArrowLeftOutlined />,
      label: '返回 Runtime',
      onClick: () => goToRuntime('/dashboard', token, refreshToken),
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: t('layout_logout_label', '退出登录'),
      onClick: handleLogout,
    },
  ]

  const menuItems = [
    {
      key: '/agents',
      icon: <RobotOutlined />,
      label: t('layout_agent_management_label', '智能体'),
      onClick: () => navigate('/agents'),
    },
    {
      key: '/workflows',
      icon: <ApartmentOutlined />,
      label: t('layout_workflows_label', '工作流'),
      onClick: () => navigate('/workflows'),
    },
    hasPermission('tools.read') && {
      key: '/tools',
      icon: <ToolOutlined />,
      label: t('layout_tools_label', '工具'),
      onClick: () => navigate('/tools'),
    },
    hasPermission('mcp.manage') && {
      key: '/mcp',
      icon: <ApiOutlined />,
      label: t('layout_mcp_servers_label', 'MCP 服务器'),
      onClick: () => navigate('/mcp'),
    },
    {
      key: '/knowledge',
      icon: <BookOutlined />,
      label: t('layout_knowledge_label', '知识库'),
      onClick: () => navigate('/knowledge'),
    },
    hasPermission('memory.read') && {
      key: '/memory',
      icon: <DatabaseOutlined />,
      label: t('layout_memory_label', '记忆'),
      onClick: () => navigate('/memory'),
    },
    hasPermission('skills.manage') && {
      key: '/skills',
      icon: <BulbOutlined />,
      label: t('layout_skills_label', '自动技能'),
      onClick: () => navigate('/skills'),
    },
    {
      key: '/plugins',
      icon: <AppstoreOutlined />,
      label: t('layout_plugins_label', '插件市场'),
      onClick: () => navigate('/plugins'),
    },
    hasPermission('connectors.manage') && {
      key: '/connectors',
      icon: <MessageOutlined />,
      label: t('layout_message_channels_label', '消息渠道'),
      onClick: () => navigate('/connectors'),
    },
    {
      key: '/docs',
      icon: <FileTextOutlined />,
      label: t('layout_docs_label', '文档中心'),
      onClick: () => navigate('/docs'),
    },
  ].filter(Boolean) as any[]

  const siderContent = (
    <>
      {/* Logo / title */}
      <div
        style={{
          padding: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: `1px solid ${colorToken.colorBorderSecondary}`,
        }}
      >
        <RobotOutlined style={{ fontSize: 20, color: colorToken.colorPrimary }} />
        {!collapsed && (
          <Text strong style={{ fontSize: 15 }}>
            Goku Studio
          </Text>
        )}
      </div>

      {/* Back to Runtime shortcut */}
      {!collapsed && (
        <div style={{ padding: '8px 16px' }}>
          <Button
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => goToRuntime('/dashboard', token, refreshToken)}
            style={{ width: '100%' }}
          >
            返回 Runtime
          </Button>
        </div>
      )}

      <Menu
        mode="inline"
        selectedKeys={[selectedKey]}
        inlineCollapsed={collapsed}
        items={menuItems}
        style={{ border: 'none', flex: 1 }}
      />
    </>
  )

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      {/* Desktop sider */}
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        breakpoint="lg"
        collapsedWidth={56}
        style={{
          background: colorToken.colorBgContainer,
          borderRight: `1px solid ${colorToken.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {siderContent}
      </Sider>

      <AntLayout>
        {/* Header */}
        <Header
          style={{
            background: colorToken.colorBgContainer,
            borderBottom: `1px solid ${colorToken.colorBorderSecondary}`,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 48,
          }}
        >
          {/* Mobile hamburger */}
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setMobileDrawerOpen(true)}
            style={{ display: 'none' }}
            className="mobile-menu-btn"
          />
          <div />

          {/* Right side: theme toggle + user avatar */}
          <Space>
            <Tooltip title={isDark ? t('layout_light_mode_label') : t('layout_dark_mode_label')}>
              <Button
                type="text"
                icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggleTheme}
              />
            </Tooltip>

            <Dropdown menu={{ items: userMenu }} placement="bottomRight">
              <Avatar
                size={32}
                icon={<UserOutlined />}
                src={user?.avatar}
                style={{ cursor: 'pointer', background: colorToken.colorPrimary }}
              />
            </Dropdown>
          </Space>
        </Header>

        {/* Page content */}
        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </AntLayout>

      {/* Mobile nav drawer */}
      <Drawer
        placement="left"
        open={mobileDrawerOpen}
        onClose={() => setMobileDrawerOpen(false)}
        width={240}
        styles={{ body: { padding: 0 } }}
      >
        {siderContent}
      </Drawer>
    </AntLayout>
>>>>>>> 1f8749159addca72722fdb94d3bf713a82b78b50
  )
}
