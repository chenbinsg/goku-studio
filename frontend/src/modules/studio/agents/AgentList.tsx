import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Divider,
  Dropdown,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  ApartmentOutlined,
  DownOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  LockOutlined,
  MailOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  RightOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { agentApi, agentInstanceApi, agentPoliciesApi, departmentApi, orgTeamsApi, api, AgentTypeStatus, type AgentEmailConfig } from '@/api'
import AgentInstancePanel from '@/components/AgentInstancePanel'
import PromptTokenMeter, { AGENT_PROMPT_BUDGET } from '@/components/PromptTokenMeter'
import { useAuthStore } from '@/stores/auth'
import { useTranslation } from 'react-i18next'
import { getAgentName, type LangCode } from '@/i18n'

const { TextArea } = Input
const { Text, Title } = Typography

interface AgentDefinition {
  id: string
  name: string
  name_i18n?: Record<string, string> | null
  slug?: string | null
  description: string | null
  agent_type: string
  agent_type_label: string
  department: string | null
  division?: string | null
  category?: string | null
  figure_url: string | null
  system_prompt_override: string | null
  skills: string[] | null
  allowed_tools: string[] | null
  effective_tools: string[]
  model_override: string | null
  max_steps: number | null
  effective_max_steps: number
  icon: string | null
  color: string | null
  is_active: boolean
  visibility: string
  allowed_roles: string[]
  is_favorite?: boolean
  created_at: string
  updated_at: string
  display_name?: string | null
  allowed_channels?: string[]
  channel_configs?: Record<string, { webhook_url?: string }> | null
  notification_channels?: { type: string; target: string }[]
  escalation_contact?: { type: string; target: string } | null
  dlp_bypass: boolean
}

interface BaseType {
  key: string
  label: string
  icon: string | null
  color: string | null
  max_steps: number
  tools: string[]
}

interface SkillOption {
  id: string
  name: string
  description: string
  path: string
}

const TYPE_EMOJI: Record<string, string> = {
  explorer: '🔍',
  coder: '💻',
  reviewer: '🔎',
  data_agent: '📊',
  process_agent: '⚙️',
  writing_agent: '✍️',
  language_agent: '🌐',
  video_agent: '🎬',
  image_agent: '🎨',
  comm_agent: '💬',
  security_agent: '🛡️',
  ops_monitor_agent: '🖥️',
  security_test_agent: '🛡️',
  security_policy_agent: '🔐',
  vuln_agent: '🚨',
  pm_agent: '📋',
  capacity_agent: '📈',
  arch_agent: '🏗️',
  requirements_agent: '📝',
  test_agent: '🧪',
  event_agent: '🎯',
  // seed-file types
  designer: '🎨',
  presales: '💼',
  technical_support: '🔧',
  report_agent: '📊',
  ops: '🖥️',
  market_intelligence: '📈',
  customer_service: '💬',
}

function agentEmoji(type: string) {
  return TYPE_EMOJI[type] || '🤖'
}

function normalizeDepartment(value?: string | null, notGrouped = '未分组') {
  const text = (value || '').trim()
  return text || notGrouped
}

function getDownloadFilename(disposition: string, fallback: string) {
  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1])
    } catch {
      return encodedMatch[1]
    }
  }
  const match = disposition.match(/filename="?([^";]+)"?/i)
  return match?.[1] || fallback
}

const KNOWN_DIVISION_ORDER = ['产品技术本部', 'IR管理', '市场与销售']
const DIVISION_STATE_KEY = 'agent-list-collapsed-divisions'
const DEPARTMENT_STATE_KEY = 'agent-list-collapsed-departments'

function resolveDivision(agent: AgentDefinition) {
  if (agent.division && agent.division.trim()) return agent.division.trim()
  const department = normalizeDepartment(agent.department)
  const name = agent.name.trim()
  if (['CTO Office', '技术开发', '技术研发', '技术支持', '技术运维'].includes(department)) {
    return '产品技术本部'
  }
  if (department === 'IR' || name === 'IR股民心声分析专家') return 'IR管理'
  if (department === 'Marketing & Sales' || name === '市场动态分析专家') return '市场与销售'
  return '其他'
}

