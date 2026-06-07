import React from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button, Tooltip, Space, theme as antTheme } from 'antd'
import {
  RobotOutlined,
  ApartmentOutlined,
  ToolOutlined,
  ApiOutlined,
  BookOutlined,
  DatabaseOutlined,
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
  const params = new URLSearchParams()
  if (token) params.set('_token', token)
  if (refreshToken) params.set('_refresh_token', refreshToken)
  const qs = params.toString()
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
  )
}
