import React, { useEffect, useState, useCallback } from 'react'
import {
  Button, Input, Select, Space, Spin, Tag, Tabs, Tooltip,
  Typography, message, Popconfirm, Form, Modal, Row, Col, Card, Empty,
} from 'antd'
import {
  DeleteOutlined, EditOutlined, FileTextOutlined,
  PlusOutlined, SaveOutlined, CloseOutlined, ReloadOutlined,
  GlobalOutlined, LeftOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '@/api'
import { useTranslation } from 'react-i18next'

const { Text } = Typography
const { TextArea } = Input

interface DocPage {
  id: string
  category: string
  title: string
  content: string
  title_zh: string | null
  content_zh: string | null
  title_ja: string | null
  content_ja: string | null
  version: string | null
  order_index: number
  created_at: string
  updated_at: string
}

interface Category {
  key: string
  label: string
}

const CATEGORY_COLORS: Record<string, string> = {
  tech_standards: 'blue',
  user_manual:    'green',
  installation:   'orange',
  release_notes:  'purple',
  agent_manual:   'cyan',
  other:          'default',
}

const LANG_LABELS: Record<string, string> = {
  en: 'English',
  zh: '中文',
  ja: '日本語',
}

function toLangKey(i18nLang: string): 'en' | 'zh' | 'ja' {
  if (i18nLang.startsWith('zh')) return 'zh'
  if (i18nLang.startsWith('ja')) return 'ja'
  return 'en'
}

function localTitle(doc: DocPage, lang: 'en' | 'zh' | 'ja'): string {
  if (lang === 'zh') return doc.title_zh || doc.title
  if (lang === 'ja') return doc.title_ja || doc.title
  return doc.title
}

function localContent(doc: DocPage, lang: 'en' | 'zh' | 'ja'): string {
  if (lang === 'zh') return doc.content_zh || doc.content
  if (lang === 'ja') return doc.content_ja || doc.content
  return doc.content
}

function isFallback(doc: DocPage, lang: 'en' | 'zh' | 'ja'): boolean {
  if (lang === 'en') return false
  if (lang === 'zh') return !doc.content_zh
  if (lang === 'ja') return !doc.content_ja
  return false
}

const DocumentCenterPage: React.FC = () => {
  const { t, i18n } = useTranslation()
  const lang = toLangKey(i18n.language)

  const [categories, setCategories]   = useState<Category[]>([])
  const [docs, setDocs]               = useState<DocPage[]>([])
  const [selectedCat, setSelectedCat] = useState<string>('all')
  const [selectedDoc, setSelectedDoc] = useState<DocPage | null>(null)
  const [loading, setLoading]         = useState(false)
  const [editing, setEditing]         = useState(false)
  const [saving, setSaving]           = useState(false)
  const [isNewModal, setIsNewModal]   = useState(false)
  const [newForm]                     = Form.useForm()

  const [editVersion, setEditVersion] = useState('')
  const [editLang, setEditLang]       = useState<'en' | 'zh' | 'ja'>('en')
  const [editFields, setEditFields]   = useState<Record<string, { title: string; content: string }>>({
    en: { title: '', content: '' },
    zh: { title: '', content: '' },
    ja: { title: '', content: '' },
  })

  const fetchCategories = useCallback(async () => {
    try {
      const data = await api.get<Category[]>('/docs/categories')
      setCategories(data as any)
    } catch { /* ignore */ }
  }, [])

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<DocPage[]>('/docs')
      setDocs(data as any)
    } catch {
      message.error(t('docs_load_failed', 'Failed to load documents'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchCategories()
    fetchDocs()
  }, [fetchCategories, fetchDocs])

  const filteredDocs = selectedCat === 'all'
    ? docs
    : docs.filter(d => d.category === selectedCat)

  const handleEdit = () => {
    if (!selectedDoc) return
    setEditVersion(selectedDoc.version || '')
    setEditLang(lang)
    setEditFields({
      en: { title: selectedDoc.title,           content: selectedDoc.content },
      zh: { title: selectedDoc.title_zh  || '', content: selectedDoc.content_zh  || '' },
      ja: { title: selectedDoc.title_ja  || '', content: selectedDoc.content_ja  || '' },
    })
    setEditing(true)
  }

  const handleSave = async () => {
    if (!selectedDoc) return
    setSaving(true)
    try {
      const updated = await api.put<DocPage>(`/docs/${selectedDoc.id}`, {
        title:      editFields.en.title,
        content:    editFields.en.content,
        title_zh:   editFields.zh.title   || null,
        content_zh: editFields.zh.content || null,
        title_ja:   editFields.ja.title   || null,
        content_ja: editFields.ja.content || null,
        version:    editVersion || null,
      })
      const u = updated as any
      setDocs(prev => prev.map(d => d.id === u.id ? u : d))
      setSelectedDoc(u)
      setEditing(false)
      message.success(t('docs_saved', 'Document saved'))
    } catch {
      message.error(t('docs_save_failed', 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (doc: DocPage) => {
    try {
      await api.delete(`/docs/${doc.id}`)
      setDocs(prev => prev.filter(d => d.id !== doc.id))
      if (selectedDoc?.id === doc.id) setSelectedDoc(null)
      message.success(t('docs_deleted', 'Document deleted'))
    } catch {
      message.error(t('docs_delete_failed', 'Failed to delete'))
    }
  }

  const handleCreate = async (values: any) => {
    try {
      const created = await api.post<DocPage>('/docs', {
        category:    values.category,
        title:       values.title,
        version:     values.version || null,
        content:     `# ${values.title}\n\n`,
        order_index: 0,
      })
      const c = created as any
      setDocs(prev => [...prev, c])
      setSelectedDoc(c)
      setIsNewModal(false)
      newForm.resetFields()
      setEditVersion(c.version || '')
      setEditLang(lang)
      setEditFields({
        en: { title: c.title, content: c.content },
        zh: { title: '', content: '' },
        ja: { title: '', content: '' },
      })
      setEditing(true)
    } catch {
      message.error(t('docs_create_failed', 'Failed to create document'))
    }
  }

  const setLangField = (l: 'en' | 'zh' | 'ja', field: 'title' | 'content', value: string) => {
    setEditFields(prev => ({ ...prev, [l]: { ...prev[l], [field]: value } }))
  }

  // Category tab items (top bar)
  const catTabs = [
    { key: 'all', label: t('docs_all', 'All') },
    ...categories.map(c => ({
      key: c.key,
      label: (
        <span>
          {c.label}
          <Text type="secondary" style={{ marginLeft: 4, fontSize: 11 }}>
            ({docs.filter(d => d.category === c.key).length})
          </Text>
        </span>
      ),
    })),
  ]

  // Language tabs for editor
  const langTabItems = (['en', 'zh', 'ja'] as const).map(l => ({
    key: l,
    label: (
      <span>
        <GlobalOutlined style={{ marginRight: 4 }} />
        {LANG_LABELS[l]}
        {l !== 'en' && !editFields[l].content && (
          <Text type="secondary" style={{ marginLeft: 4, fontSize: 10 }}>
            ({t('docs_fallback_en', 'falls back to EN')})
          </Text>
        )}
      </span>
    ),
    children: (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Input
          value={editFields[l].title}
          onChange={e => setLangField(l, 'title', e.target.value)}
          style={{ fontWeight: 600, fontSize: 15 }}
          placeholder={l === 'en'
            ? t('docs_title_placeholder', 'Document title')
            : `${t('docs_title_placeholder', 'Document title')} (${LANG_LABELS[l]})`}
        />
        <TextArea
          value={editFields[l].content}
          onChange={e => setLangField(l, 'content', e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical', minHeight: 480 }}
          placeholder={l === 'en'
            ? '# Document title\n\nWrite content in Markdown...'
            : `# ${LANG_LABELS[l]} title\n\n${LANG_LABELS[l]} content in Markdown...`}
        />
      </div>
    ),
  }))

  /* ─────────────────────────────────────────────────────────────────────────
     Top-down layout:
       Row 1 — toolbar (category filter + new button + reload)
       Row 2 — document card grid  [shown when no doc selected]
             OR document viewer/editor  [shown when doc selected]
  ───────────────────────────────────────────────────────────────────────── */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 0 16px', borderBottom: '1px solid #f0f0f0', marginBottom: 16,
      }}>
        {selectedDoc && (
          <Button
            icon={<LeftOutlined />}
            type="text"
            onClick={() => { setSelectedDoc(null); setEditing(false) }}
          >
            {t('docs_back', 'Back')}
          </Button>
        )}
        {!selectedDoc && (
          <>
            <Tabs
              activeKey={selectedCat}
              onChange={k => setSelectedCat(k)}
              items={catTabs}
              style={{ flex: 1, marginBottom: 0 }}
              tabBarStyle={{ marginBottom: 0 }}
            />
            <Space>
              <Tooltip title={t('docs_reload', 'Reload')}>
                <Button icon={<ReloadOutlined />} onClick={fetchDocs} />
              </Tooltip>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsNewModal(true)}>
                {t('docs_new', 'New Document')}
              </Button>
            </Space>
          </>
        )}
        {selectedDoc && !editing && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong style={{ fontSize: 15 }}>{localTitle(selectedDoc, lang)}</Text>
            {selectedDoc.version && <Tag>v{selectedDoc.version}</Tag>}
            <Tag color={CATEGORY_COLORS[selectedDoc.category] || 'default'}>
              {categories.find(c => c.key === selectedDoc.category)?.label || selectedDoc.category}
            </Tag>
            {isFallback(selectedDoc, lang) && (
              <Tag color="orange" style={{ fontSize: 10 }}>EN fallback</Tag>
            )}
            <div style={{ flex: 1 }} />
            <Button icon={<EditOutlined />} onClick={handleEdit}>
              {t('common_edit', 'Edit')}
            </Button>
          </div>
        )}
        {selectedDoc && editing && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong>{t('docs_editing', 'Editing')}:</Text>
            <Text>{editFields.en.title || localTitle(selectedDoc, lang)}</Text>
            <Input
              value={editVersion}
              onChange={e => setEditVersion(e.target.value)}
              style={{ width: 100 }}
              placeholder="v1.0"
              prefix={<Text type="secondary" style={{ fontSize: 11 }}>ver</Text>}
            />
            <div style={{ flex: 1 }} />
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              {t('common_save', 'Save')}
            </Button>
            <Button icon={<CloseOutlined />} onClick={() => setEditing(false)}>
              {t('common_cancel', 'Cancel')}
            </Button>
          </div>
        )}
      </div>

      {/* ── Content area ── */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {/* Document grid (no selection) */}
        {!selectedDoc && (
          loading ? (
            <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
          ) : filteredDocs.length === 0 ? (
            <Empty description={t('docs_empty', 'No documents')} style={{ marginTop: 60 }} />
          ) : (
            <Row gutter={[16, 16]}>
              {filteredDocs.map(doc => (
                <Col key={doc.id} xs={24} sm={12} md={8} lg={6}>
                  <Card
                    hoverable
                    onClick={() => setSelectedDoc(doc)}
                    size="small"
                    style={{ height: '100%' }}
                    styles={{ body: { padding: '12px 16px' } }}
                    actions={[
                      <Popconfirm
                        key="del"
                        title={t('docs_delete_confirm', 'Delete this document?')}
                        onConfirm={e => { e?.stopPropagation(); handleDelete(doc) }}
                        onCancel={e => e?.stopPropagation()}
                        okText={t('common_delete', 'Delete')}
                        okButtonProps={{ danger: true }}
                        cancelText={t('common_cancel', 'Cancel')}
                      >
                        <DeleteOutlined
                          style={{ color: '#ff4d4f' }}
                          onClick={e => e.stopPropagation()}
                        />
                      </Popconfirm>,
                    ]}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <FileTextOutlined style={{ fontSize: 22, color: '#1677ff', marginTop: 2, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, lineHeight: 1.4 }}>
                          {localTitle(doc, lang)}
                        </div>
                        <Space size={4} wrap>
                          <Tag color={CATEGORY_COLORS[doc.category] || 'default'} style={{ fontSize: 10, padding: '0 4px', margin: 0 }}>
                            {categories.find(c => c.key === doc.category)?.label || doc.category}
                          </Tag>
                          {doc.version && <Tag style={{ fontSize: 10, padding: '0 4px', margin: 0 }}>v{doc.version}</Tag>}
                          {doc.title_zh && <Tag style={{ fontSize: 9, padding: '0 3px', margin: 0 }} color="default">ZH</Tag>}
                          {doc.title_ja && <Tag style={{ fontSize: 9, padding: '0 3px', margin: 0 }} color="default">JA</Tag>}
                        </Space>
                        <div style={{ marginTop: 6, fontSize: 11, color: '#8c8c8c' }}>
                          {new Date(doc.updated_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
          )
        )}

        {/* Document viewer */}
        {selectedDoc && !editing && (
          <div style={{ maxWidth: 860 }}>
            <div className="markdown-body" style={{ fontSize: 14, lineHeight: 1.8 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {localContent(selectedDoc, lang)}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* Document editor */}
        {selectedDoc && editing && (
          <Tabs
            activeKey={editLang}
            onChange={k => setEditLang(k as 'en' | 'zh' | 'ja')}
            items={langTabItems}
          />
        )}
      </div>

      {/* ── New Document Modal ── */}
      <Modal
        title={t('docs_new_title', 'New Document')}
        open={isNewModal}
        onCancel={() => { setIsNewModal(false); newForm.resetFields() }}
        footer={null}
        width={420}
      >
        <Form form={newForm} layout="vertical" onFinish={handleCreate} style={{ marginTop: 8 }}>
          <Form.Item
            label={t('docs_category', 'Category')}
            name="category"
            rules={[{ required: true, message: t('docs_category_required', 'Please select a category') }]}
          >
            <Select placeholder={t('docs_category_placeholder', 'Select category')}>
              {categories.map(c => (
                <Select.Option key={c.key} value={c.key}>
                  <Tag color={CATEGORY_COLORS[c.key] || 'default'} style={{ marginRight: 6 }}>{c.label}</Tag>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label={t('docs_doc_title', 'Title (English)')}
            name="title"
            rules={[{ required: true, message: t('docs_title_required', 'Please enter a title') }]}
          >
            <Input placeholder={t('docs_title_placeholder', 'Document title')} />
          </Form.Item>
          <Form.Item label={t('docs_version', 'Version')} name="version">
            <Input placeholder="1.0.0" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Space>
              <Button type="primary" htmlType="submit">{t('docs_create_btn', 'Create')}</Button>
              <Button onClick={() => { setIsNewModal(false); newForm.resetFields() }}>
                {t('common_cancel', 'Cancel')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default DocumentCenterPage