const AgentList: React.FC = () => {
  const { t, i18n } = useTranslation()
  const lang = i18n.language as LangCode
  const { user: _authUser } = useAuthStore()
  const isSuperuser = (_authUser as any)?.is_superuser
  const aname = (agent: AgentDefinition) => getAgentName(agent, lang)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [baseTypes, setBaseTypes] = useState<BaseType[]>([])
  const [allTools, setAllTools] = useState<{ name: string; description?: string }[]>([])
  const [mcpTools, setMcpTools] = useState<{ name: string; description?: string }[]>([])
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>([])
  const [availableRoles, setAvailableRoles] = useState<any[]>([])
  const [canonicalDepts, setCanonicalDepts] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingFigure, setUploadingFigure] = useState(false)
  const [importingAgent, setImportingAgent] = useState(false)
  const [modalVisible, setModalVisible] = useState(false)
  const [detailVisible, setDetailVisible] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [emailConfig, setEmailConfig] = useState<AgentEmailConfig>({
    enabled: false,
    monitored_addresses: [],
    reply_from: '',
    poll_interval_minutes: 5,
    subject_blocklist: [],
    sender_blocklist: [],
  })
  const [pendingEmailCounts, setPendingEmailCounts] = useState<Record<string, number>>({})
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(null)
  const [selectedBaseType, setSelectedBaseType] = useState<BaseType | null>(null)
  const [instancePanelAgent, setInstancePanelAgent] = useState<AgentDefinition | null>(null)
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([])
  // Access policies tab state
  const [policies, setPolicies] = useState<any[]>([])
  const [policiesLoading, setPoliciesLoading] = useState(false)
  const [policyGrantOpen, setPolicyGrantOpen] = useState(false)
  const [policyDepts, setPolicyDepts] = useState<any[]>([])
  const [policyTeams, setPolicyTeams] = useState<any[]>([])
  const [policyUsers, setPolicyUsers] = useState<any[]>([])
  const [policyForm] = Form.useForm()
  const [collapsedDivisions, setCollapsedDivisions] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(DIVISION_STATE_KEY) || '{}')
    } catch {
      return {}
    }
  })
  const [collapsedDepartments, setCollapsedDepartments] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(window.localStorage.getItem(DEPARTMENT_STATE_KEY) || '{}')
    } catch {
      return {}
    }
  })
  const [form] = Form.useForm()
  const figureInputRef = useRef<HTMLInputElement | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const fetchAgents = async () => {
    setLoading(true)
    try {
      const data = await agentApi.list({ size: 200 })
      setAgents(data.items || [])
      setSelectedAgentIds((prev) => prev.filter((id) => (data.items || []).some((agent: AgentDefinition) => agent.id === id)))
    } catch {
      message.error(t('agent_list_fetch_failure'))
    } finally {
      setLoading(false)
    }
    // Fetch pending email counts for badges (non-blocking)
    agentApi.emailPendingCounts()
      .then(res => setPendingEmailCounts(res.counts || {}))
      .catch(() => {/* non-critical */})
  }

  const fetchBaseTypes = async () => {
    try {
      const data = await agentApi.baseTypes()
      setBaseTypes(data.agent_types || [])
    } catch {
      // ignore
    }
  }

  // Full tool registry (built-in + DB + MCP capabilities named "<server>__<cap>").
  // Used to populate the allowed_tools selector beyond the base type's preset list.
  const fetchAllTools = async () => {
    try {
      const data = await api.get<{ tools: { name: string; description?: string }[] }>('/tools')
      setAllTools(data.tools || [])
    } catch {
      // ignore — selector falls back to base-type tools only
    }
    // MCP capabilities are sourced LIVE (not from /tools, which no longer carries
    // them) so freshly-synced capabilities appear in the dropdown immediately.
    try {
      const mcp = await api.get<{ tools: { name: string; description?: string }[] }>('/agents/mcp-tool-options')
      setMcpTools(mcp.tools || [])
    } catch {
      // ignore — MCP group will be empty
    }
  }

  const fetchRoles = async () => {
    try {
      const data = await api.get<{ items: any[] }>('/roles')
      setAvailableRoles(data.items || [])
    } catch {
      // ignore
    }
  }

  const fetchCanonicalDepts = async () => {
    try {
      const data = await api.get<{ items: any[] }>('/departments')
      setCanonicalDepts((data.items || []).map((d: any) => d.name))
    } catch {
      // ignore — fall back to agents-derived list
    }
  }

  const fetchSkills = async () => {
    try {
      const data = await agentApi.skills()
      setSkillOptions(data.skills || [])
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchAgents()
    fetchBaseTypes()
    fetchAllTools()
    fetchSkills()
    fetchRoles()
    fetchCanonicalDepts()
    // Refresh pending email counts every 30 seconds
    const countTimer = setInterval(() => {
      agentApi.emailPendingCounts()
        .then(res => setPendingEmailCounts(res.counts || {}))
        .catch(() => {/* non-critical */})
    }, 30_000)
    return () => clearInterval(countTimer)
  }, [])

  const notGroupedLabel = t('agent_list_not_grouped')
  const departmentOptions = useMemo(() => {
    const fromAgents = agents.map(agent => normalizeDepartment(agent.department, notGroupedLabel))
    return Array.from(new Set([...canonicalDepts, ...fromAgents]))
      .filter(Boolean)
      .sort((a, b) => {
        if (a === notGroupedLabel) return 1
        if (b === notGroupedLabel) return -1
        return a.localeCompare(b, 'zh-Hans-CN')
      })
  }, [agents, notGroupedLabel, canonicalDepts])

  const groupedAgents = useMemo(() => {
    const divisionBuckets = new Map<string, Map<string, AgentDefinition[]>>()
    for (const agent of agents) {
      const division = resolveDivision(agent)
      const department = normalizeDepartment(agent.department, notGroupedLabel)
      const departmentBuckets = divisionBuckets.get(division) || new Map<string, AgentDefinition[]>()
      const current = departmentBuckets.get(department) || []
      current.push(agent)
      departmentBuckets.set(department, current)
      divisionBuckets.set(division, departmentBuckets)
    }

    // Build a dynamic order: known divisions first, then unknown ones alphabetically, '其他' last
    const allDivisions = Array.from(divisionBuckets.keys())
    const unknownDivisions = allDivisions
      .filter(d => !KNOWN_DIVISION_ORDER.includes(d) && d !== '其他')
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    const DIVISION_ORDER = [...KNOWN_DIVISION_ORDER, ...unknownDivisions, '其他']

    return Array.from(divisionBuckets.entries())
      .sort(([left], [right]) => {
        const leftIndex = DIVISION_ORDER.indexOf(left)
        const rightIndex = DIVISION_ORDER.indexOf(right)
        return (leftIndex === -1 ? DIVISION_ORDER.length : leftIndex) - (rightIndex === -1 ? DIVISION_ORDER.length : rightIndex)
      })
      .map(([division, departments]) => ({
        division,
        departments: Array.from(departments.entries())
          .sort(([left], [right]) => {
            if (left === notGroupedLabel) return 1
            if (right === notGroupedLabel) return -1
            return left.localeCompare(right, 'zh-Hans-CN')
          })
          .map(([department, items]) => ({
            department,
            items: items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
          })),
      }))
  }, [agents])

  useEffect(() => {
    setCollapsedDivisions(prev => {
      const next = { ...prev }
      for (const group of groupedAgents) {
        if (!(group.division in next)) {
          next[group.division] = false
        }
      }
      return next
    })
    setCollapsedDepartments(prev => {
      const next = { ...prev }
      for (const group of groupedAgents) {
        for (const departmentGroup of group.departments) {
          const key = `${group.division}::${departmentGroup.department}`
          if (!(key in next)) {
            next[key] = departmentGroup.items.length <= 2
          }
        }
      }
      return next
    })
  }, [groupedAgents])

  useEffect(() => {
    window.localStorage.setItem(DIVISION_STATE_KEY, JSON.stringify(collapsedDivisions))
  }, [collapsedDivisions])

  useEffect(() => {
    window.localStorage.setItem(DEPARTMENT_STATE_KEY, JSON.stringify(collapsedDepartments))
  }, [collapsedDepartments])

  const toggleDivision = (division: string) => {
    setCollapsedDivisions(prev => ({ ...prev, [division]: !prev[division] }))
  }

  const toggleDepartment = (division: string, department: string) => {
    const key = `${division}::${department}`
    setCollapsedDepartments(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleCreate = () => {
    setEditingId(null)
    setSelectedBaseType(null)
    form.resetFields()
    form.setFieldsValue({ department: notGroupedLabel })
    setModalVisible(true)
  }

  const handleEdit = (agent: AgentDefinition) => {
    setEditingId(agent.id)
    fetchAllTools()  // refresh tool/MCP list each open so newly-registered tools show up
    const base = baseTypes.find(t => t.key === agent.agent_type) || null
    setSelectedBaseType(base)
    form.setFieldsValue({
      name: agent.name,
      description: agent.description,
      agent_type: agent.agent_type,
      department: normalizeDepartment(agent.department, notGroupedLabel),
      division: agent.division || '',
      category: agent.category || undefined,
      figure_url: agent.figure_url,
      system_prompt_override: agent.system_prompt_override,
      skills: agent.skills || [],
      allowed_tools: agent.allowed_tools,
      model_override: agent.model_override,
      max_steps: agent.max_steps,
      color: agent.color,
      display_name: agent.display_name || '',
      is_active: agent.is_active,
      allowed_channels: agent.allowed_channels || [],
      channel_configs: agent.channel_configs || {},
      notification_channels: (agent.notification_channels || []).map((ch: any) => ({ type: ch.type, target: ch.target })),
      escalation_contact_type: agent.escalation_contact?.type || 'email',
      escalation_contact_target: agent.escalation_contact?.target || '',
      visibility: agent.visibility || 'department',
      allowed_roles: agent.allowed_roles || [],
      dlp_bypass: agent.dlp_bypass || false,
    })
    // Reset email config to defaults immediately so the tab never shows stale data
    // from a previously edited agent while the async fetch is in-flight (or if it fails).
    setEmailConfig({
      enabled: false,
      monitored_addresses: [],
      reply_from: '',
      poll_interval_minutes: 5,
      subject_blocklist: [],
      sender_blocklist: [],
    })
    agentApi.getEmailConfig(agent.id)
      .then(res => setEmailConfig(res.config))
      .catch(() => {/* not critical — defaults remain */})
    // Load access policies
    fetchPolicies(agent.id)
    setModalVisible(true)
  }

  const fetchPolicies = async (agentId: string) => {
    setPoliciesLoading(true)
    try {
      const res = await agentPoliciesApi.list(agentId)
      setPolicies(res.items || [])
    } catch {
      // non-critical — user may not be admin
    } finally {
      setPoliciesLoading(false)
    }
  }

  const openPolicyGrant = async () => {
    try {
      const [deptRes, teamRes, userRes] = await Promise.all([
        departmentApi.list(),
        orgTeamsApi.list({ active_only: true }),
        // Use agentApi itself, not userApi — avoid circular import concern
        api.get<{ items: any[] }>('/users', { params: { page: 1, size: 200 } }),
      ])
      setPolicyDepts(deptRes.items || [])
      setPolicyTeams(teamRes.items || [])
      setPolicyUsers((userRes as any).items || [])
    } catch {/* ignore */}
    policyForm.resetFields()
    setPolicyGrantOpen(true)
  }

  const handleGrantPolicy = async (values: any) => {
    if (!editingId) return
    try {
      await agentPoliciesApi.grant(editingId, {
        principal_type: values.principal_type,
        principal_id: values.principal_id,
        can_view: values.can_view ?? true,
        can_use: values.can_use ?? true,
        can_config: values.can_config ?? false,
      })
      message.success('授权成功')
      setPolicyGrantOpen(false)
      fetchPolicies(editingId)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '授权失败')
    }
  }

  const handleRevokePolicy = async (policyId: string) => {
    if (!editingId) return
    try {
      await agentPoliciesApi.revoke(editingId, policyId)
      message.success('已撤销授权')
      fetchPolicies(editingId)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '撤销失败')
    }
  }

  const handleView = (agent: AgentDefinition) => {
    setSelectedAgent(agent)
    setDetailVisible(true)
  }

  const handleDelete = async (id: string) => {
    try {
      await agentApi.delete(id)
      message.success(t('agent_list_delete_success'))
      fetchAgents()
    } catch {
      message.error(t('agent_list_fetch_failure'))
    }
  }

  const handleExport = async (agent: AgentDefinition) => {
    const token = useAuthStore.getState().token || ''
    try {
      const response = await fetch(`/api/v1/agents/${agent.id}/export`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload?.detail || 'export failed')
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') || ''
      const filename = getDownloadFilename(disposition, `${agent.name}.agent.json`)
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      message.success(t('agent_list_export_success'))
    } catch (error: any) {
      message.error(error?.message || t('agent_list_export_failure'))
    }
  }

  const toggleAgentSelection = (agentId: string, checked: boolean) => {
    setSelectedAgentIds((prev) => {
      if (checked) return prev.includes(agentId) ? prev : [...prev, agentId]
      return prev.filter((id) => id !== agentId)
    })
  }

  const handleBatchExport = async () => {
    const token = useAuthStore.getState().token || ''
    if (!selectedAgentIds.length) {
      message.warning(t('agent_list_export_select_first'))
      return
    }
    try {
      const response = await fetch('/api/v1/agents/export', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agent_ids: selectedAgentIds }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload?.detail || 'batch export failed')
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') || ''
      const filename = getDownloadFilename(disposition, 'agents-export.zip')
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
      message.success(t('agent_list_bulk_export_success', { count: selectedAgentIds.length }))
    } catch (error: any) {
      message.error(error?.message || t('agent_list_bulk_export_failure'))
    }
  }

  const handleImportAgent = async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.json')) {
      message.error(t('agent_list_import_format_error'))
      return
    }
    const token = useAuthStore.getState().token || ''
    const formData = new FormData()
    formData.append('file', file)
    setImportingAgent(true)
    try {
      const response = await fetch('/api/v1/agents/import', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.detail || 'import failed')
      }
      message.success(`${t('agent_list_import_success')}：${payload.name || file.name}`)
      fetchAgents()
    } catch (error: any) {
      message.error(error?.message || t('agent_list_import_failure'))
    } finally {
      setImportingAgent(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const handleToggleActive = async (agent: AgentDefinition, active: boolean) => {
    try {
      await agentApi.update(agent.id, { is_active: active })
      // Optimistic local update — no full re-fetch needed
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, is_active: active } : a))
      message.success(active ? t('agent_tile_enabled_success') : t('agent_tile_disabled_success'))
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('agent_list_fetch_failure'))
    }
  }

  const handleToggleFavorite = async (agent: AgentDefinition) => {
    try {
      const res = await agentApi.toggleFavorite(agent.id)
      // Optimistic update
      setAgents(prev => prev.map(a => a.id === agent.id ? { ...a, is_favorite: res.favorited } : a))
      message.success(res.favorited ? t('agent_pinned_success') : t('agent_unpinned_success'))
    } catch {
      message.error(t('agent_list_fetch_failure'))
    }
  }

  const handleSubmit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const values = await form.validateFields()
      if (values.department === notGroupedLabel) values.department = ''
      values.division = values.division || null
      values.display_name = values.display_name || null
      values.allowed_channels = values.allowed_channels || []
      values.channel_configs = values.channel_configs || {}
      values.notification_channels = (values.notification_channels || []).filter((ch: any) => ch?.type && ch?.target)
      values.escalation_contact = values.escalation_contact_target
        ? { type: values.escalation_contact_type || 'email', target: values.escalation_contact_target }
        : null
      if (editingId) {
        await agentApi.update(editingId, values)
        // Fire email config save without blocking the modal close — it's non-critical
        // and was previously causing the save to hang for 30 s when the backend was slow.
        agentApi.updateEmailConfig(editingId, emailConfig).catch(() => {})
        message.success(t('agent_list_update_success'))
      } else {
        await agentApi.create(values)
        message.success(t('agent_list_create_success'))
      }
      setModalVisible(false)
      fetchAgents()
    } catch (err: any) {
      // form.validateFields() throws {errorFields, values} — not an HTTP error
      if (err?.errorFields) return  // Ant Design highlights fields automatically
      const detail = err?.response?.data?.detail
      if (Array.isArray(detail)) {
        message.error(detail.map((d: any) => d?.msg || String(d)).join('; '))
      } else if (detail) {
        message.error(detail)
      } else if (err?.message) {
        message.error(err.message)
      } else {
        message.error(t('agent_list_update_failure') || 'Save failed')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleBaseTypeChange = (key: string) => {
    const base = baseTypes.find(t => t.key === key) || null
    setSelectedBaseType(base)
    form.setFieldsValue({ allowed_tools: undefined, max_steps: undefined })
  }

  const handleFigureUpload = async (file?: File) => {
    if (!file) return
    const ext = '.' + (file.name.split('.').pop()?.toLowerCase() || '')
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext)) {
      message.error(t('agent_edit_figure_format_error'))
      return
    }

    const token = useAuthStore.getState().token || ''
    const formData = new FormData()
    formData.append('file', file)
    setUploadingFigure(true)
    try {
      const response = await fetch('/api/v1/uploads', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })
      let payload: any = {}
      try { payload = await response.json() } catch { /* non-JSON (e.g. rate-limit HTML) */ }
      if (!response.ok) {
        // payload.detail from FastAPI, payload.error from slowapi rate limiter
        const detail = payload?.detail || payload?.error || `HTTP ${response.status}`
        throw new Error(`上传失败 / Upload failed: ${detail}`)
      }
      form.setFieldValue('figure_url', `/api/v1/uploads/${payload.file_id}/public`)
      message.success(t('agent_edit_figure_upload_success'))
    } catch (error: any) {
      message.error(error?.message || t('agent_list_fetch_failure'))
    } finally {
      setUploadingFigure(false)
      if (figureInputRef.current) figureInputRef.current.value = ''
    }
  }

  return (
    <div style={{ padding: 24, minHeight: '100vh', background: '#f6f8fb' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            🤖 {t('agent_list_title')}
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            {agents.length} Agents
            {agents.some(a => !a.is_active) && (
              <Tag color="default" style={{ marginLeft: 8 }}>
                {agents.filter(a => !a.is_active).length} inactive
              </Tag>
            )}
          </Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchAgents} loading={loading} />
          <Button
            icon={<DownloadOutlined />}
            onClick={handleBatchExport}
            disabled={!selectedAgentIds.length}
          >
            {t('agent_list_bulk_export_button')}{selectedAgentIds.length ? ` (${selectedAgentIds.length})` : ''}
          </Button>
          <Button
            icon={<UploadOutlined />}
            loading={importingAgent}
            onClick={() => importInputRef.current?.click()}
          >
            {t('agent_list_import_button')}
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreate}
            style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}
          >
            {t('agent_list_create_button')}
          </Button>
        </Space>
        <input
          ref={importInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => handleImportAgent(e.target.files?.[0] || undefined)}
        />
      </div>

      <Spin spinning={loading}>
        {agents.length === 0 && !loading ? (
          <Empty
            image={<div style={{ fontSize: 64 }}>🤖</div>}
            style={{ padding: '60px 0' }}
          />
        ) : (
          <div style={{ display: 'grid', gap: 14 }}>
            {groupedAgents.map(group => (
              <section
                key={group.division}
                style={{
                  background: '#fff',
                  borderRadius: 14,
                  border: '1px solid #edf1f6',
                  padding: 14,
                  boxShadow: '0 2px 10px rgba(15, 23, 42, 0.035)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
                  <Button
                    type="text"
                    onClick={() => toggleDivision(group.division)}
                    style={{ padding: 0, height: 'auto' }}
                  >
                    <Space size={8}>
                      <Avatar
                        size={32}
                        style={{ background: '#eef4ff', color: '#4f46e5' }}
                        icon={<ApartmentOutlined />}
                      />
                      <div style={{ textAlign: 'left' }}>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#1f2937', lineHeight: 1.2 }}>
                          {collapsedDivisions[group.division] ? <RightOutlined style={{ fontSize: 11, marginRight: 6 }} /> : <DownOutlined style={{ fontSize: 11, marginRight: 6 }} />}
                          {group.division}
                        </div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {group.departments.reduce((sum, dept) => sum + dept.items.length, 0)}
                        </Text>
                      </div>
                    </Space>
                  </Button>
                </div>

                {!collapsedDivisions[group.division] && <div style={{ display: 'grid', gap: 12 }}>
                  {group.departments.map(departmentGroup => (
                    <div key={`${group.division}-${departmentGroup.department}`}>
                      <Button
                        type="text"
                        onClick={() => toggleDepartment(group.division, departmentGroup.department)}
                        style={{ padding: '0 2px', height: 'auto', marginBottom: 8 }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <Text strong style={{ fontSize: 12, color: '#334155' }}>
                            {collapsedDepartments[`${group.division}::${departmentGroup.department}`] ? <RightOutlined style={{ fontSize: 10, marginRight: 6 }} /> : <DownOutlined style={{ fontSize: 10, marginRight: 6 }} />}
                            {departmentGroup.department}
                          </Text>
                          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                            {departmentGroup.items.length}
                          </Text>
                        </div>
                      </Button>
                      {!collapsedDepartments[`${group.division}::${departmentGroup.department}`] && (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(108px, 1fr))',
                            gap: 10,
                          }}
                        >
                          {departmentGroup.items.map(agent => (
                            <AgentTile
                              key={agent.id}
                              agent={agent}
                              onView={handleView}
                              onEdit={handleEdit}
                              onDelete={handleDelete}
                              onExport={handleExport}
                              onToggleActive={handleToggleActive}
                              onToggleFavorite={handleToggleFavorite}
                              selected={selectedAgentIds.includes(agent.id)}
                              onSelectChange={toggleAgentSelection}
                              onCapacityClick={setInstancePanelAgent}
                              pendingEmailCount={pendingEmailCounts[agent.slug || ''] || 0}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>}
              </section>
            ))}
          </div>
        )}
      </Spin>

      <Modal
        title={
          <Space>
            <span style={{ fontSize: 20 }}>{editingId ? '✏️' : '✨'}</span>
            {editingId ? t('agent_list_edit_tooltip') : t('agent_list_create_button')}
          </Space>
        }
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        width={860}
        confirmLoading={submitting}
        okButtonProps={{ disabled: submitting, style: { background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' } }}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Tabs
            defaultActiveKey="profile"
            size="small"
            items={[
              {
                key: 'profile',
                label: t('agent_edit_tab_basic'),
                children: (
                  <div style={{ paddingTop: 8 }}>
                    <Form.Item label={t('agent_edit_form_name')} name="name" rules={[{ required: true }]}>
                      <Input prefix={<RobotOutlined />} />
                    </Form.Item>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Form.Item label={t('agent_edit_form_base_type')} name="agent_type" rules={[{ required: true }]}>
                        <Select
                          onChange={handleBaseTypeChange}
                          disabled={!!editingId}
                          options={baseTypes.map(bt => ({
                            value: bt.key,
                            label: (
                              <Space>
                                <span>{agentEmoji(bt.key)}</span>
                                <span style={{ color: bt.color || '#1890ff', fontWeight: 500 }}>{bt.label}</span>
                                <Text type="secondary" style={{ fontSize: 12 }}>{bt.max_steps}</Text>
                              </Space>
                            ),
                          }))}
                        />
                      </Form.Item>

                      <Form.Item label={t('agent_edit_form_department')} name="department">
                        <AutoComplete
                          options={departmentOptions.map(item => ({ value: item }))}
                          filterOption={(inputValue, option) =>
                            (option?.value || '').toUpperCase().includes(inputValue.toUpperCase())
                          }
                        >
                          <Input prefix={<ApartmentOutlined />} />
                        </AutoComplete>
                      </Form.Item>
                    </div>

                    <Form.Item label={t('agent_edit_form_division')} name="division">
                      <AutoComplete
                        placeholder="如：产品技术本部"
                        options={[...new Set(agents.map(a => a.division).filter(Boolean))].map(d => ({ value: d as string }))}
                        allowClear
                      />
                    </Form.Item>

                    {/* ── Gallery category (智能体广场领域分类) ── */}
                    <Form.Item
                      label={t('agent_edit_form_category', '广场分类')}
                      name="category"
                      tooltip={t('agent_edit_form_category_tooltip', '决定该智能体在「智能体广场」中归入哪个领域分组')}
                    >
                      <Select allowClear placeholder={t('agent_edit_form_category_placeholder', '选择领域分类')} options={[
                        { value: 'ir',          label: t('gallery_cat_ir', '投资者关系') },
                        { value: 'design',      label: t('gallery_cat_design', '设计美工') },
                        { value: 'agent_tools', label: t('gallery_cat_agent_tools', 'Agent 平台工具') },
                        { value: 'support',     label: t('gallery_cat_support', '技术支持 / 售前') },
                        { value: 'marketing',   label: t('gallery_cat_marketing', '营销增长') },
                        { value: 'general',     label: t('gallery_cat_general', '通用探索') },
                      ]} />
                    </Form.Item>

                    {/* ── Visibility ── */}
                    <Form.Item
                      label={t('agent_visibility_label')}
                      name="visibility"
                      initialValue="department"
                      tooltip={t('agent_visibility_tooltip')}
                    >
                      <Select options={[
                        { value: 'public',     label: `🌐 ${t('agent_visibility_public')}` },
                        { value: 'department', label: `🏢 ${t('agent_visibility_department')}` },
                        { value: 'role_based', label: `🔑 ${t('agent_visibility_role_based')}` },
                        { value: 'private',    label: `🔒 ${t('agent_visibility_private')}` },
                      ]} />
                    </Form.Item>

                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, cur) => prev.visibility !== cur.visibility}
                    >
                      {({ getFieldValue }) =>
                        getFieldValue('visibility') === 'role_based' ? (
                          <Form.Item
                            label={t('agent_allowed_roles_label')}
                            name="allowed_roles"
                            tooltip={t('agent_allowed_roles_tooltip')}
                          >
                            <Select
                              mode="multiple"
                              placeholder={t('agent_allowed_roles_placeholder')}
                              options={availableRoles.map((r: any) => ({ value: r.id, label: r.name }))}
                              allowClear
                            />
                          </Form.Item>
                        ) : null
                      }
                    </Form.Item>

                    <Form.Item label={t('agent_edit_form_description')} name="description">
                      <Input />
                    </Form.Item>

                    <Form.Item
                      label={t('agent_edit_form_status')}
                      name="is_active"
                      valuePropName="checked"
                      initialValue={true}
                    >
                      <Switch
                        checkedChildren="✅ 启用 / Enabled"
                        unCheckedChildren="⛔ 停用 / Disabled"
                        style={{ minWidth: 140 }}
                      />
                    </Form.Item>

                    <Form.Item
                      label={t('agent_edit_form_dlp_bypass')}
                      name="dlp_bypass"
                      valuePropName="checked"
                      initialValue={false}
                      tooltip={t('agent_edit_dlp_bypass_tooltip')}
                    >
                      <Switch
                        checkedChildren="🔓 跳过 / Bypass"
                        unCheckedChildren="🔒 启用 / On"
                        style={{ minWidth: 130 }}
                      />
                    </Form.Item>

                    <Form.Item label={t('agent_edit_form_figure')}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <Form.Item noStyle name="figure_url">
                          <Input style={{ display: 'none' }} />
                        </Form.Item>
                        <Form.Item shouldUpdate noStyle>
                          {({ getFieldValue }) => {
                            const figureUrl = getFieldValue('figure_url') as string | undefined
                            return (
                              <>
                                <Avatar
                                  key={figureUrl || '__empty__'}
                                  size={72}
                                  src={figureUrl || undefined}
                                  style={{ background: '#f1f5f9', color: '#64748b', flexShrink: 0 }}
                                  icon={!figureUrl ? <PictureOutlined /> : undefined}
                                />
                                <Space direction="vertical" size={6} style={{ flex: 1, minWidth: 200 }}>
                                  <Space wrap>
                                    <Button
                                      icon={<UploadOutlined />}
                                      loading={uploadingFigure}
                                      onClick={() => figureInputRef.current?.click()}
                                    >
                                      {t('agent_edit_figure_upload')}
                                    </Button>
                                    {figureUrl && (
                                      <Button
                                        icon={<DeleteOutlined />}
                                        danger
                                        onClick={() => form.setFieldValue('figure_url', undefined)}
                                      >
                                        {t('agent_edit_figure_clear')}
                                      </Button>
                                    )}
                                  </Space>
                                  <Input
                                    size="small"
                                    placeholder={t('agent_edit_figure_path_placeholder')}
                                    value={figureUrl || ''}
                                    onChange={(e) => form.setFieldValue('figure_url', e.target.value || undefined)}
                                    style={{ fontSize: 12, color: '#64748b' }}
                                  />
                                </Space>
                              </>
                            )
                          }}
                        </Form.Item>
                        <input
                          ref={figureInputRef}
                          type="file"
                          accept=".jpg,.jpeg,.png,.gif,.webp,.svg"
                          style={{ display: 'none' }}
                          onChange={(e) => handleFigureUpload(e.target.files?.[0] || undefined)}
                        />
                      </div>
                    </Form.Item>

                    <Form.Item label={t('agent_edit_form_color')} name="color">
                      <Input prefix={<span>🎨</span>} placeholder="#667eea" style={{ width: 220 }} />
                    </Form.Item>
                  </div>
                ),
              },
              {
                key: 'soul',
                label: t('agent_edit_tab_soul'),
                children: (
                  <div style={{ paddingTop: 8 }}>
                    <div
                      style={{
                        background: '#f0f7ff',
                        border: '1px solid #bae0ff',
                        borderRadius: 8,
                        padding: '10px 14px',
                        marginBottom: 16,
                        fontSize: 12,
                        color: '#1677ff',
                        lineHeight: 1.6,
                      }}
                    >
                      <strong>{t('agent_edit_soul_stack_label')}</strong> <Tag color="blue" style={{ fontSize: 11 }}>{t('agent_edit_soul_stack_global')}</Tag> + <Tag color="purple" style={{ fontSize: 11 }}>{t('agent_edit_soul_stack_soul')}</Tag> + <Tag color="green" style={{ fontSize: 11 }}>{t('agent_edit_soul_stack_skills')}</Tag>
                      <br />{t('agent_edit_soul_stack_desc')}
                    </div>

                    <Form.Item
                      label={
                        <Space>
                          <span>{t('agent_edit_form_soul_prompt')}</span>
                          <Tag color="purple" style={{ fontSize: 11 }}>{t('agent_edit_soul_badge')}</Tag>
                        </Space>
                      }
                    >
                      <Form.Item
                        shouldUpdate={(prev, cur) => prev.system_prompt_override !== cur.system_prompt_override}
                        noStyle
                      >
                        {({ getFieldValue }) => (
                          <PromptTokenMeter
                            value={getFieldValue('system_prompt_override') || ''}
                            onChange={(val) => form.setFieldValue('system_prompt_override', val)}
                            budget={AGENT_PROMPT_BUDGET}
                          >
                            <Form.Item name="system_prompt_override" noStyle>
                              <TextArea
                                rows={12}
                                showCount
                                placeholder={t('agent_edit_soul_prompt_placeholder')}
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: 13,
                                  borderRadius: 0,
                                  border: 'none',
                                  boxShadow: 'none',
                                  resize: 'vertical',
                                }}
                              />
                            </Form.Item>
                          </PromptTokenMeter>
                        )}
                      </Form.Item>
                    </Form.Item>

                    <Form.Item label={t('agent_edit_form_skills')} name="skills">
                      <Select
                        mode="multiple"
                        allowClear
                        placeholder={t('agent_edit_skills_placeholder')}
                        optionLabelProp="label"
                        options={skillOptions.map(s => ({
                          value: s.id,
                          label: s.name || s.id,
                          title: s.description,
                        }))}
                      />
                    </Form.Item>

                    <Form.Item shouldUpdate={(prev, cur) => prev.skills !== cur.skills} noStyle>
                      {({ getFieldValue }) => {
                        const selectedSkills = (getFieldValue('skills') || []) as string[]
                        const selected = skillOptions.filter(s => selectedSkills.includes(s.id))
                        if (!selected.length) return null
                        return (
                          <div
                            style={{
                              marginTop: -12,
                              marginBottom: 16,
                              padding: 10,
                              border: '1px solid #eef1f5',
                              borderRadius: 8,
                              background: '#fafcff',
                            }}
                          >
                            <div style={{ marginTop: 4, display: 'grid', gap: 8 }}>
                              {selected.map(skill => (
                                <div key={skill.id}>
                                  <Tag color="blue" style={{ marginBottom: 4 }}>{skill.name || skill.id}</Tag>
                                  <div style={{ fontSize: 12, color: '#666', lineHeight: 1.5 }}>{skill.description}</div>
                                  <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{skill.path}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      }}
                    </Form.Item>
                  </div>
                ),
              },
              {
                key: 'capability',
                label: t('agent_edit_tab_capability'),
                children: (
                  <div style={{ paddingTop: 8 }}>
                      <Form.Item
                        label={t('agent_edit_form_tools')}
                        name="allowed_tools"
                        help={t('agent_edit_tools_help')}
                      >
                        <Select
                          mode="multiple"
                          allowClear
                          showSearch
                          optionFilterProp="value"
                          placeholder={t('agent_edit_tools_placeholder')}
                          options={(() => {
                            const baseList = selectedBaseType?.tools || []
                            const baseSet = new Set(baseList)
                            const mcpNames = new Set(mcpTools.map(x => x.name))
                            const other = allTools.filter(x => !baseSet.has(x.name) && !mcpNames.has(x.name) && !x.name.includes('__'))
                            const mcp = mcpTools.filter(x => !baseSet.has(x.name))
                            const toOpt = (n: string) => ({ value: n, label: n })
                            return [
                              { label: t('agent_edit_tools_group_base'), options: baseList.map(toOpt) },
                              { label: t('agent_edit_tools_group_other'), options: other.map(x => toOpt(x.name)) },
                              { label: t('agent_edit_tools_group_mcp'), options: mcp.map(x => toOpt(x.name)) },
                              { label: t('agent_edit_tools_group_directive'), options: [
                                { value: '@mcp:none', label: (<Tooltip title={t('agent_edit_tools_mcp_none_label')} placement="left"><span>@mcp:none</span></Tooltip>) },
                                { value: '@mcp:focus', label: (<Tooltip title={t('agent_edit_tools_mcp_focus_label')} placement="left"><span>@mcp:focus</span></Tooltip>) },
                              ] },
                            ]
                          })()}
                        />
                      </Form.Item>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <Form.Item label={t('agent_edit_form_model')} name="model_override" help={t('agent_edit_model_help')}>
                        <Input placeholder={t('agent_edit_model_placeholder')} />
                      </Form.Item>
                      <Form.Item label={t('agent_edit_form_max_steps')} name="max_steps">
                        <InputNumber
                          min={1}
                          max={100}
                          placeholder={selectedBaseType ? String(selectedBaseType.max_steps) : '20'}
                          style={{ width: '100%' }}
                        />
                      </Form.Item>
                    </div>
                  </div>
                ),
              },
              {
                key: 'comms',
                label: t('agent_edit_tab_notification'),
                children: (
                  <div style={{ paddingTop: 8 }}>
                    <Form.Item
                      name="display_name"
                      label={t('agent_edit_form_display_name')}
                      help={t('agent_edit_display_name_help')}
                    >
                      <Input placeholder={t('agent_edit_display_name_placeholder')} maxLength={60} showCount />
                    </Form.Item>

                    <Form.Item name="allowed_channels" label={t('agent_edit_form_channels')}>
                      <Checkbox.Group options={[
                        { label: t('agent_edit_channel_email'), value: 'email' },
                        { label: t('agent_edit_channel_feishu'), value: 'feishu' },
                        { label: '🟣 Teams', value: 'teams' },
                      ]} />
                    </Form.Item>
                    {/* Per-channel webhook URL config */}
                    <Form.Item
                      noStyle
                      shouldUpdate={(prev, cur) =>
                        JSON.stringify(prev.allowed_channels) !== JSON.stringify(cur.allowed_channels)
                      }
                    >
                      {({ getFieldValue }) => {
                        const channels: string[] = getFieldValue('allowed_channels') || []
                        if (!channels.includes('feishu') && !channels.includes('teams')) return null
                        return (
                          <div style={{ background: '#f8f9ff', borderRadius: 8, padding: '12px 16px', marginBottom: 16, border: '1px solid #e8eaf6' }}>
                            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>渠道 Webhook 配置（每个 Agent 独立）</Text>
                            {channels.includes('feishu') && (
                              <Form.Item
                                label={<span>🟦 飞书 Webhook</span>}
                                name={['channel_configs', 'feishu', 'webhook_url']}
                                style={{ marginBottom: 8 }}
                              >
                                <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." style={{ fontFamily: 'monospace', fontSize: 12 }} />
                              </Form.Item>
                            )}
                            {channels.includes('teams') && (
                              <Form.Item
                                label={<span>🟣 Teams Webhook</span>}
                                name={['channel_configs', 'teams', 'webhook_url']}
                                style={{ marginBottom: 0 }}
                              >
                                <Input placeholder="https://xxx.webhook.office.com/webhookb2/..." style={{ fontFamily: 'monospace', fontSize: 12 }} />
                              </Form.Item>
                            )}
                          </div>
                        )
                      }}
                    </Form.Item>

                    <div style={{ marginBottom: 16 }}>
                      <Text strong style={{ fontSize: 13 }}>{t('agent_edit_notify_on_complete')}</Text>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{t('agent_edit_notify_desc')}</Text>
                      </div>
                      <Form.List name="notification_channels">
                        {(fields, { add, remove }) => (
                          <>
                            {fields.map(({ key, name, ...restField }) => (
                              <Space key={key} style={{ display: 'flex', marginTop: 8 }} align="baseline">
                                <Form.Item {...restField} name={[name, 'type']} style={{ marginBottom: 0 }}>
                                  <Select style={{ width: 110 }} options={[
                                    { label: t('agent_edit_channel_email'), value: 'email' },
                                    { label: t('agent_edit_channel_feishu'), value: 'feishu' },
                                    { label: '🟣 Teams', value: 'teams' },
                                  ]} />
                                </Form.Item>
                                <Form.Item
                                  noStyle
                                  shouldUpdate={(prev, cur) =>
                                    prev.notification_channels?.[name]?.type !== cur.notification_channels?.[name]?.type
                                  }
                                >
                                  {({ getFieldValue }) => {
                                    const type = getFieldValue(['notification_channels', name, 'type'])
                                    const placeholder = type === 'email' ? t('agent_edit_email_placeholder') : type === 'feishu' ? t('agent_edit_feishu_placeholder') : 'Teams Incoming Webhook URL'
                                    return (
                                      <Form.Item {...restField} name={[name, 'target']} style={{ marginBottom: 0 }}>
                                        <Input placeholder={placeholder} style={{ width: 220 }} />
                                      </Form.Item>
                                    )
                                  }}
                                </Form.Item>
                                <Button
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  onClick={() => remove(name)}
                                />
                              </Space>
                            ))}
                            <Button
                              type="dashed"
                              onClick={() => add({ type: 'email', target: '' })}
                              icon={<PlusOutlined />}
                              style={{ marginTop: 8 }}
                            >
                              {t('agent_edit_add_contact')}
                            </Button>
                          </>
                        )}
                      </Form.List>
                    </div>

                    <Form.Item label={t('agent_edit_form_escalation')} help={t('agent_edit_escalation_help')}>
                      <Space>
                        <Form.Item name="escalation_contact_type" noStyle>
                          <Select style={{ width: 110 }} options={[
                            { label: t('agent_edit_channel_email'), value: 'email' },
                            { label: t('agent_edit_channel_feishu'), value: 'feishu' },
                            { label: '🟣 Teams', value: 'teams' },
                          ]} />
                        </Form.Item>
                        <Form.Item name="escalation_contact_target" noStyle>
                          <Input placeholder={t('agent_edit_contact_placeholder')} style={{ width: 220 }} />
                        </Form.Item>
                      </Space>
                    </Form.Item>
                  </div>
                ),
              },
              // ── Access Policies Tab (TASK 1.9.8.2) ───────────────────────────
              {
                key: 'access_policies',
                label: (
                  <Space size={4}>
                    <LockOutlined />
                    访问策略
                  </Space>
                ),
                children: (
                  <div style={{ paddingTop: 8 }}>
                    {!editingId ? (
                      <Text type="secondary">请先保存 Agent 后再配置访问策略。</Text>
                    ) : (
                      <>
                        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            DefaultDeny：只有在下方授权的主体才能访问此 Agent。
                          </Text>
                          {isSuperuser && (
                            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openPolicyGrant}>
                              添加授权
                            </Button>
                          )}
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: '#fafafa', borderBottom: '1px solid #f0f0f0' }}>
                              <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 500 }}>主体类型</th>
                              <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 500 }}>主体 ID</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 500 }}>查看</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 500 }}>使用</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 500 }}>配置</th>
                              <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: 500 }}>到期</th>
                              {isSuperuser && <th style={{ padding: '6px 8px' }}></th>}
                            </tr>
                          </thead>
                          <tbody>
                            {policiesLoading ? (
                              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20 }}>
                                <Spin size="small" />
                              </td></tr>
                            ) : policies.length === 0 ? (
                              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: '#bbb' }}>
                                暂无授权策略（所有人不可访问）
                              </td></tr>
                            ) : policies.map((p: any) => (
                              <tr key={p.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                <td style={{ padding: '6px 8px' }}>
                                  <Tag color={
                                    p.principal_type === 'user' ? 'blue' :
                                    p.principal_type === 'team' ? 'green' :
                                    p.principal_type === 'department' ? 'orange' : 'purple'
                                  }>
                                    {p.principal_type === 'user' ? <><UserOutlined /> 用户</> :
                                     p.principal_type === 'team' ? <><TeamOutlined /> 团队</> :
                                     p.principal_type === 'department' ? <><ApartmentOutlined /> 部门</> : '租户'}
                                  </Tag>
                                </td>
                                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: 11 }}>
                                  {p.principal_id.slice(0, 8)}…
                                </td>
                                <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                  <Tag color={p.can_view ? 'green' : 'default'}>{p.can_view ? '✓' : '✗'}</Tag>
                                </td>
                                <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                  <Tag color={p.can_use ? 'green' : 'default'}>{p.can_use ? '✓' : '✗'}</Tag>
                                </td>
                                <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                  <Tag color={p.can_config ? 'orange' : 'default'}>{p.can_config ? '✓' : '✗'}</Tag>
                                </td>
                                <td style={{ padding: '6px 8px', fontSize: 11, color: '#888' }}>
                                  {p.expires_at ? new Date(p.expires_at).toLocaleDateString('zh-CN') : '永久'}
                                </td>
                                {isSuperuser && (
                                  <td style={{ padding: '6px 8px' }}>
                                    <Popconfirm
                                      title="确认撤销此授权？"
                                      onConfirm={() => handleRevokePolicy(p.id)}
                                      okText="撤销"
                                      okButtonProps={{ danger: true }}
                                      cancelText="取消"
                                    >
                                      <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                                    </Popconfirm>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                ),
              },
              // ── Email Inbox Tab ──────────────────────────────────────────────
              {
                key: 'email_inbox',
                label: (
                  <Space size={4}>
                    <MailOutlined />
                    邮件收件箱
                  </Space>
                ),
                children: (
                  <div style={{ paddingTop: 8 }}>
                    {!editingId ? (
                      <Text type="secondary">
                        请先保存 Agent 基本信息后，重新打开编辑窗口即可配置邮件收件箱。
                      </Text>
                    ) : (
                    <>
                    <Space style={{ marginBottom: 16 }}>
                      <Switch
                        checked={emailConfig.enabled}
                        onChange={v => setEmailConfig(c => ({ ...c, enabled: v }))}
                      />
                      <Text>启用邮件自动处理</Text>
                    </Space>

                    <Divider orientation="left" plain style={{ fontSize: 12 }}>
                      监听邮箱地址
                    </Divider>
                    <Select
                      mode="tags"
                      style={{ width: '100%' }}
                      placeholder="输入邮箱地址后按 Enter 添加，如 support@example.com"
                      value={emailConfig.monitored_addresses}
                      onChange={v => setEmailConfig(c => ({ ...c, monitored_addresses: v }))}
                      tokenSeparators={[',', ' ']}
                      open={false}
                    />
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                      只有发往以上地址的邮件才会进入本 Agent 处理队列。
                    </Text>

                    <Divider orientation="left" plain style={{ fontSize: 12, marginTop: 20 }}>
                      回复发件地址（Reply-From）
                    </Divider>
                    <Input
                      placeholder="如 noreply@your-domain.com — 留空则使用收件人地址或系统 SMTP_FROM"
                      value={emailConfig.reply_from}
                      onChange={e => setEmailConfig(c => ({ ...c, reply_from: e.target.value.trim() }))}
                    />
                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                      回复邮件的 From 地址。需在 Exchange / Office 365 中为 SMTP 账号授予该地址的「Send As」权限。
                      留空时自动使用来信收件地址（推荐）。
                    </Text>

                    <Divider orientation="left" plain style={{ fontSize: 12, marginTop: 20 }}>
                      巡检间隔
                    </Divider>
                    <Select
                      style={{ width: 180 }}
                      value={emailConfig.poll_interval_minutes}
                      onChange={v => setEmailConfig(c => ({ ...c, poll_interval_minutes: v }))}
                      options={[
                        { label: '每 1 分钟', value: 1 },
                        { label: '每 5 分钟', value: 5 },
                        { label: '每 10 分钟', value: 10 },
                        { label: '每 30 分钟', value: 30 },
                        { label: '每 60 分钟', value: 60 },
                      ]}
                    />

                    <Divider orientation="left" plain style={{ fontSize: 12, marginTop: 20 }}>
                      邮件主题过滤词（匹配则跳过）
                    </Divider>
                    <Select
                      mode="tags"
                      style={{ width: '100%' }}
                      placeholder="如：通知、订阅 — 按 Enter 添加"
                      value={emailConfig.subject_blocklist}
                      onChange={v => setEmailConfig(c => ({ ...c, subject_blocklist: v }))}
                      tokenSeparators={[',', '，', ' ', '　']}
                      open={false}
                    />

                    <Divider orientation="left" plain style={{ fontSize: 12, marginTop: 20 }}>
                      发件人黑名单
                    </Divider>
                    <Select
                      mode="tags"
                      style={{ width: '100%' }}
                      placeholder="如 noreply@example.com — 按 Enter 添加"
                      value={emailConfig.sender_blocklist}
                      onChange={v => setEmailConfig(c => ({ ...c, sender_blocklist: v }))}
                      tokenSeparators={[',', '，', ' ', '　']}
                      open={false}
                    />

                    </>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Form>
      </Modal>

      {/* Grant Policy Modal */}
      <Modal
        title="添加访问授权"
        open={policyGrantOpen}
        onCancel={() => setPolicyGrantOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={policyForm} layout="vertical" onFinish={handleGrantPolicy}>
          <Form.Item label="主体类型" name="principal_type" rules={[{ required: true }]}>
            <Select
              placeholder="选择主体类型"
              options={[
                { value: 'user', label: <Space><UserOutlined />用户</Space> },
                { value: 'team', label: <Space><TeamOutlined />团队</Space> },
                { value: 'department', label: <Space><ApartmentOutlined />部门</Space> },
                { value: 'tenant', label: '租户（全体）' },
              ]}
              onChange={() => policyForm.setFieldValue('principal_id', undefined)}
            />
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.principal_type !== cur.principal_type}
          >
            {({ getFieldValue }) => {
              const ptype = getFieldValue('principal_type')
              if (ptype === 'user') return (
                <Form.Item label="用户" name="principal_id" rules={[{ required: true }]}>
                  <Select
                    showSearch placeholder="搜索用户"
                    filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
                    options={policyUsers.map((u: any) => ({ value: u.id, label: `${u.username}${u.email ? ` (${u.email})` : ''}` }))}
                  />
                </Form.Item>
              )
              if (ptype === 'team') return (
                <Form.Item label="团队" name="principal_id" rules={[{ required: true }]}>
                  <Select showSearch placeholder="选择团队"
                    filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
                    options={policyTeams.map((t: any) => ({ value: t.id, label: t.name }))}
                  />
                </Form.Item>
              )
              if (ptype === 'department') return (
                <Form.Item label="部门" name="principal_id" rules={[{ required: true }]}>
                  <Select showSearch placeholder="选择部门"
                    filterOption={(input, opt) => (opt?.label as string || '').toLowerCase().includes(input.toLowerCase())}
                    options={policyDepts.map((d: any) => ({ value: d.id, label: d.name }))}
                  />
                </Form.Item>
              )
              if (ptype === 'tenant') return (
                <Form.Item label="主体 ID" name="principal_id" rules={[{ required: true }]}>
                  <Input placeholder="输入 tenant_id（全体生效）" />
                </Form.Item>
              )
              return null
            }}
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <Form.Item label="查看" name="can_view" valuePropName="checked" initialValue={true}>
              <Switch defaultChecked />
            </Form.Item>
            <Form.Item label="使用" name="can_use" valuePropName="checked" initialValue={true}>
              <Switch defaultChecked />
            </Form.Item>
            <Form.Item label="配置" name="can_config" valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
          </div>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">授权</Button>
              <Button onClick={() => setPolicyGrantOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* Wukong: Instance panel drawer */}
      {instancePanelAgent && (
        <AgentInstancePanel
          agentType={instancePanelAgent.agent_type}
          agentName={aname(instancePanelAgent)}
          open={!!instancePanelAgent}
          onClose={() => setInstancePanelAgent(null)}
        />
      )}

      <Modal
        title={
          selectedAgent && (
            <Space>
              <Tag color="default" style={{ fontSize: 11, marginRight: 0 }}>{t('agent_list_view_detail')}</Tag>
              <Avatar
                size={40}
                src={selectedAgent.figure_url || (selectedAgent.icon?.startsWith('/') ? selectedAgent.icon : undefined) || undefined}
                style={{ background: selectedAgent.color || '#667eea' }}
              >
                {!selectedAgent.figure_url && !selectedAgent.icon?.startsWith('/') ? agentEmoji(selectedAgent.agent_type) : null}
              </Avatar>
              <span>{aname(selectedAgent)}</span>
              <Tag color={selectedAgent.color || 'blue'} style={{ marginLeft: 4 }}>
                {selectedAgent.agent_type_label}
              </Tag>
            </Space>
          )
        }
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailVisible(false)}>{t('agent_list_close')}</Button>,
          <Button key="edit" type="primary" icon={<EditOutlined />} onClick={() => { setDetailVisible(false); if (selectedAgent) handleEdit(selectedAgent) }}>
            {t('agent_list_edit')}
          </Button>,
        ]}
        width={640}
      >
        {selectedAgent && (
          <div style={{ marginTop: 16 }}>
            {selectedAgent.figure_url && (
              <div style={{ marginBottom: 16 }}>
                <Image
                  src={selectedAgent.figure_url}
                  alt={aname(selectedAgent)}
                  width={96}
                  height={96}
                  style={{ objectFit: 'cover', borderRadius: 16, border: '1px solid #eef2f7' }}
                  preview={false}
                />
              </div>
            )}
            {selectedAgent.description && (
              <p style={{ color: '#666', marginBottom: 20 }}>{selectedAgent.description}</p>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <StatBox icon="🏢" label="Dept" value={normalizeDepartment(selectedAgent.department, notGroupedLabel)} />
              <StatBox icon="⚡" label="Max Steps" value={String(selectedAgent.effective_max_steps)} />
              <StatBox icon="🧩" label="Tools" value={String(selectedAgent.effective_tools.length)} />
              <StatBox icon="📚" label="Skills" value={String(selectedAgent.skills?.length || 0)} />
              <StatBox icon="🧠" label="Model" value={selectedAgent.model_override || 'default'} />
              <StatBox icon="📡" label="Status" value={selectedAgent.is_active ? 'active' : 'inactive'} />
            </div>

            {!!selectedAgent.skills?.length && (
              <div style={{ marginBottom: 16 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>Skills</Text>
                <div style={{ marginTop: 6 }}>
                  {selectedAgent.skills.map(skillId => {
                    const skill = skillOptions.find(s => s.id === skillId)
                    return (
                      <Tooltip key={skillId} title={skill?.description || skillId}>
                        <Tag color="blue" style={{ marginBottom: 4, fontSize: 11 }}>{skill?.name || skillId}</Tag>
                      </Tooltip>
                    )
                  })}
                </div>
              </div>
            )}

            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Tools</Text>
              <div style={{ marginTop: 6 }}>
                {selectedAgent.effective_tools.map(t => (
                  <Tag key={t} style={{ marginBottom: 4, fontSize: 11 }}>{t}</Tag>
                ))}
              </div>
            </div>

            {selectedAgent.system_prompt_override && (
              <div style={{ marginTop: 16 }}>
                <Space size={6} style={{ marginBottom: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('agent_edit_tab_soul')}</Text>
                  <Tag color="purple" style={{ fontSize: 11 }}>system_prompt_override</Tag>
                </Space>
                <div
                  style={{
                    background: '#fdf4ff',
                    border: '1px solid #e9d5ff',
                    padding: 10,
                    borderRadius: 6,
                    marginTop: 4,
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    maxHeight: 180,
                    overflow: 'auto',
                    color: '#444',
                    fontFamily: 'monospace',
                  }}
                >
                  {selectedAgent.system_prompt_override}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function CapacityBar({ agentType, onClick }: { agentType: string; onClick?: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AgentTypeStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    agentInstanceApi.typeStatus(agentType)
      .then(data => { if (!cancelled) setStatus(data) })
      .catch(() => { /* best-effort */ })
    // Refresh every 10 s while tile is mounted
    const timer = setInterval(() => {
      agentInstanceApi.typeStatus(agentType)
        .then(data => { if (!cancelled) setStatus(data) })
        .catch(() => {})
    }, 10_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [agentType])

  if (!status || status.total_slots === 0) return null

  const busyPct  = Math.round((status.busy  / status.total_slots) * 100)
  const queuedPct = status.queued > 0 ? Math.min(100, Math.round((status.queued / status.total_slots) * 100)) : 0
  const label = status.busy === 0
    ? `idle`
    : `${status.busy}/${status.total_slots}${status.queued > 0 ? ` +${status.queued}` : ''}`
  const color = status.busy >= status.total_slots
    ? '#ff4d4f'   // all busy — red
    : status.busy > 0
      ? '#faad14'  // partially busy — amber
      : '#52c41a'  // all idle — green

  return (
    <Tooltip
      title={
        <div style={{ fontSize: 11, lineHeight: 1.8 }}>
          <div>{t('agent_list_slots_total', { count: status.total_slots })}</div>
          <div>{t('agent_list_slots_busy', { count: status.busy })}</div>
          <div>{t('agent_list_slots_idle', { count: status.idle })}</div>
          {status.queued > 0 && <div style={{ color: '#faad14' }}>{t('agent_list_slots_queued', { count: status.queued })}</div>}
          {onClick && <div style={{ color: '#aaa', marginTop: 4 }}>{t('agent_list_click_for_detail')}</div>}
        </div>
      }
      placement="bottom"
    >
      <div
        style={{ width: '100%', padding: '0 2px', cursor: onClick ? 'pointer' : 'default' }}
        onClick={(e) => { e.stopPropagation(); onClick?.() }}
      >
        <Progress
          percent={busyPct}
          size="small"
          strokeColor={color}
          trailColor={queuedPct > 0 ? '#fff1b8' : '#f0f0f0'}
          showInfo={false}
          style={{ margin: 0, lineHeight: 1 }}
        />
        <div style={{ textAlign: 'center', fontSize: 10, color: '#94a3b8', lineHeight: 1.2, marginTop: 1 }}>
          {label}
        </div>
      </div>
    </Tooltip>
  )
}

function AgentTile({
  agent,
  onView,
  onEdit,
  onDelete,
  onExport,
  onToggleActive,
  onToggleFavorite,
  selected,
  onSelectChange,
  onCapacityClick,
  pendingEmailCount = 0,
}: {
  agent: AgentDefinition
  onView: (agent: AgentDefinition) => void
  onEdit: (agent: AgentDefinition) => void
  onDelete: (id: string) => void
  onExport: (agent: AgentDefinition) => void
  onToggleActive: (agent: AgentDefinition, active: boolean) => void
  onToggleFavorite: (agent: AgentDefinition) => void
  selected: boolean
  onSelectChange: (agentId: string, checked: boolean) => void
  onCapacityClick?: (agent: AgentDefinition) => void
  pendingEmailCount?: number
}) {
  const { t, i18n } = useTranslation()
  const aname = (a: AgentDefinition) => getAgentName(a, i18n.language as LangCode)
  const color = agent.color || '#667eea'
  const menuItems = [
    {
      key: 'view',
      icon: <EyeOutlined />,
      label: t('agent_list_view_detail'),
    },
    {
      key: 'edit',
      icon: <EditOutlined />,
      label: t('agent_list_edit'),
    },
    {
      key: 'export',
      icon: <DownloadOutlined />,
      label: t('agent_list_export'),
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      label: t('agent_list_delete_tooltip'),
      danger: true,
    },
  ]

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === 'view') {
      onView(agent)
      return
    }
    if (key === 'edit') {
      onEdit(agent)
      return
    }
    if (key === 'export') {
      onExport(agent)
      return
    }
    if (key === 'delete') {
      Modal.confirm({
        title: t('agent_list_delete_tooltip'),
        okButtonProps: { danger: true },
        onOk: () => onDelete(agent.id),
      })
    }
  }

  return (
    <div
      style={{
        borderRadius: 12,
        border: '1px solid #eef2f7',
        background: '#fbfcfe',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        minHeight: 148,
        opacity: agent.is_active ? 1 : 0.6,
        position: 'relative',
      }}
    >
      <Checkbox
        checked={selected}
        onChange={(e) => onSelectChange(agent.id, e.target.checked)}
        style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
      />
      <Dropdown
        trigger={['contextMenu', 'click']}
        menu={{ items: menuItems, onClick: handleMenuClick }}
      >
        <div style={{ cursor: 'context-menu', position: 'relative' }}>
          <Badge
            count={pendingEmailCount}
            offset={[-4, 4]}
            style={{ backgroundColor: '#ff4d4f' }}
          >
            <Avatar
              size={60}
              src={agent.figure_url || (agent.icon?.startsWith('/') ? agent.icon : undefined) || undefined}
              style={{
                background: `${color}18`,
                color,
                border: `1px solid ${color}22`,
                boxShadow: `0 6px 14px ${color}14`,
                flexShrink: 0,
              }}
            >
              {!agent.figure_url && !agent.icon?.startsWith('/') ? agentEmoji(agent.agent_type) : null}
            </Avatar>
          </Badge>
        </div>
      </Dropdown>

      <div style={{ textAlign: 'center', minHeight: 34, cursor: 'pointer' }} onClick={() => onView(agent)}>
        <div
          style={{
            fontWeight: 600,
            fontSize: 12,
            color: '#1f2937',
            lineHeight: 1.25,
            wordBreak: 'break-word',
          }}
        >
          {aname(agent)}
        </div>
        <Text type="secondary" style={{ fontSize: 10 }}>
          {agent.agent_type_label}
        </Text>
      </div>

      <Space size={2} wrap style={{ justifyContent: 'center' }}>
        {!!agent.skills?.length && <Tag color="blue" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '18px', paddingInline: 6 }}>{t('agent_list_skills_count', { count: agent.skills.length })}</Tag>}
        {agent.visibility === 'public'     && <Tag color="cyan"   style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>🌐</Tag>}
        {agent.visibility === 'role_based' && <Tag color="orange" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>🔑</Tag>}
        {agent.visibility === 'private'    && <Tag color="default" style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px', paddingInline: 4 }}>🔒</Tag>}
      </Space>

      {/* Favorite star — top-right overlay */}
      <Tooltip title={agent.is_favorite ? t('agent_unpin_tooltip') : t('agent_pin_tooltip')} placement="top">
        <span
          style={{ position: 'absolute', top: 6, right: 6, fontSize: 14, cursor: 'pointer', zIndex: 10, lineHeight: 1 }}
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(agent) }}
        >
          {agent.is_favorite ? '⭐' : '☆'}
        </span>
      </Tooltip>

      <div style={{ width: '100%', marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Tooltip title={agent.is_active ? t('agent_tile_disable_tooltip') : t('agent_tile_enable_tooltip')} placement="bottom">
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onToggleActive(agent, !agent.is_active) }}
          >
            <Switch
              size="small"
              checked={agent.is_active}
              onChange={(checked, e) => { (e as React.MouseEvent).stopPropagation(); onToggleActive(agent, checked) }}
            />
            <Text style={{ fontSize: 10, color: agent.is_active ? '#52c41a' : '#bfbfbf' }}>
              {agent.is_active ? t('agent_tile_enabled') : t('agent_tile_disabled')}
            </Text>
          </div>
        </Tooltip>
        <CapacityBar
          agentType={agent.agent_type}
          onClick={onCapacityClick ? () => onCapacityClick(agent) : undefined}
        />
      </div>
    </div>
  )
}

function StatBox({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{ background: '#f9f9fb', borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 20 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, color: '#999' }}>{label}</div>
        <div style={{ fontWeight: 600, fontSize: 14, color: '#333', wordBreak: 'break-word' }}>{value}</div>
      </div>
    </div>
  )
}

export default AgentList
