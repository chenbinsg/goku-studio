import React, { useState } from 'react'
import { Typography, Button, Badge, Space, Tooltip, Menu } from 'antd'
import {
  MessageOutlined,
  UnorderedListOutlined,
  SettingOutlined,
  PlusOutlined,
  DeleteOutlined,
  RobotOutlined,
  SafetyOutlined,
  BellOutlined,
  ApartmentOutlined,
  CloudOutlined,
  ApiOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  FileTextOutlined,
  BarChartOutlined,
  DollarOutlined,
  MailOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '../stores/chat'
import { usePermissions } from '../hooks/usePermissions'
import dayjs from 'dayjs'

const { Text } = Typography

interface QuickCounts {
  pendingTasks: number
  pendingApprovals: number
  unreadNotifications: number
  newEmails?: number
}

interface Props {
  quickCounts: QuickCounts
}

type Section = 'conversations' | 'quick' | 'admin'

const CollapsibleSidebar: React.FC<Props> = ({ quickCounts }) => {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [activeSection, setActiveSection] = useState<Section>('conversations')
  const navigate = useNavigate()
  // RBAC: 复盘 #0006 — every menu structure MUST consult usePermissions.
  // Items here used to be hardcoded which leaked admin links to non-admins
  // (Users / Roles / Audit / SSO / SystemConfig) the moment they landed on
  // the chat page. Mirror Layout.tsx's filter gates exactly.
  const { hasPermission, isSuperuser: isAdmin } = usePermissions()

  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    startNewConversation,
    deleteConversation,
    fetchMessages,
  } = useChatStore()

  const handleSectionClick = (section: Section) => {
    if (expanded && activeSection === section) {
      setExpanded(false)
    } else {
      setActiveSection(section)
      setExpanded(true)
    }
  }

  const handleConversationClick = (id: string) => {
    setActiveConversationId(id)
    fetchMessages(id)
  }

  const totalBadge = quickCounts.pendingTasks + quickCounts.pendingApprovals + quickCounts.unreadNotifications

  // ── Permission-filtered submenus — mirror Layout.tsx exactly (see 复盘 #0006).
  //   - /agents and /knowledge stay visible to everyone (regular users need them)
  //   - Everything that touches infra/config is gated
  //   - Empty branches disappear instead of showing an empty drawer
  // NOTE: Keep this block in sync with Layout.tsx aiChildren — see 复盘 #0004 / #0006.
  const aiChildren = [
    { key: '/agents',                    label: t('layout_agent_management_label') },
    hasPermission('agents.write')      && { key: '/agents/runtime',             label: '⚡ 并发运行状态' },
    hasPermission('tools.read')        && { key: '/tools',                      label: t('layout_tools_label') },
    // models page removed — LLM catalog is managed by Goku Router, not AIOS
    hasPermission('memory.read')       && { key: '/memory',                     label: t('layout_memory_label') },
    { key: '/knowledge',                  label: t('layout_knowledge_label') },
    hasPermission('knowledge.write')   && { key: '/agent-knowledge',            label: t('layout_agent_knowledge_label') },
    hasPermission('system.config.write') && { key: '/knowledge/external-sources', label: t('layout_external_sources_label') },
    hasPermission('skills.manage')     && { key: '/skills',                     label: t('layout_skills_label') },
  ].filter(Boolean) as { key: string; label: string }[]

  // ── 用户与访问管理（IAM）子菜单 — mirror Layout.tsx iamChildren (复盘 #0006)
  const iamChildren = [
    hasPermission('users.read') && { key: '/users',        label: t('layout_users_label') },
    hasPermission('roles.read') && { key: '/roles',        label: t('layout_roles_label') },
    isAdmin                     && { key: '/admin/sso',    label: t('layout_enterprise_sso_label', '企业 SSO') },
    isAdmin                     && { key: '/admin/zhuyun', label: t('layout_user_sync_label', '用户同步') },
    isAdmin                     && { key: '/admin/unicall', label: t('layout_unicall_label', 'UniCall 网关') },
  ].filter(Boolean) as { key: string; label: string }[]

  // NOTE: Keep this block in sync with Layout.tsx adminChildren — see 复盘 #0004 / #0006.
  const adminChildren = [
    hasPermission('system.config.write') && { key: '/system/soul',       label: t('layout_agent_identity_label') },
    hasPermission('system.config.write') && { key: '/system/config',     label: t('layout_system_settings_label') },
    hasPermission('system.config.write') && { key: '/system/connectors', label: t('layout_channel_config_label', '渠道接入配置') },
    hasPermission('system.config.write') && { key: '/system/api-keys',   label: '开放 API Keys' },
    isAdmin                              && { key: '/system/proposals',   label: t('layout_proposals_label', '自我进化提案') },
    isAdmin                              && { key: '/org',                label: t('layout_org_label', '组织架构') },
    ...(iamChildren.length > 0 ? [{ key: 'iam', label: t('layout_iam_label', '用户与访问管理'), children: iamChildren }] : []),
    isAdmin                              && { key: '/tenants',           label: '租户管理' },
    isAdmin                              && { key: '/admin/stateful-policies', label: '状态动作策略' },
    isAdmin                              && { key: '/admin/stateful-audit',    label: '状态转移审计' },
    hasPermission('audit.logs.read')     && { key: '/audit/logs',        label: t('layout_audit_logs_label') },
  ].filter(Boolean) as any[]

  const adminMenuItems = [
    { key: '/tasks/kanban', icon: <RobotOutlined />, label: t('layout_tasks_label') },
    { key: '/workflows', icon: <ApartmentOutlined />, label: t('layout_workflows_label') },
    { key: '/schedules', icon: <ClockCircleOutlined />, label: t('layout_schedules_label') },
    {
      key: '/approvals',
      icon: <SafetyOutlined />,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {t('layout_approvals_label')}
          {quickCounts.pendingApprovals > 0 && (
            <Badge count={quickCounts.pendingApprovals} size="small" style={{ marginLeft: 8 }} />
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
          {(quickCounts.newEmails ?? 0) > 0 && (
            <Badge count={quickCounts.newEmails} size="small" style={{ marginLeft: 8 }} />
          )}
        </span>
      ),
    },
    { type: 'divider' as const },

    // ── AI 能力（基础设施按权限过滤）──
    {
      key: 'ai',
      icon: <CloudOutlined />,
      label: t('layout_section_ai_features'),
      children: aiChildren,
    },

    // ── 扩展（需 system.config / mcp / connectors 权限）──
    ...(hasPermission('mcp.manage')        ? [{ key: '/mcp',        icon: <ApiOutlined />,     label: t('layout_mcp_servers_label') }]       : []),
    ...(hasPermission('connectors.manage') ? [{ key: '/connectors', icon: <MessageOutlined />, label: t('layout_message_channels_label', '消息渠道') }] : []),
    { type: 'divider' as const },

    // ── 文档中心 ──
    { key: '/docs', icon: <FileTextOutlined />, label: t('layout_docs_label') },
    { type: 'divider' as const },

    // ── 数据分析（需费用查看权限）──
    ...(hasPermission('costs.read')
      ? [
          { key: '/analytics', icon: <BarChartOutlined />, label: '互动分析' },
          { key: '/billing',   icon: <DollarOutlined />,   label: '智能体账单' },
          { type: 'divider' as const },
        ]
      : []),

    // ── 系统管理（按各项权限过滤；全部 deny 则整个二级菜单隐藏）──
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

  // Hide the admin gear column entirely when nothing in the admin drawer applies
  // to this user. Without this, non-admins still see the gear icon and click it
  // to find an empty (or near-empty) panel — confusing UX.
  const showAdminColumn = adminMenuItems.some((item) => {
    if (!item || 'type' in item) return false
    return true
  })

  return (
    <div style={{
      width: expanded ? 240 : 48,
      transition: 'width 0.2s ease',
      background: '#001529',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Icon column */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 4 }}>
        {/* Dashboard shortcut */}
        <Tooltip title={t('sidebar_tooltip_dashboard', '控制台')} placement="right">
          <Button
            type="text"
            icon={<DashboardOutlined />}
            onClick={() => navigate('/dashboard')}
            style={{ color: 'rgba(255,255,255,0.65)', width: 40, height: 40 }}
          />
        </Tooltip>

        <Tooltip title={!expanded ? t('sidebar_tooltip_conversations') : ''} placement="right">
          <Button
            type="text"
            icon={<MessageOutlined />}
            onClick={() => handleSectionClick('conversations')}
            style={{
              color: activeSection === 'conversations' && expanded ? '#1890ff' : 'rgba(255,255,255,0.65)',
              width: 40,
              height: 40,
            }}
          />
        </Tooltip>

        <Tooltip title={!expanded ? t('sidebar_tooltip_quick_panel') : ''} placement="right">
          <Badge count={totalBadge} size="small" offset={[-4, 4]}>
            <Button
              type="text"
              icon={<UnorderedListOutlined />}
              onClick={() => handleSectionClick('quick')}
              style={{
                color: activeSection === 'quick' && expanded ? '#1890ff' : 'rgba(255,255,255,0.65)',
                width: 40,
                height: 40,
              }}
            />
          </Badge>
        </Tooltip>

        {showAdminColumn && (
          <Tooltip title={!expanded ? t('sidebar_tooltip_admin') : ''} placement="right">
            <Button
              type="text"
              icon={<SettingOutlined />}
              onClick={() => handleSectionClick('admin')}
              style={{
                color: activeSection === 'admin' && expanded ? '#1890ff' : 'rgba(255,255,255,0.65)',
                width: 40,
                height: 40,
              }}
            />
          </Tooltip>
        )}
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 8px' }}>
          {activeSection === 'conversations' && (
            <>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                block
                size="small"
                onClick={() => startNewConversation()}
                style={{ marginBottom: 8 }}
              >
                {t('sidebar_new_conversation')}
              </Button>
              <div>
                {conversations.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => handleConversationClick(conv.id)}
                    style={{
                      padding: '6px 8px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: conv.id === activeConversationId ? 'rgba(24,144,255,0.2)' : 'transparent',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 2,
                    }}
                  >
                    <div style={{ overflow: 'hidden' }}>
                      <Text ellipsis style={{ color: '#fff', fontSize: 12, display: 'block', maxWidth: 160 }}>
                        {conv.title}
                      </Text>
                      <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 10 }}>
                        {dayjs(conv.updated_at).format('MM-DD HH:mm')}
                      </Text>
                    </div>
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                      style={{ color: 'rgba(255,255,255,0.45)' }}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {activeSection === 'quick' && (
            <div>
              <div style={{ padding: '6px 8px', cursor: 'pointer' }} onClick={() => navigate('/tasks/kanban')}>
                <Space>
                  <RobotOutlined style={{ color: 'rgba(255,255,255,0.65)' }} />
                  <Text style={{ color: '#fff', fontSize: 12 }}>{t('sidebar_quick_tasks')}</Text>
                  <Badge count={quickCounts.pendingTasks} size="small" />
                </Space>
              </div>
              <div style={{ padding: '6px 8px', cursor: 'pointer' }} onClick={() => navigate('/approvals')}>
                <Space>
                  <SafetyOutlined style={{ color: 'rgba(255,255,255,0.65)' }} />
                  <Text style={{ color: '#fff', fontSize: 12 }}>{t('sidebar_quick_approvals')}</Text>
                  <Badge count={quickCounts.pendingApprovals} size="small" />
                </Space>
              </div>
              <div style={{ padding: '6px 8px', cursor: 'pointer' }}>
                <Space>
                  <BellOutlined style={{ color: 'rgba(255,255,255,0.65)' }} />
                  <Text style={{ color: '#fff', fontSize: 12 }}>{t('sidebar_quick_notifications')}</Text>
                  <Badge count={quickCounts.unreadNotifications} size="small" />
                </Space>
              </div>
            </div>
          )}

          {activeSection === 'admin' && (
            <Menu
              theme="dark"
              mode="inline"
              style={{ background: 'transparent', borderRight: 0 }}
              items={adminMenuItems}
              onClick={({ key }) => navigate(key)}
            />
          )}
        </div>
      )}
    </div>
  )
}

export default CollapsibleSidebar
