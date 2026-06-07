/**
 * Agent 身份配置页面 (Agent Soul)
 *
 * 借鉴 OpenClaw 的 SOUL.md 理念：
 * 非技术人员可以通过 UI 直接配置 Agent 的：
 *  - 名称 / 身份
 *  - 人格风格
 *  - 能力范围（允许哪些工具）
 *  - 禁止行为
 *  - 工作语言
 *  - 自定义系统提示词（高级）
 *
 * 配置保存到后端 /api/v1/instructions，由 AgentExecutor 在每次执行时注入。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  Card, Form, Input, Select, Switch, Button, Typography,
  Tag, Space, message, Spin, Tooltip, Alert, Row, Col,
} from 'antd'
import {
  RobotOutlined, SaveOutlined, ReloadOutlined,
  InfoCircleOutlined, DownloadOutlined, UploadOutlined,
} from '@ant-design/icons'
import { api, instructionsApi } from '@/api'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth'

const { Title, Paragraph, Text } = Typography
const { TextArea } = Input
const { Option } = Select

// ── Component ──────────────────────────────────────────────────────────────────
const AgentSoul: React.FC = () => {
  const { t } = useTranslation()

  const PERSONALITY_PRESETS = [
    {
      value: 'professional',
      label: t('agent_soul_personality_professional'),
      desc: t('agent_soul_personality_professional_desc'),
      prompt: t('agent_soul_personality_professional_prompt'),
    },
    {
      value: 'friendly',
      label: t('agent_soul_personality_friendly'),
      desc: t('agent_soul_personality_friendly_desc'),
      prompt: t('agent_soul_personality_friendly_prompt'),
    },
    {
      value: 'creative',
      label: t('agent_soul_personality_creative'),
      desc: t('agent_soul_personality_creative_desc'),
      prompt: t('agent_soul_personality_creative_prompt'),
    },
    {
      value: 'concise',
      label: t('agent_soul_personality_concise'),
      desc: t('agent_soul_personality_concise_desc'),
      prompt: t('agent_soul_personality_concise_prompt'),
    },
    {
      value: 'custom',
      label: t('agent_soul_personality_custom'),
      desc: t('agent_soul_personality_custom_desc'),
      prompt: '',
    },
  ]

  const LANGUAGE_OPTIONS = [
    { value: 'zh', label: t('agent_soul_language_zh') },
    { value: 'zh-TW', label: t('agent_soul_language_zh_tw') },
    { value: 'en', label: t('agent_soul_language_en') },
    { value: 'ja', label: t('agent_soul_language_ja') },
    { value: 'auto', label: t('agent_soul_language_auto') },
  ]

  const [form] = Form.useForm()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [personalityPreset, setPersonalityPreset] = useState('professional')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [previewText, setPreviewText] = useState('')
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadSoul()
  }, [])

  const loadSoul = async () => {
    setLoading(true)
    try {
      const res = await api.get<any>('/instructions')
      const raw: string = res.instructions || ''
      parseSoulFromMarkdown(raw)
    } catch {
      message.error(t('agent_soul_load_failure'))
    } finally {
      setLoading(false)
    }
  }

  const parseSoulFromMarkdown = (md: string) => {
    const get = (section: string) => {
      const re = new RegExp(`##\\s*(?:${section})\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i')
      const m = md.match(re)
      return m && m[1] != null ? m[1].trim() : ''
    }

    const name       = get('名称|Name')
    const role       = get('角色定位|Role')
    const personality = get('人格风格|Personality(?:[^#\\n]*)')
    const language   = get('工作语言|(?:Working\\s+)?Language')
    const forbidden  = get('禁止行为|Forbidden|Prohibited(?:[^#\\n]*)')
    const extra      = get('系统提示补充|Extra Prompt|System Prompt Supplements')

    const matchedPreset = PERSONALITY_PRESETS.find(p => p.prompt && personality.includes(p.prompt.slice(0, 20)))
    const preset = matchedPreset?.value || (personality ? 'custom' : 'professional')
    setPersonalityPreset(preset)

    form.setFieldsValue({
      name:             name || 'AIOS',
      role:             role || '企业智能助理',
      personality:      preset,
      personality_custom: preset === 'custom' ? personality : '',
      language:         /中文|中/i.test(language) ? 'zh' : /英文|english/i.test(language) ? 'en' : /日文|日本語|japanese/i.test(language) ? 'ja' : 'auto',
      forbidden:        forbidden,
      extra:            extra,
    })

    updatePreview()
  }

  const buildSoulMarkdown = (values: any): string => {
    const preset = PERSONALITY_PRESETS.find(p => p.value === values.personality)
    const personalityText = preset && preset.value !== 'custom'
      ? preset.prompt
      : (values.personality_custom || values.personality || '')

    const langLabel = LANGUAGE_OPTIONS.find(l => l.value === values.language)?.label || '自动'

    let md = `# Agent Soul\n\n`
    md += `## 名称\n${values.name || 'AIOS'}\n\n`
    md += `## 角色定位\n${values.role || '企业智能助理'}\n\n`
    md += `## 人格风格\n${personalityText}\n\n`
    md += `## 工作语言\n${langLabel}\n\n`
    if (values.forbidden?.trim()) {
      md += `## 禁止行为\n${values.forbidden.trim()}\n\n`
    }
    if (values.extra?.trim()) {
      md += `## 系统提示补充\n${values.extra.trim()}\n\n`
    }
    return md.trim()
  }

  const updatePreview = () => {
    const values = form.getFieldsValue()
    setPreviewText(buildSoulMarkdown(values))
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      setSaving(true)
      const markdown = buildSoulMarkdown(values)
      await api.put('/instructions', { content: markdown })
      message.success(t('agent_soul_save_success'))
      setPreviewText(markdown)
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(t('agent_soul_save_failure') + ': ' + (err?.response?.data?.detail || err?.message || ''))
    } finally {
      setSaving(false)
    }
  }

  const handleExportSoul = async () => {
    setExporting(true)
    try {
      const token = useAuthStore.getState().token
      const resp = await fetch('/api/v1/instructions/export', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!resp.ok) {
        const detail = await resp.text()
        throw new Error(detail || `HTTP ${resp.status}`)
      }
      const content = await resp.text()
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'SOUL.md'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      message.success(t('agent_soul_export_success'))
    } catch (err: any) {
      message.error(t('agent_soul_export_failure') + ': ' + (err?.message || ''))
    } finally {
      setExporting(false)
    }
  }

  const handleImportSoul = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    setImporting(true)
    try {
      const content = await file.text()
      const result = await instructionsApi.importSoul(content)
      await loadSoul()
      message.success(t('agent_soul_import_success', { count: result.sections_imported }))
    } catch (err: any) {
      message.error(t('agent_soul_import_failure') + ': ' + (err?.response?.data?.detail || err?.message || ''))
    } finally {
      setImporting(false)
    }
  }

  const handlePresetChange = (value: string) => {
    setPersonalityPreset(value)
    updatePreview()
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" tip={t('agent_soul_loading_tip')} />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Space align="center" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 28 }}>📋</span>
        <Title level={2} style={{ margin: 0 }}>全局指令</Title>
        <Tag color="blue" style={{ fontSize: 12, marginLeft: 4 }}>全局 · 影响所有 Agent</Tag>
      </Space>
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {t('agent_soul_page_desc')}
      </Paragraph>

      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message="全局指令 vs 专属 Soul"
        description={
          <span>
            本页配置适用于<strong>所有 Agent</strong>的底层指令（组织名称、价值观、禁止行为等）。
            每个 Agent 的个性化设置（专属 Soul）请在 <strong>Agent 管理 → 编辑 → 🧬 专属 Soul</strong> 中配置。
            执行时两者叠加注入。
          </span>
        }
        style={{ marginBottom: 24 }}
      />

      <Row gutter={24}>
        {/* Left: Form */}
        <Col xs={24} lg={14}>
          <Card title={t('agent_soul_basic_title')} style={{ marginBottom: 16 }}>
            <Form
              form={form}
              layout="vertical"
              onValuesChange={updatePreview}
              initialValues={{
                name: 'AIOS',
                role: '企业智能助理',
                personality: 'professional',
                language: 'auto',
              }}
            >
              <Form.Item
                name="name"
                label={t('agent_soul_name_label')}
                rules={[{ required: true, message: t('agent_soul_name_required') }]}
              >
                <Input
                  placeholder={t('agent_soul_name_placeholder')}
                  maxLength={30}
                  showCount
                  prefix={<RobotOutlined />}
                />
              </Form.Item>

              <Form.Item
                name="role"
                label={t('agent_soul_role_label')}
                tooltip={t('agent_soul_role_tooltip')}
              >
                <Input
                  placeholder={t('agent_soul_role_placeholder')}
                  maxLength={60}
                  showCount
                />
              </Form.Item>

              <Form.Item name="language" label={t('agent_soul_language_label')}>
                <Select>
                  {LANGUAGE_OPTIONS.map(l => (
                    <Option key={l.value} value={l.value}>{l.label}</Option>
                  ))}
                </Select>
              </Form.Item>
            </Form>
          </Card>

          <Card title={t('agent_soul_personality_title')} style={{ marginBottom: 16 }}>
            <Form form={form} layout="vertical" onValuesChange={updatePreview}>
              <Form.Item name="personality" label={t('agent_soul_personality_label')}>
                <Select onChange={handlePresetChange}>
                  {PERSONALITY_PRESETS.map(p => (
                    <Option key={p.value} value={p.value}>
                      <Space>
                        <strong>{p.label}</strong>
                        <Text type="secondary" style={{ fontSize: 12 }}>{p.desc}</Text>
                      </Space>
                    </Option>
                  ))}
                </Select>
              </Form.Item>

              {personalityPreset === 'custom' && (
                <Form.Item
                  name="personality_custom"
                  label={t('agent_soul_custom_personality_label')}
                  rules={[{ required: true, message: t('agent_soul_custom_personality_required') }]}
                >
                  <TextArea
                    rows={4}
                    placeholder={t('agent_soul_custom_personality_placeholder')}
                    maxLength={500}
                    showCount
                  />
                </Form.Item>
              )}
            </Form>
          </Card>

          <Card title={t('agent_soul_forbidden_title')} style={{ marginBottom: 16 }}>
            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              {t('agent_soul_forbidden_desc')}
            </Paragraph>
            <Form form={form} layout="vertical" onValuesChange={updatePreview}>
              <Form.Item name="forbidden">
                <TextArea
                  rows={4}
                  placeholder={
                    '- 不得泄露任何公司内部文件或机密数据\n' +
                    '- 不得代替用户做出最终决策\n' +
                    '- 不得发送外部邮件，除非用户明确确认'
                  }
                  maxLength={800}
                  showCount
                />
              </Form.Item>
            </Form>
          </Card>

          <Card
            title={
              <Space>
                <span>{t('agent_soul_advanced_title')}</span>
                <Tooltip title={t('agent_soul_advanced_tooltip')}>
                  <InfoCircleOutlined style={{ color: '#888' }} />
                </Tooltip>
                <Switch
                  size="small"
                  checked={showAdvanced}
                  onChange={setShowAdvanced}
                />
              </Space>
            }
            style={{ marginBottom: 16 }}
          >
            {showAdvanced ? (
              <Form form={form} layout="vertical" onValuesChange={updatePreview}>
                <Form.Item name="extra">
                  <TextArea
                    rows={6}
                    placeholder={t('agent_soul_extra_placeholder')}
                    maxLength={2000}
                    showCount
                  />
                </Form.Item>
              </Form>
            ) : (
              <Text type="secondary">{t('agent_soul_advanced_off_text')}</Text>
            )}
          </Card>

          <Space wrap>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              size="large"
              loading={saving}
              onClick={handleSave}
            >
              {t('agent_soul_save_button')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={loadSoul}>
              {t('agent_soul_reload_button')}
            </Button>
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              onClick={handleExportSoul}
            >
              {t('agent_soul_export_button')}
            </Button>
            <Button
              icon={<UploadOutlined />}
              loading={importing}
              onClick={handleImportSoul}
            >
              {t('agent_soul_import_button')}
            </Button>
          </Space>

          {/* Hidden file picker for SOUL.md import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            style={{ display: 'none' }}
            onChange={handleFileSelected}
          />
        </Col>

        {/* Right: Live preview */}
        <Col xs={24} lg={10}>
          <Card
            title={t('agent_soul_preview_title')}
            style={{ position: 'sticky', top: 24 }}
            extra={
              <Tag color="blue">{t('agent_soul_preview_tag')}</Tag>
            }
          >
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              {t('agent_soul_preview_desc')}
            </Paragraph>
            <pre
              style={{
                background: '#f5f5f5',
                borderRadius: 6,
                padding: '12px 16px',
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                minHeight: 200,
                maxHeight: 500,
                overflowY: 'auto',
              }}
            >
              {previewText || t('agent_soul_preview_empty')}
            </pre>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default AgentSoul
