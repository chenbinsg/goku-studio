import React, { useEffect, useMemo, useState } from 'react'
import {
  Table,
  Card,
  Tag,
  Button,
  Space,
  Typography,
  Input,
  Form,
  Tabs,
  List,
  message,
  Select,
  Popconfirm,
  Tooltip,
  Statistic,
  Row,
  Col,
  Timeline,
  Badge,
  Spin,
} from 'antd'
import {
  DatabaseOutlined,
  SearchOutlined,
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  BulbOutlined,
  ThunderboltOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { memoryApi } from '@/api'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useTranslation } from 'react-i18next'

dayjs.extend(relativeTime)

const { Title, Text, Paragraph } = Typography
const { TextArea } = Input

// Domain tag → color
const DOMAIN_COLORS: Record<string, string> = {
  email:     '#1677ff',
  calendar:  '#52c41a',
  search:    '#fa8c16',
  code:      '#722ed1',
  files:     '#13c2c2',
  messaging: '#eb2f96',
  data:      '#faad14',
}

const DOMAIN_LABELS: Record<string, string> = {
  email:     'Email',
  calendar:  'Calendar',
  search:    'Search',
  code:      'Code',
  files:     'Files',
  messaging: 'Messaging',
  data:      'Data',
}

type MemoryRow = {
  id: string
  type: 'short' | 'long' | string
  content: string
  tags?: string[]
  ttl?: number | null
  created_at?: string
}

const PAGE_SIZE = 20

