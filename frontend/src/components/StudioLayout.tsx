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
import {
  RobotOutlined,
  ApartmentOutlined,
  ToolOutlined,
  ApiOutlined,
  BookOutlined,
  DatabaseOutlined,
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
  SettingOutlined,
  TeamOutlined,
  SafetyCertificateOutlined,
  KeyOutlined,
  AuditOutlined,
  GlobalOutlined,
  ClusterOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { useThemeStore } from '../stores/theme'
import { usePermissions } from '../hooks/usePermissions'
import LanguageSwitcher from './LanguageSwitcher'

const { Sider, Content, Header } = AntLayout
const { Text } = Typography

const RUNTIME_URL =
  (window as any).__APP_CONFIG__?.VITE_RUNTIME_URL ||
  ((import.meta as any).env?.VITE_RUNTIME_URL as string | undefined) ||
  'http://localhost:5106'

function goToRuntime(path: string, token: string | null, refreshToken: string | null) {
  const params = new URLSearchParams()
  if (token) params.set('_token', token)
  if (refreshToken) params.set('_refresh_token', refreshToken)
  const qs = params.toString()
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
  const selectedKey = location.pathname.startsWith('/system/')
    ? location.pathname
    : '/' + location.pathname.split('/')[1]

  const handleLogout = async () => {
    logout()
    window.location.href = `${RUNTIME_URL}/login`
  }

  const userMenu = [
    {
      key: 'return',
      icon: <ArrowLeftOutlined />,
      label: t('studio_return_runtime'),
      onClick: () => goToRuntime('/dashboard', token, refreshToken),
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: t('layout_logout'),
      onClick: handleLogout,
    },
  ]

  const menuItems = [
    {
      key: '/agents',
      icon: <RobotOutlined />,
      label: t('layout_agent_management_label'),
      onClick: () => navigate('/agents'),
    },
    {
      key: '/workflows',
      icon: <ApartmentOutlined />,
      label: t('layout_workflows_label'),
      onClick: () => navigate('/workflows'),
    },
    hasPermission('tools.read') && {
      key: '/tools',
      icon: <ToolOutlined />,
      label: t('layout_tools_label'),
      onClick: () => navigate('/tools'),
    },
    hasPermission('mcp.manage') && {
      key: '/mcp',
      icon: <ApiOutlined />,
      label: t('layout_mcp_servers_label'),
      onClick: () => navigate('/mcp'),
    },
    {
      key: '/knowledge',
      icon: <BookOutlined />,
      label: t('layout_knowledge_label'),
      onClick: () => navigate('/knowledge'),
    },
    hasPermission('memory.read') && {
      key: '/memory',
      icon: <DatabaseOutlined />,
      label: t('layout_memory_label'),
      onClick: () => navigate('/memory'),
    },
    hasPermission('skills.manage') && {
      key: '/skills',
      icon: <BulbOutlined />,
      label: t('layout_skills_label'),
      onClick: () => navigate('/skills'),
    },
    {
      key: '/plugins',
      icon: <AppstoreOutlined />,
      label: t('layout_plugins_label'),
      onClick: () => navigate('/plugins'),
    },
    hasPermission('connectors.manage') && {
      key: '/connectors',
      icon: <MessageOutlined />,
      label: t('layout_message_channels_label'),
      onClick: () => navigate('/connectors'),
    },
    {
      key: '/docs',
      icon: <FileTextOutlined />,
      label: t('layout_docs_label'),
      onClick: () => navigate('/docs'),
    },
    { type: 'divider' as const },
    // ── 系统管理（跳转到 Core Runtime，携带 JWT） ──────────────────────────
    isAdmin && {
      key: 'admin',
      icon: <SettingOutlined />,
      label: t('layout_section_admin'),
      children: [
        hasPermission('system.config.write') && {
          key: '/system/soul',
          icon: <FileTextOutlined />,
          label: t('layout_agent_identity_label'),
          onClick: () => navigate('/system/soul'),
        },
        hasPermission('system.config.write') && {
          key: 'rt:/system/config',
          icon: <SettingOutlined />,
          label: t('layout_system_settings_label'),
          onClick: () => goToRuntime('/system/config', token, refreshToken),
        },
        hasPermission('system.config.write') && {
          key: 'rt:/system/connectors',
          icon: <MessageOutlined />,
          label: t('layout_channel_config_label'),
          onClick: () => goToRuntime('/system/connectors', token, refreshToken),
        },
        hasPermission('system.config.write') && {
          key: 'rt:/system/api-keys',
          icon: <KeyOutlined />,
          label: t('layout_api_keys_label'),
          onClick: () => goToRuntime('/system/api-keys', token, refreshToken),
        },
        {
          key: 'rt:/org',
          icon: <ClusterOutlined />,
          label: t('layout_org_label'),
          onClick: () => goToRuntime('/org', token, refreshToken),
        },
        {
          key: 'iam',
          icon: <TeamOutlined />,
          label: t('layout_iam_label'),
          children: [
            hasPermission('users.read') && {
              key: 'rt:/users',
              icon: <UserOutlined />,
              label: t('layout_users_label'),
              onClick: () => goToRuntime('/users', token, refreshToken),
            },
            hasPermission('roles.read') && {
              key: 'rt:/roles',
              icon: <SafetyCertificateOutlined />,
              label: t('layout_roles_label'),
              onClick: () => goToRuntime('/roles', token, refreshToken),
            },
            {
              key: 'rt:/admin/sso',
              icon: <GlobalOutlined />,
              label: t('layout_sso_label'),
              onClick: () => goToRuntime('/admin/sso', token, refreshToken),
            },
          ].filter(Boolean),
        },
        {
          key: 'rt:/tenants',
          icon: <ApartmentOutlined />,
          label: t('layout_tenants_label'),
          onClick: () => goToRuntime('/tenants', token, refreshToken),
        },
        hasPermission('audit.logs.read') && {
          key: 'rt:/audit/logs',
          icon: <AuditOutlined />,
          label: t('layout_audit_logs_label'),
          onClick: () => goToRuntime('/audit/logs', token, refreshToken),
        },
      ].filter(Boolean),
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
            {t('studio_return_runtime')}
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
        trigger={null}
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

          {/* Right side: language + theme toggle + user avatar */}
          <Space>
            <LanguageSwitcher />
            <Tooltip title={isDark ? t('layout_tooltip_switch_day') : t('layout_tooltip_switch_night')}>
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
  )
}
