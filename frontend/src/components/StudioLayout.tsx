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
    { type: 'divider' as const },
    // ── 系统管理（跳转到 Core Runtime，携带 JWT） ──────────────────────────
    isAdmin && {
      key: 'admin',
      icon: <SettingOutlined />,
      label: '系统管理',
      children: [
        hasPermission('system.config.write') && {
          key: 'rt:/system/config',
          icon: <SettingOutlined />,
          label: '系统设置',
          onClick: () => goToRuntime('/system/config', token, refreshToken),
        },
        hasPermission('system.config.write') && {
          key: 'rt:/system/connectors',
          icon: <MessageOutlined />,
          label: '渠道接入配置',
          onClick: () => goToRuntime('/system/connectors', token, refreshToken),
        },
        hasPermission('system.config.write') && {
          key: 'rt:/system/api-keys',
          icon: <KeyOutlined />,
          label: '开放 API Keys',
          onClick: () => goToRuntime('/system/api-keys', token, refreshToken),
        },
        {
          key: 'rt:/org',
          icon: <ClusterOutlined />,
          label: '组织架构',
          onClick: () => goToRuntime('/org', token, refreshToken),
        },
        {
          key: 'iam',
          icon: <TeamOutlined />,
          label: '用户与访问管理',
          children: [
            hasPermission('users.read') && {
              key: 'rt:/users',
              icon: <UserOutlined />,
              label: '用户管理',
              onClick: () => goToRuntime('/users', token, refreshToken),
            },
            hasPermission('roles.read') && {
              key: 'rt:/roles',
              icon: <SafetyCertificateOutlined />,
              label: '角色管理',
              onClick: () => goToRuntime('/roles', token, refreshToken),
            },
            {
              key: 'rt:/admin/sso',
              icon: <GlobalOutlined />,
              label: '企业 SSO',
              onClick: () => goToRuntime('/admin/sso', token, refreshToken),
            },
          ].filter(Boolean),
        },
        {
          key: 'rt:/tenants',
          icon: <ApartmentOutlined />,
          label: '租户管理',
          onClick: () => goToRuntime('/tenants', token, refreshToken),
        },
        hasPermission('audit.logs.read') && {
          key: 'rt:/audit/logs',
          icon: <AuditOutlined />,
          label: '审计日志',
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
  )
}
