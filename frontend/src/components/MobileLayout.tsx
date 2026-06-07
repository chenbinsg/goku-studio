import React from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import {
  HomeOutlined,
  CheckSquareOutlined,
  SafetyOutlined,
  BellOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const NAV_ITEMS = [
  { path: '/mobile', icon: <HomeOutlined />, labelKey: 'mobile_nav_home', exact: true },
  { path: '/mobile/chat', icon: <RobotOutlined />, labelKey: 'mobile_nav_chat' },
  { path: '/mobile/tasks', icon: <CheckSquareOutlined />, labelKey: 'mobile_nav_tasks' },
  { path: '/mobile/approvals', icon: <SafetyOutlined />, labelKey: 'mobile_nav_approvals' },
  { path: '/mobile/notifications', icon: <BellOutlined />, labelKey: 'mobile_nav_notifications' },
]

const MobileLayout: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  const isActive = (item: typeof NAV_ITEMS[0]) => {
    if (item.exact) return location.pathname === item.path
    return location.pathname.startsWith(item.path)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f5f5f5' }}>
      {/* Header */}
      <div style={{
        background: '#1677ff',
        color: '#fff',
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 2px 8px rgba(0,0,0,.15)',
      }}>
        <span style={{ fontWeight: 700, fontSize: 16 }}>Goku AIOS</span>
        <span style={{ fontSize: 12, opacity: 0.85 }}>{t('mobile_workspace', 'Mobile Workspace')}</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, paddingBottom: 60, overflowY: 'auto' }}>
        <Outlet />
      </div>

      {/* Bottom Navigation */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: '#fff',
        borderTop: '1px solid #f0f0f0',
        display: 'flex',
        zIndex: 100,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {NAV_ITEMS.map(item => {
          const active = isActive(item)
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                padding: '8px 4px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                cursor: 'pointer',
                color: active ? '#1677ff' : '#8c8c8c',
                fontSize: 10,
                fontWeight: active ? 600 : 400,
              }}
            >
              <span style={{ fontSize: 20 }}>{item.icon}</span>
              <span>{t(item.labelKey, item.labelKey.replace('mobile_nav_', ''))}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default MobileLayout