const MemoryList: React.FC = () => {
  const { t } = useTranslation()
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [form] = Form.useForm()

  // ── Timeline state ────────────────────────────────────────────────────────
  const [timelineItems, setTimelineItems] = useState<any[]>([])
  const [timelineTotal, setTimelineTotal] = useState(0)
  const [timelineDomainCounts, setTimelineDomainCounts] = useState<Record<string, number>>({})
  const [timelinePage, setTimelinePage] = useState(1)
  const [timelineDomain, setTimelineDomain] = useState<string | undefined>(undefined)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [consolidating, setConsolidating] = useState(false)

  useEffect(() => {
    fetchMemories(page, typeFilter)
  }, [page, typeFilter])

  useEffect(() => {
    fetchTimeline(timelinePage, timelineDomain)
  }, [timelinePage, timelineDomain])

  const fetchTimeline = async (nextPage = 1, domain?: string) => {
    setTimelineLoading(true)
    try {
      const res = await memoryApi.timeline({ page: nextPage, size: 30, domain })
      setTimelineItems(res.items || [])
      setTimelineTotal(res.total || 0)
      setTimelineDomainCounts(res.domain_counts || {})
    } catch {
      message.error('Failed to load memory timeline')
    } finally {
      setTimelineLoading(false)
    }
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const res = await memoryApi.consolidate()
      message.success(`Consolidation done: merged ${res.merged}, expired ${res.expired} (of ${res.checked} checked)`)
      fetchTimeline(1, timelineDomain)
    } catch {
      message.error('Consolidation failed')
    } finally {
      setConsolidating(false)
    }
  }

  const fetchMemories = async (nextPage = 1, nextType?: string) => {
    setLoading(true)
    try {
      const res = await memoryApi.list({ page: nextPage, size: PAGE_SIZE, type: nextType })
      setMemories(res.items || [])
      setTotal(res.total || 0)
    } catch (error) {
      message.error(t('memory_list_fetch_failure'))
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }
    setSearchLoading(true)
    try {
      const res = await memoryApi.search({
        query: searchQuery,
        top_k: 10,
        ...(typeFilter ? { type: typeFilter } : {}),
      })
      setSearchResults(res.results || [])
    } catch (error) {
      message.error(t('memory_list_search_failure'))
    } finally {
      setSearchLoading(false)
    }
  }

  const handleCreate = async (values: any) => {
    try {
      await memoryApi.create({
        type: values.type,
        content: values.content,
        tags: values.tags?.split(',').map((t: string) => t.trim()).filter(Boolean),
      })
      message.success(t('memory_list_search_button'))
      form.resetFields()
      fetchMemories(page, typeFilter)
    } catch (error) {
      message.error(t('memory_list_search_failure'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await memoryApi.delete(id)
      message.success(t('memory_list_title'))
      const shouldGoPrev = memories.length === 1 && page > 1
      const nextPage = shouldGoPrev ? page - 1 : page
      if (shouldGoPrev) {
        setPage(nextPage)
      } else {
        fetchMemories(nextPage, typeFilter)
      }
      if (searchResults.length) {
        handleSearch()
      }
    } catch (error) {
      message.error(t('memory_list_search_failure'))
    }
  }

  const columns: ColumnsType<MemoryRow> = useMemo(() => [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 160,
      render: (text: string) => (
        <Tooltip title={text}>
          <Text code>{text?.slice(0, 8)}...</Text>
        </Tooltip>
      ),
    },
    {
      title: t('memory_list_type_column'),
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type: string) => (
        <Tag color={type === 'long' ? 'blue' : 'green'}>
          {type === 'long' ? t('memory_list_long_term') : t('memory_list_short_term')}
        </Tag>
      ),
    },
    {
      title: t('memory_list_content_column'),
      dataIndex: 'content',
      key: 'content',
      ellipsis: true,
      render: (text: string) => (
        <Tooltip title={text}>
          <Text>{text?.length > 80 ? `${text.slice(0, 80)}...` : text}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('memory_list_tags_column'),
      dataIndex: 'tags',
      key: 'tags',
      width: 360,
      render: (tags: string[] = []) => (
        <Space size={[4, 6]} wrap>
          {tags.length ? tags.map(tag => <Tag key={tag}>{tag}</Tag>) : null}
        </Space>
      ),
    },
    {
      title: t('memory_list_created_at_column'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (time?: string) => time ? dayjs(time).format('MM-DD HH:mm') : '-',
    },
    {
      title: 'Action',
      key: 'actions',
      width: 88,
      fixed: 'right',
      render: (_, record) => (
        <Popconfirm
          title="Delete this memory?"
          onConfirm={() => handleDelete(record.id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [memories, page, searchResults, typeFilter, t])

  return (
    <div>
      <Title level={2}>
        <DatabaseOutlined /> {t('memory_list_title')}
      </Title>

      <Tabs
        defaultActiveKey="timeline"
        items={[
          {
            key: 'timeline',
            label: <span><BulbOutlined /> Experience Timeline</span>,
            children: (
              <div>
                {/* Stats row */}
                <Row gutter={12} style={{ marginBottom: 16 }}>
                  <Col xs={12} sm={6}>
                    <Card size="small">
                      <Statistic
                        title="Total Insights"
                        value={timelineTotal}
                        prefix={<BulbOutlined />}
                        valueStyle={{ color: '#1677ff' }}
                      />
                    </Card>
                  </Col>
                  {Object.entries(timelineDomainCounts).slice(0, 5).map(([domain, count]) => (
                    <Col xs={12} sm={6} key={domain}>
                      <Card size="small">
                        <Statistic
                          title={DOMAIN_LABELS[domain] || domain}
                          value={count}
                          valueStyle={{ color: DOMAIN_COLORS[domain] || '#666' }}
                        />
                      </Card>
                    </Col>
                  ))}
                </Row>

                {/* Controls */}
                <Space style={{ marginBottom: 16 }} wrap>
                  <Select
                    allowClear
                    placeholder="Filter by domain"
                    value={timelineDomain}
                    style={{ width: 160 }}
                    onChange={(v) => { setTimelineDomain(v); setTimelinePage(1) }}
                    options={Object.keys(DOMAIN_LABELS).map(d => ({
                      value: d,
                      label: <span><Badge color={DOMAIN_COLORS[d]} />&nbsp;{DOMAIN_LABELS[d]}</span>,
                    }))}
                  />
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={() => fetchTimeline(timelinePage, timelineDomain)}
                  >Refresh</Button>
                  <Button
                    icon={<ThunderboltOutlined />}
                    loading={consolidating}
                    onClick={handleConsolidate}
                  >Consolidate</Button>
                </Space>

                {/* Timeline */}
                <Spin spinning={timelineLoading}>
                  {timelineItems.length === 0 && !timelineLoading ? (
                    <Card>
                      <div style={{ textAlign: 'center', padding: '40px 0', color: '#aaa' }}>
                        <BulbOutlined style={{ fontSize: 40, marginBottom: 12 }} />
                        <div>No insights yet — complete a few tasks and they'll appear here.</div>
                      </div>
                    </Card>
                  ) : (
                    <Timeline
                      mode="left"
                      items={timelineItems.map((item) => {
                        const domainTag = (item.tags || []).find((t: string) => t.startsWith('domain:'))
                        const domain = domainTag?.slice(7)
                        const taskTag = (item.tags || []).find((t: string) => t.startsWith('task_'))
                        const toolTags = (item.tags || []).filter((t: string) => t.startsWith('tool:')).slice(0, 3)
                        return {
                          key: item.id,
                          color: domain ? DOMAIN_COLORS[domain] : '#1677ff',
                          label: (
                            <Tooltip title={dayjs(item.created_at).format('YYYY-MM-DD HH:mm:ss')}>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                <ClockCircleOutlined /> {dayjs(item.created_at).fromNow()}
                              </Text>
                            </Tooltip>
                          ),
                          children: (
                            <Card size="small" style={{ maxWidth: 600, marginBottom: 4 }}>
                              <Paragraph style={{ marginBottom: 8 }}>{item.content}</Paragraph>
                              <Space size={[4, 4]} wrap>
                                {domain && (
                                  <Tag color={DOMAIN_COLORS[domain] || 'default'}>
                                    {DOMAIN_LABELS[domain] || domain}
                                  </Tag>
                                )}
                                {taskTag && (
                                  <Tag color="default" style={{ fontFamily: 'monospace', fontSize: 11 }}>
                                    {taskTag}
                                  </Tag>
                                )}
                                {toolTags.map((t: string) => (
                                  <Tag key={t} bordered={false} color="processing" style={{ fontSize: 11 }}>
                                    {t.slice(5)}
                                  </Tag>
                                ))}
                              </Space>
                            </Card>
                          ),
                        }
                      })}
                    />
                  )}

                  {/* Pagination */}
                  {timelineTotal > 30 && (
                    <Space style={{ marginTop: 16, justifyContent: 'center', width: '100%' }}>
                      <Button
                        disabled={timelinePage <= 1}
                        onClick={() => setTimelinePage(p => p - 1)}
                      >Previous</Button>
                      <Text type="secondary">Page {timelinePage} of {Math.ceil(timelineTotal / 30)}</Text>
                      <Button
                        disabled={timelinePage >= Math.ceil(timelineTotal / 30)}
                        onClick={() => setTimelinePage(p => p + 1)}
                      >Next</Button>
                    </Space>
                  )}
                </Spin>
              </div>
            ),
          },
          {
            key: 'list',
            label: 'List',
            children: (
              <Card
                extra={
                  <Space wrap>
                    <Select
                      allowClear
                      value={typeFilter}
                      style={{ width: 120 }}
                      onChange={(value) => {
                        setPage(1)
                        setTypeFilter(value)
                      }}
                      options={[
                        { value: 'long', label: t('memory_list_long_term') },
                        { value: 'short', label: t('memory_list_short_term') },
                      ]}
                    />
                    <Button icon={<ReloadOutlined />} onClick={() => fetchMemories(page, typeFilter)} />
                  </Space>
                }
              >
                <Table
                  columns={columns}
                  dataSource={memories}
                  rowKey="id"
                  loading={loading}
                  size="small"
                  scroll={{ x: 1100 }}
                  pagination={{
                    current: page,
                    pageSize: PAGE_SIZE,
                    total,
                    showSizeChanger: false,
                    onChange: (nextPage) => setPage(nextPage),
                  }}
                />
              </Card>
            ),
          },
          {
            key: 'search',
            label: 'Search',
            children: (
              <Card>
                <Space style={{ marginBottom: 16 }} wrap>
                  <Input
                    placeholder={t('memory_list_search_placeholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onPressEnter={handleSearch}
                    style={{ width: 420 }}
                    prefix={<SearchOutlined />}
                  />
                  <Select
                    allowClear
                    value={typeFilter}
                    style={{ width: 120 }}
                    onChange={setTypeFilter}
                    options={[
                      { value: 'long', label: t('memory_list_long_term') },
                      { value: 'short', label: t('memory_list_short_term') },
                    ]}
                  />
                  <Button type="primary" onClick={handleSearch} loading={searchLoading}>
                    {t('memory_list_search_button')}
                  </Button>
                </Space>

                <List
                  dataSource={searchResults}
                  locale={{ emptyText: t('memory_list_no_results') }}
                  renderItem={(item: any) => (
                    <List.Item>
                      <Card style={{ width: '100%' }} size="small">
                        <Space direction="vertical" style={{ width: '100%' }} size={8}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                            <Text>{item.content}</Text>
                            <Tag color="blue">{(item.similarity * 100).toFixed(1)}%</Tag>
                          </div>
                          <Space size={[4, 6]} wrap>
                            {item.tags?.map((tag: string) => <Tag key={tag}>{tag}</Tag>)}
                          </Space>
                        </Space>
                      </Card>
                    </List.Item>
                  )}
                />
              </Card>
            ),
          },
          {
            key: 'create',
            label: 'Create',
            children: (
              <Card style={{ maxWidth: 680 }}>
                <Form form={form} layout="vertical" onFinish={handleCreate} initialValues={{ type: 'long' }}>
                  <Form.Item name="type" label={t('memory_list_type_column')}>
                    <Select
                      options={[
                        { value: 'long', label: t('memory_list_long_term') },
                        { value: 'short', label: t('memory_list_short_term') },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item name="content" label={t('memory_list_content_column')} rules={[{ required: true }]}>
                    <TextArea rows={5} showCount maxLength={2000} />
                  </Form.Item>
                  <Form.Item name="tags" label={t('memory_list_tags_column')}>
                    <Input />
                  </Form.Item>
                  <Form.Item>
                    <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                      {t('memory_list_title')}
                    </Button>
                  </Form.Item>
                </Form>
              </Card>
            ),
          },
        ]}
      />
    </div>
  )
}

export default MemoryList
