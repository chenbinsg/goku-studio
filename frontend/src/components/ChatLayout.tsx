import React, { useEffect, useState, useCallback, useRef } from 'react'
import CityClockWidget from './CityClockWidget'
import { Outlet, useNavigate } from 'react-router-dom'
import { Avatar, Dropdown, Badge, Space, Typography, Popover, List, Tag, Empty, notification, Button, Modal, Form, Input, message } from 'antd'
import { BellOutlined, UserOutlined, SettingOutlined, LogoutOutlined, DownOutlined, ExclamationCircleOutlined, LockOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { notificationApi, approvalApi, emailQueueApi, userApi, authApi } from '../api'
import CollapsibleSidebar from './CollapsibleSidebar'
import AiosLogo from './AiosLogo'
import LanguageSwitcher from './LanguageSwitcher'
import LLMHealthBadge from './LLMHealthBadge'

const { Text } = Typography

const ChatLayout: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()
  const { fetchConversations } = useChatStore()
  const [notifications, setNotifications] = useState<any[]>([])
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0)
  const [quickCounts, setQuickCounts] = useState({ pendingTasks: 0, pendingApprovals: 0, unreadNotifications: 0, newEmails: 0 })
  const prevApprovalCountRef = useRef(0)
  const [pwModalOpen, setPwModalOpen] = useState(false)
  const [pwSubmitting, setPwSubmitting] = useState(false)
  const [pwForm] = Form.useForm()

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await notificationApi.list({ unread_only: true, page: 1, size: 10 })
      const items = (res as any).items || []
      setNotifications(items)
      setQuickCounts((prev) => ({ ...prev, unreadNotifications: items.length }))
    } catch {
      // ignore
    }
  }, [])

  const fetchPendingApprovals = useCallback(async () => {
    try {
      const res = await approvalApi.list({ status: 'pending', page: 1, size: 20 })
      const items: any[] = (res as any).items || []
      const now = Date.now()
      const active = items.filter(a => (now - new Date(a.created_at).getTime()) < 24 * 60 * 60 * 1000)
      const count = active.length
      if (count > prevApprovalCountRef.current) {
        notification.warning({
          key: 'pending-approval',
          message: t('chat_layout_approval_notification_message'),
          description: t('chat_layout_approval_notification_description', { count }),
          icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
          btn: (
            <Button size="small" type="primary" onClick={() => { navigate('/approvals'); notification.destroy('pending-approval') }}>
              {t('chat_layout_approval_notification_button')}
            </Button>
          ),
          duration: 0,
        })
      } else if (count === 0) {
        notification.destroy('pending-approval')
      }
      prevApprovalCountRef.current = count
      setPendingApprovalCount(count)
      setQuickCounts((prev) => ({ ...prev, pendingApprovals: count }))
    } catch {
      // ignore
    }
  }, [navigate])

  useEffect(() => {
    fetchConversations()
    fetchNotifications()
    const timer = setInterval(fetchNotifications, 30000)
    return () => clearInterval(timer)
  }, [fetchConversations, fetchNotifications])

  useEffect(() => {
    fetchPendingApprovals()
    const timer = setInterval(fetchPendingApprovals, 15000)
    return () => clearInterval(timer)
  }, [fetchPendingApprovals])

  const fetchNewEmailCount = useCallback(async () => {
    try {
      const s = await emailQueueApi.stats()
      setQuickCounts(prev => ({ ...prev, newEmails: s.new || 0 }))
    } catch {
      // ignore — email queue may not be configured
    }
  }, [])

  useEffect(() => {
    fetchNewEmailCount()
    const timer = setInterval(fetchNewEmailCount, 30000)
    return () => clearInterval(timer)
  }, [fetchNewEmailCount])

  const handleLogout = async () => {
    try {
      const res = await authApi.logout()
      logout()
      if (res?.sso_logout_url) {
        window.location.href = res.sso_logout_url
        return
      }
    } catch {
      logout()
    }
    navigate('/login')
  }

  const handleChangePassword = async () => {
    if (pwSubmitting) return
    setPwSubmitting(true)
    try {
      const values = await pwForm.validateFields()
      await userApi.changeOwnPassword(values.current_password, values.new_password)
      message.success(t('chat_layout_pw_success') || '密码修改成功')
      setPwModalOpen(false)
      pwForm.resetFields()
    } catch (err: any) {
      if (err?.errorFields) return
      const detail = err?.response?.data?.detail
      message.error(detail || err?.message || (t('chat_layout_pw_error') || '修改密码失败'))
    } finally {
      setPwSubmitting(false)
    }
  }

  const userMenuItems = [
    { key: 'profile', icon: <UserOutlined />, label: t('chat_layout_user_profile'), onClick: () => navigate('/profile') },
    { key: 'change-password', icon: <LockOutlined />, label: t('chat_layout_change_password') || '修改密码', onClick: () => { pwForm.resetFields(); setPwModalOpen(true) } },
    { key: 'settings', icon: <SettingOutlined />, label: t('chat_layout_account_settings'), onClick: () => navigate('/settings') },
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: t('chat_layout_logout'), onClick: handleLogout },
  ]

  return (
    <>
    {/* ── Change Password Modal ──────────────────────────────────────────── */}
    <Modal
      title={<Space><LockOutlined />{t('chat_layout_change_password') || '修改密码'}</Space>}
      open={pwModalOpen}
      onOk={handleChangePassword}
      onCancel={() => { setPwModalOpen(false); pwForm.resetFields() }}
      confirmLoading={pwSubmitting}
      okText={t('chat_layout_pw_confirm') || '确认修改'}
      destroyOnClose
    >
      <Form form={pwForm} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          name="current_password"
          label={t('chat_layout_pw_current') || '当前密码'}
          rules={[{ required: true, message: t('chat_layout_pw_current_required') || '请输入当前密码' }]}
        >
          <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="new_password"
          label={t('chat_layout_pw_new') || '新密码'}
          rules={[
            { required: true, message: t('chat_layout_pw_new_required') || '请输入新密码' },
            { min: 8, message: t('chat_layout_pw_min') || '密码至少 8 位' },
          ]}
        >
          <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm_password"
          label={t('chat_layout_pw_confirm_label') || '确认新密码'}
          dependencies={['new_password']}
          rules={[
            { required: true, message: t('chat_layout_pw_confirm_required') || '请再次输入新密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                return Promise.reject(new Error(t('chat_layout_pw_mismatch') || '两次输入的密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>

    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Top bar */}
      <div style={{
        height: 72,
        background: '#fff',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px 0 8px',
        flexShrink: 0,
      }}>
        <div style={{ lineHeight: 0 }}>
          <AiosLogo collapsed={false} size={56} inline wide />
        </div>
        <CityClockWidget isDark={false} />
        <Space size={16}>
          <LLMHealthBadge />
          <LanguageSwitcher />
          <Popover
            title={t('chat_layout_notification_title')}
            trigger="click"
            placement="bottomRight"
            content={
              notifications.length === 0 ? (
                <Empty description={t('chat_layout_notification_empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                        setNotifications((prev) => prev.filter((n) => n.id !== item.id))
                      }}
                    >
                      <List.Item.Meta
                        title={<Space><Tag color="blue">{t('chat_layout_notification_tag')}</Tag><span style={{ fontSize: 12 }}>{item.title}</span></Space>}
                        description={<span style={{ fontSize: 12 }}>{(item.content || '').slice(0, 60)}</span>}
                      />
                    </List.Item>
                  )}
                />
              )
            }
          >
            <Badge count={notifications.length + pendingApprovalCount} size="small">
              <BellOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
            </Badge>
          </Popover>
          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size="small" icon={<UserOutlined />} src={user?.avatar} />
              <Text>{user?.username || 'Admin'}</Text>
              <DownOutlined style={{ fontSize: 10 }} />
            </Space>
          </Dropdown>
        </Space>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <CollapsibleSidebar quickCounts={quickCounts} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Outlet />
        </div>
      </div>
    </div>
    </>
  )
}

export default ChatLayout
