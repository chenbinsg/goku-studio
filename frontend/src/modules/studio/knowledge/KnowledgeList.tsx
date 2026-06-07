import React, { useEffect, useState } from 'react'
import {
  Card,
  Table,
  Button,
  Space,
  Input,
  Tag,
  Modal,
  Form,
  message,
  Typography,
  Popconfirm,
  Upload,
  Tabs,
  List,
  Slider,
  Statistic,
  Row,
  Col,
  Tooltip,
  Badge,
  Spin,
  Progress,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  SearchOutlined,
  InboxOutlined,
  BookOutlined,
  FileTextOutlined,
  DatabaseOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { UploadFile, UploadProps } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import { knowledgeApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input
const { Dragger } = Upload

const ACCEPTED_TYPES = '.pdf,.docx,.txt,.md'
const PAGE_SIZE = 20

type DocRow = {
  id: string
  title: string
  source?: string
  tags?: string[]
  content_preview?: string
  char_count?: number
  chunk_count?: number
  created_at?: string
}

type SearchResult = {
  id: string
  title: string
  source?: string
  tags?: string[]
  content: string
  similarity: number
  is_chunk: boolean
  chunk_index?: number
}

const KnowledgeList: React.FC = () => {
  const { t } = useTranslation()

  // ── List state ──────────────────────────────────────────────────────────────
  const [docs, setDocs] = useState<DocRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [form] = Form.useForm()

  // ── Search state ────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTopK, setSearchTopK] = useState(5)
  const [minSimilarity, setMinSimilarity] = useState(0.0)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)

  // ── Stats ───────────────────────────────────────────────────────────────────
  const totalChars = docs.reduce((s, d) => s + (d.char_count || 0), 0)
  const totalChunks = docs.reduce((s, d) => s + (d.chunk_count || 0), 0)

  useEffect(() => {
    fetchDocs()
  }, [page, search])

  const fetchDocs = async () => {
    setLoading(true)
    try {
      const res = await knowledgeApi.list({ page, size: PAGE_SIZE, search: search || undefined })
      setDocs(res.items || [])
      setTotal(res.total || 0)
    } catch {
      message.error(t('knowledge_list_fetch_failure', 'Failed to load knowledge base'))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async (values: any) => {
    setSubmitting(true)
    try {
      if (fileList.length > 0) {
        const file = fileList[0]
        const key = 'upload-progress'
        message.loading({ content: `正在上传并解析文档，请稍候…`, key, duration: 0 })
        const blob = (file.originFileObj ?? file) as Blob
        const formData = new FormData()
        formData.append('file', blob, file.name)
        if (values.title) formData.append('title', values.title)
        if (values.source) formData.append('source', values.source)
        if (values.tags) formData.append('tags', values.tags)
        const res = await knowledgeApi.upload(formData)
        message.success({
          content: `"${res.title}" uploaded — ${res.characters.toLocaleString()} chars, ${res.chunks} chunks`,
          key,
          duration: 4,
        })
      } else {
        const tags = values.tags
          ? values.tags.split(',').map((tg: string) => tg.trim()).filter(Boolean)
          : []
        const res = await knowledgeApi.create({ ...values, tags })
        message.success(`"${res.title}" saved — ${res.chunks} chunks indexed`)
      }
      closeModal()
      fetchDocs()
    } catch (err: any) {
      const rawDetail = err?.response?.data?.detail
      const detail = typeof rawDetail === 'string' ? rawDetail : t('knowledge_list_upload_failure', 'Upload failed')
      message.error({ content: detail, key: 'upload-progress', duration: 5 })
    } finally {
      setSubmitting(false)
    }
  }

  const closeModal = () => {
    setModalOpen(false)
    setFileList([])
    form.resetFields()
  }

  const handleDelete = async (id: string) => {
    try {
      await knowledgeApi.delete(id)
      message.success('Document deleted')
      const next = docs.length === 1 && page > 1 ? page - 1 : page
      if (docs.length === 1 && page > 1) setPage(next)
      else fetchDocs()
    } catch {
      message.error('Delete failed')
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)
    setSearchDone(false)
    try {
      const res = await knowledgeApi.search({
        query: searchQuery.trim(),
        top_k: searchTopK,
        min_similarity: minSimilarity,
      })
      setSearchResults(res.results || [])
      setSearchDone(true)
    } catch {
      message.error('Search failed')
    } finally {
      setSearching(false)
    }
  }

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: ACCEPTED_TYPES,
    fileList,
    beforeUpload: (file) => { setFileList([file as unknown as UploadFile]); return false },
    onRemove: () => setFileList([]),
  }

  const hasFile = fileList.length > 0

  const columns: ColumnsType<DocRow> = [
    {
      title: t('knowledge_list_document_name_column', 'Title'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string) => (
        <Space>
          <FileTextOutlined style={{ color: '#1677ff' }} />
          <Text strong>{text}</Text>
        </Space>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      ellipsis: true,
      width: 160,
      render: (v?: string) => v
        ? <Tooltip title={v}><Text type="secondary" style={{ fontSize: 12 }}>{v.length > 30 ? v.slice(0, 30) + '…' : v}</Text></Tooltip>
        : null,
    },
    {
      title: 'Tags',
      dataIndex: 'tags',
      key: 'tags',
      width: 180,
      render: (tags: string[] = []) => (
        <Space size={[4, 4]} wrap>
          {tags.map(tg => <Tag key={tg}>{tg}</Tag>)}
        </Space>
      ),
    },
    {
      title: 'Size',
      key: 'size',
      width: 120,
      render: (_: any, rec: DocRow) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}>{(rec.char_count || 0).toLocaleString()} chars</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{rec.chunk_count || 0} chunks</Text>
        </Space>
      ),
    },
    {
      title: t('knowledge_list_created_at_column', 'Created'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => v ? dayjs(v).format('MM-DD HH:mm') : '-',
      width: 110,
    },
    {
      title: 'Action',
      key: 'action',
      width: 70,
      fixed: 'right',
      render: (_: any, record: DocRow) => (
        <Popconfirm
          title="Delete this document and all its chunks?"
          onConfirm={() => handleDelete(record.id)}
          okButtonProps={{ danger: true }}
        >
          <Button type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <Title level={2}><BookOutlined /> {t('knowledge_list_title', 'Knowledge Base')}</Title>

      {/* Stats strip */}
      {docs.length > 0 && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="Documents" value={total} prefix={<FileTextOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic title="Total Chunks" value={totalChunks} prefix={<DatabaseOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small">
              <Statistic
                title="Total Characters"
                value={totalChars}
                formatter={(v) => Number(v).toLocaleString()}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Tabs
        defaultActiveKey="docs"
        items={[
          {
            key: 'docs',
            label: <span><FileTextOutlined /> Documents</span>,
            children: (
              <Card>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Input
                    prefix={<SearchOutlined />}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                    allowClear
                    placeholder="Filter by title or content…"
                    style={{ width: 300 }}
                  />
                  <Button icon={<ReloadOutlined />} onClick={fetchDocs} />
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
                    {t('knowledge_list_upload_button', 'Add Document')}
                  </Button>
                </Space>
                <Table
                  columns={columns}
                  dataSource={docs}
                  rowKey="id"
                  loading={loading}
                  size="small"
                  scroll={{ x: 900 }}
                  pagination={{
                    current: page,
                    total,
                    pageSize: PAGE_SIZE,
                    showSizeChanger: false,
                    onChange: setPage,
                    showTotal: (n) => `${n} documents`,
                  }}
                />
              </Card>
            ),
          },
          {
            key: 'search',
            label: <span><SearchOutlined /> Semantic Search</span>,
            children: (
              <Card>
                <Space direction="vertical" style={{ width: '100%' }} size={16}>
                  {/* Query bar */}
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      size="large"
                      placeholder="Ask anything — semantic RAG search over your knowledge base…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onPressEnter={handleSearch}
                      prefix={<SearchOutlined />}
                    />
                    <Button size="large" type="primary" onClick={handleSearch} loading={searching}>
                      Search
                    </Button>
                  </Space.Compact>

                  {/* Controls */}
                  <Space wrap>
                    <Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>Top-K:</Text>
                      <Slider
                        min={1} max={20} step={1}
                        value={searchTopK}
                        onChange={setSearchTopK}
                        style={{ width: 120 }}
                        tooltip={{ formatter: (v) => `${v} results` }}
                      />
                      <Badge count={searchTopK} showZero color="#1677ff" />
                    </Space>
                    <Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>Min similarity:</Text>
                      <Slider
                        min={0} max={0.95} step={0.05}
                        value={minSimilarity}
                        onChange={setMinSimilarity}
                        style={{ width: 120 }}
                        tooltip={{ formatter: (v) => `${((v || 0) * 100).toFixed(0)}%` }}
                      />
                      <Text style={{ fontSize: 12, minWidth: 36 }}>{(minSimilarity * 100).toFixed(0)}%</Text>
                    </Space>
                  </Space>

                  {/* Results */}
                  <Spin spinning={searching}>
                    {searchDone && searchResults.length === 0 && (
                      <div style={{ textAlign: 'center', padding: '40px 0', color: '#aaa' }}>
                        <SearchOutlined style={{ fontSize: 36, marginBottom: 12 }} />
                        <div>No results above the similarity threshold. Try lowering Min similarity or rewording your query.</div>
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <List
                        itemLayout="vertical"
                        dataSource={searchResults}
                        renderItem={(item: SearchResult, idx) => (
                          <List.Item key={item.id}>
                            <Card
                              size="small"
                              title={
                                <Space>
                                  <Tag color="blue" style={{ fontWeight: 600 }}>#{idx + 1}</Tag>
                                  <Text strong>{item.title}</Text>
                                  {item.is_chunk && (
                                    <Tag color="default" style={{ fontSize: 11 }}>
                                      chunk {(item.chunk_index ?? 0) + 1}
                                    </Tag>
                                  )}
                                </Space>
                              }
                              extra={
                                <Space>
                                  {item.source && (
                                    <Tooltip title={item.source}>
                                      <Text type="secondary" style={{ fontSize: 11 }}>
                                        {item.source.length > 40 ? item.source.slice(0, 40) + '…' : item.source}
                                      </Text>
                                    </Tooltip>
                                  )}
                                  <Tooltip title={`Similarity: ${(item.similarity * 100).toFixed(1)}%`}>
                                    <Progress
                                      type="circle"
                                      size={36}
                                      percent={Math.round(item.similarity * 100)}
                                      strokeColor={
                                        item.similarity >= 0.85 ? '#52c41a'
                                        : item.similarity >= 0.70 ? '#faad14'
                                        : '#ff4d4f'
                                      }
                                      format={(p) => <span style={{ fontSize: 10 }}>{p}%</span>}
                                    />
                                  </Tooltip>
                                </Space>
                              }
                            >
                              <Paragraph
                                style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 13, marginBottom: 8 }}
                                ellipsis={{ rows: 6, expandable: true }}
                              >
                                {item.content}
                              </Paragraph>
                              <Space size={[4, 4]} wrap>
                                {(item.tags || []).map((tg: string) => (
                                  <Tag key={tg} bordered={false}>{tg}</Tag>
                                ))}
                              </Space>
                            </Card>
                          </List.Item>
                        )}
                      />
                    )}
                  </Spin>
                </Space>
              </Card>
            ),
          },
        ]}
      />

      {/* Upload / Create modal */}
      <Modal
        title={t('knowledge_list_upload_button', 'Add Document')}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okButtonProps={{ loading: submitting }}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item label="File (PDF / DOCX / TXT / MD)">
            <Dragger {...uploadProps}>
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">Click or drag a file to upload</p>
              <p className="ant-upload-hint">Supports PDF, DOCX, TXT, Markdown — max 20 MB</p>
            </Dragger>
          </Form.Item>

          <Form.Item name="title" label="Title" rules={[{ required: !hasFile }]}>
            <Input placeholder={hasFile ? 'Optional — defaults to filename' : 'Required'} />
          </Form.Item>

          {!hasFile && (
            <Form.Item name="content" label="Content" rules={[{ required: true }]}>
              <TextArea
                rows={8}
                showCount
                maxLength={100000}
                placeholder="Paste your document content here…"
              />
            </Form.Item>
          )}

          <Form.Item name="source" label="Source URL / Reference">
            <Input placeholder="https://… or document name" />
          </Form.Item>
          <Form.Item name="tags" label="Tags" help="Comma-separated">
            <Input placeholder="product, faq, internal" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default KnowledgeList
