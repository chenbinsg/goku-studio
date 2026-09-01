import React, { useEffect, useState, useCallback } from 'react'
import {
  Table,
  Card,
  Typography,
  Button,
  Tag,
  Input,
  Space,
  Modal,
  Form,
  message,
  Popconfirm,
  Badge,
  Tooltip,
  Descriptions,
  Empty,
  Select,
} from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  EyeOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { autoSkillApi } from '@/api'
import { useTranslation } from 'react-i18next'

const { Title, Text } = Typography
const { TextArea } = Input

interface Skill {
  id: string
  name: string
  description: string
  trigger_pattern: string
  steps_template: any[]
  tools_used: string[]
  use_count: number
  workflow_md?: string
  avg_success_rate: number
  avg_speedup: number | null
  approval_status: 'pending' | 'approved' | 'rejected'
  created_at: string
  updated_at: string
  source_task_id?: string
  /** Set once this candidate has been 入库'd — the row it became in the library. */
  promoted_skill?: { id: string; code: string; status: string } | null
}

interface SkillListProps {
  /** Rendered inside the Skill 管理 tabs — the page already has a title and
   *  padding, so suppress this component's own. */
  embedded?: boolean
}

const SkillList: React.FC<SkillListProps> = ({ embedded = false }) => {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<Skill[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [bulkDeleting, setBulkDeleting] = useState(false)

  // Detail modal
  const [detailModal, setDetailModal] = useState<Skill | null>(null)

  // 入库 dialog — the one crossing between the two pools
  const [promoteOf, setPromoteOf] = useState<any | null>(null)
  const [promoteForm] = Form.useForm()
  const [promoting, setPromoting] = useState(false)

  // Edit modal
  const [editModal, setEditModal] = useState<Skill | null>(null)
  const [editForm] = Form.useForm()
  const [editLoading, setEditLoading] = useState(false)

  const fetchSkills = useCallback(async () => {
    setLoading(true)
    try {
      const res = await autoSkillApi.list({
        page,
        size: pageSize,
        approval_status: statusFilter || undefined,
      })
      setSkills(res.items || [])
      setTotal(res.total || 0)
    } catch {
      message.error(t('skill_list_fetch_failure', 'Failed to load skills'))
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, statusFilter, t])

  useEffect(() => {
    fetchSkills()
  }, [fetchSkills])

  /**
   * Open the 入库 dialog. The candidate itself stays read-only — it is the
   * record of what the extractor produced. The dialog only picks the handle and
   * category; the text is polished afterwards, in the Skill 库.
   */
  const openPromote = async (row: any) => {
    try {
      const full = await autoSkillApi.get(row.id)
      setPromoteOf(full)
      promoteForm.setFieldsValue({ code: full.suggested_code, category: undefined })
    } catch {
      message.error(t('skill_promote_load_failed', '读取候选失败'))
    }
  }

  const doPromote = async () => {
    let values: any
    try { values = await promoteForm.validateFields() } catch { return }
    setPromoting(true)
    try {
      const res = await autoSkillApi.promote(promoteOf.id, values)
      message.success(res.note || t('skill_promote_done', '已入库'))
      setPromoteOf(null)
      fetchSkills()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_promote_failed', '入库失败'))
    } finally {
      setPromoting(false)
    }
  }

  const handleApprove = async (id: string) => {
    try {
      await autoSkillApi.approve(id)
      message.success(t('skill_list_approve_success', 'Skill approved'))
      fetchSkills()
    } catch {
      message.error(t('skill_list_approve_failure', 'Failed to approve skill'))
    }
  }

  const handleReject = async (id: string) => {
    try {
      await autoSkillApi.update(id, { approval_status: 'rejected' })
      message.success(t('skill_list_reject_success', 'Skill rejected'))
      fetchSkills()
    } catch {
      message.error(t('skill_list_reject_failure', 'Failed to reject skill'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await autoSkillApi.delete(id)
      message.success(t('skill_list_delete_success', 'Skill deleted'))
      fetchSkills()
    } catch {
      message.error(t('skill_list_delete_failure', 'Failed to delete skill'))
    }
  }

  // Bulk delete: by explicit ids (selected rows / current page) or all (filtered)
  const runBulkDelete = async (
    body: { ids?: string[]; approval_status?: string; all?: boolean },
  ) => {
    setBulkDeleting(true)
    try {
      const res = await autoSkillApi.bulkDelete(body)
      message.success(t('skill_bulk_deleted', { count: res.deleted, defaultValue: `Deleted ${res.deleted} skills` }))
      setSelectedRowKeys([])
      // After deleting, the current page may be empty — clamp back if needed
      const remaining = total - (res.deleted || 0)
      const lastPage = Math.max(1, Math.ceil(remaining / pageSize))
      if (page > lastPage) {
        setPage(lastPage)
      } else {
        fetchSkills()
      }
    } catch {
      message.error(t('skill_bulk_delete_failure', 'Bulk delete failed'))
    } finally {
      setBulkDeleting(false)
    }
  }

  const handleDeleteSelected = () =>
    runBulkDelete({ ids: selectedRowKeys.map(String) })

  const handleDeletePage = () =>
    runBulkDelete({ ids: skills.map(s => s.id) })

  const handleDeleteAll = () =>
    runBulkDelete({ all: true, ...(statusFilter ? { approval_status: statusFilter } : {}) })

  const openEdit = (skill: Skill) => {
    setEditModal(skill)
    editForm.setFieldsValue({
      name: skill.name,
      description: skill.description,
      trigger_pattern: skill.trigger_pattern,
    })
  }

  const handleEditSave = async () => {
    try {
      const values = await editForm.validateFields()
      setEditLoading(true)
      await autoSkillApi.update(editModal!.id, values)
      message.success(t('skill_list_edit_success', 'Skill updated'))
      setEditModal(null)
      fetchSkills()
    } catch (err: any) {
      if (err?.errorFields) return // validation error, don't close
      message.error(t('skill_list_edit_failure', 'Failed to update skill'))
    } finally {
      setEditLoading(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      fetchSkills()
      return
    }
    setLoading(true)
    try {
      const res = await autoSkillApi.search({ query: searchQuery, top_k: 20 })
      setSkills(res.items || [])
      setTotal((res.items || []).length)
    } catch {
      message.error(t('skill_list_search_failure', 'Search failed'))
    } finally {
      setLoading(false)
    }
  }

  const statusTag = (status: string) => {
    switch (status) {
      case 'approved':
        return <Tag icon={<CheckCircleOutlined />} color="success">{t('skill_status_approved', 'Approved')}</Tag>
      case 'rejected':
        return <Tag icon={<CloseCircleOutlined />} color="error">{t('skill_status_rejected', 'Rejected')}</Tag>
      default:
        return <Tag color="warning">{t('skill_status_pending', 'Pending')}</Tag>
    }
  }

  const columns = [
    {
      title: t('skill_col_name', 'Skill Name'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string, record: Skill) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ fontSize: 13 }}>{name}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {record.trigger_pattern?.slice(0, 50)}{record.trigger_pattern?.length > 50 ? '…' : ''}
          </Text>
        </Space>
      ),
    },
    {
      title: t('skill_col_description', 'Description'),
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
      render: (desc: string) => (
        <Tooltip title={desc}>
          <Text style={{ fontSize: 12 }}>{desc}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('skill_col_tools', 'Tools Used'),
      dataIndex: 'tools_used',
      key: 'tools_used',
      width: 200,
      render: (tools: string[]) => (
        <Space wrap size={[4, 4]}>
          {(tools || []).slice(0, 4).map(t => (
            <Tag key={t} style={{ fontSize: 11 }}>{t}</Tag>
          ))}
          {tools?.length > 4 && <Tag>+{tools.length - 4}</Tag>}
        </Space>
      ),
    },
    {
      title: t('skill_col_usage', 'Usage'),
      key: 'usage',
      width: 100,
      align: 'center' as const,
      render: (_: any, record: Skill) => (
        <Space direction="vertical" size={0} style={{ textAlign: 'center' }}>
          <Badge count={record.use_count} showZero style={{ backgroundColor: '#1677ff' }} />
          {record.avg_success_rate > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {(record.avg_success_rate * 100).toFixed(0)}% ✓
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: t('skill_speedup_col'),
      dataIndex: 'avg_speedup',
      key: 'avg_speedup',
      width: 90,
      align: 'center' as const,
      sorter: (a: any, b: any) => (a.avg_speedup ?? 0) - (b.avg_speedup ?? 0),
      render: (v: number | null) => {
        if (!v) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
        const color = v >= 1.3 ? 'green' : v >= 1.1 ? 'blue' : 'default'
        return <Tag color={color}>{v.toFixed(1)}×</Tag>
      },
    },
    {
      title: t('skill_col_status', 'Status'),
      dataIndex: 'approval_status',
      key: 'approval_status',
      width: 110,
      render: (status: string) => statusTag(status),
    },
    {
      title: t('skill_col_actions', 'Actions'),
      key: 'actions',
      width: 200,
      render: (_: any, record: Skill) => (
        <Space>
          <Tooltip title={t('skill_action_view', 'View Details')}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => setDetailModal(record)}
            />
          </Tooltip>
          {/* No edit button. A candidate is the record of what the extractor
              produced and stays as-is; content is polished after 入库, in the
              正式Skill library, where the change lands in a version history. */}
          {(record.approval_status === 'pending' || record.approval_status === 'rejected')
            && !record.promoted_skill && (
            <>
              <Tooltip title={t('skill_action_promote', '入库 —— 复制进正式Skill,默认停用')}>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  onClick={() => openPromote(record)}
                />
              </Tooltip>
              <Tooltip title={t('skill_action_reject', 'Reject')}>
                <Button
                  size="small"
                  danger
                  icon={<CloseCircleOutlined />}
                  onClick={() => handleReject(record.id)}
                />
              </Tooltip>
            </>
          )}
          {record.promoted_skill && (
            <Tooltip title={t('skill_action_view_promoted',
              `已入库为 ${record.promoted_skill.code},点击查看`)}>
              <Button
                size="small"
                type="link"
                onClick={() => window.open('/skills', '_self')}
              >
                {t('skill_promoted_link', '已入库')}
              </Button>
            </Tooltip>
          )}
          <Popconfirm
            title={t('skill_delete_confirm', 'Delete this skill?')}
            onConfirm={() => handleDelete(record.id)}
            okText={t('confirm_yes', 'Yes')}
            cancelText={t('confirm_no', 'No')}
          >
            <Tooltip title={t('skill_action_delete', 'Delete')}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: embedded ? 0 : 24 }}>
      {!embedded && (
        <Space style={{ marginBottom: 16 }} align="center">
          <ThunderboltOutlined style={{ fontSize: 24, color: '#1677ff' }} />
          <Title level={3} style={{ margin: 0 }}>
            {t('skill_list_title', 'Auto Skills')}
          </Title>
        </Space>
      )}

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder={t('skill_search_placeholder', 'Search skills by name or description…')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 320 }}
            prefix={<SearchOutlined />}
            allowClear
            onClear={() => { setSearchQuery(''); fetchSkills() }}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
            {t('skill_btn_search', 'Search')}
          </Button>
          <Select
            style={{ width: 140 }}
            value={statusFilter}
            onChange={v => { setStatusFilter(v); setPage(1); setSelectedRowKeys([]) }}
            options={[
              { value: '', label: t('skill_filter_all', 'All Status') },
              { value: 'pending', label: t('skill_status_pending', 'Pending') },
              { value: 'approved', label: t('skill_status_approved', 'Approved') },
              { value: 'rejected', label: t('skill_status_rejected', 'Rejected') },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchSkills}>
            {t('skill_btn_refresh', 'Refresh')}
          </Button>
          <Popconfirm
            title={t('skill_delete_selected_confirm', { count: selectedRowKeys.length, defaultValue: `Delete ${selectedRowKeys.length} selected skills?` })}
            disabled={!selectedRowKeys.length || bulkDeleting}
            onConfirm={handleDeleteSelected}
            okText={t('confirm_yes', 'Yes')}
            cancelText={t('confirm_no', 'No')}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length} loading={bulkDeleting}>
              {t('skill_delete_selected', { count: selectedRowKeys.length, defaultValue: `Delete Selected (${selectedRowKeys.length})` })}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('skill_delete_page_confirm', { count: skills.length, defaultValue: `Delete all ${skills.length} skills on this page?` })}
            disabled={!skills.length || bulkDeleting}
            onConfirm={handleDeletePage}
            okText={t('confirm_yes', 'Yes')}
            cancelText={t('confirm_no', 'No')}
          >
            <Button disabled={!skills.length} loading={bulkDeleting}>
              {t('skill_delete_page', 'Delete Page')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('skill_delete_all_confirm', { count: total, defaultValue: `Delete ALL ${total} skills matching the current filter? This cannot be undone.` })}
            okText={t('skill_delete_all_ok', 'Delete all')}
            okButtonProps={{ danger: true }}
            disabled={!total || bulkDeleting}
            onConfirm={handleDeleteAll}
            cancelText={t('confirm_no', 'No')}
          >
            <Button danger disabled={!total} loading={bulkDeleting}>
              {t('skill_delete_all', 'Delete All')}
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={skills}
          loading={loading}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            preserveSelectedRowKeys: true,
          }}
          locale={{ emptyText: <Empty description={t('skill_list_empty', 'No skills yet — they are auto-learned from completed tasks')} /> }}
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: p => setPage(p),
            showTotal: (tot) => t('skill_pagination_total', `Total ${tot} skills`, { total: tot }),
          }}
        />
      </Card>

      {/* Detail Modal */}
      <Modal
        title={
          <Space>
            <ThunderboltOutlined />
            {detailModal?.name}
            {detailModal && statusTag(detailModal.approval_status)}
          </Space>
        }
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={[
          <Button key="close" onClick={() => setDetailModal(null)}>
            {t('modal_close', 'Close')}
          </Button>,
        ]}
        width={700}
      >
        {detailModal && (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label={t('skill_detail_name', 'Name')} span={2}>
                {detailModal.name}
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_description', 'Description')} span={2}>
                {detailModal.description}
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_trigger', 'Trigger Pattern')} span={2}>
                <Text code>{detailModal.trigger_pattern}</Text>
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_tools', 'Tools Used')}>
                <Space wrap>
                  {(detailModal.tools_used || []).map(t => <Tag key={t}>{t}</Tag>)}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_usage', 'Usage Count')}>
                <Badge count={detailModal.use_count} showZero style={{ backgroundColor: '#1677ff' }} />
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_success_rate', 'Success Rate')}>
                {detailModal.avg_success_rate > 0
                  ? `${(detailModal.avg_success_rate * 100).toFixed(1)}%`
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_speedup', '加速比')}>
                {detailModal.avg_speedup
                  ? t('skill_speedup_detail', { pct: ((1 - 1 / detailModal.avg_speedup) * 100).toFixed(0), x: detailModal.avg_speedup.toFixed(1) })
                  : t('skill_insufficient_data')}
              </Descriptions.Item>
              <Descriptions.Item label={t('skill_detail_created', 'Created')}>
                {new Date(detailModal.created_at).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>

            {/* The extracted skill body. Without it the only way to read what a
                skill actually says was to open 入库 — which is backwards: you
                cannot judge whether to promote it without seeing the content. */}
            <Card size="small" title={t('skill_detail_content', '正文')}>
              {detailModal.workflow_md ? (
                <pre style={{
                  maxHeight: 360,
                  overflow: 'auto',
                  fontSize: 12,
                  lineHeight: 1.6,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}>{detailModal.workflow_md}</pre>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('skill_detail_content_empty', '这条自悟 Skill 没有正文')}
                </Text>
              )}
            </Card>
          </Space>
        )}
      </Modal>

      {/* Edit Modal */}
      <Modal
        title={
          <Space>
            <EditOutlined />
            {t('skill_edit_title', 'Edit Skill')}
          </Space>
        }
        open={!!editModal}
        onCancel={() => setEditModal(null)}
        onOk={handleEditSave}
        confirmLoading={editLoading}
        okText={t('modal_save', 'Save')}
        cancelText={t('modal_cancel', 'Cancel')}
        width={560}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label={t('skill_form_name', 'Skill Name')}
            rules={[{ required: true, message: t('skill_form_name_required', 'Please enter skill name') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="description"
            label={t('skill_form_description', 'Description')}
          >
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item
            name="trigger_pattern"
            label={t('skill_form_trigger', 'Trigger Pattern')}
            extra={t('skill_form_trigger_hint', 'Keywords or phrases that trigger this skill')}
          >
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 入库 ─────────────────────────────────────────────────────────── */}
      <Modal
        open={!!promoteOf}
        title={t('skill_promote_title', `入库 — ${promoteOf?.name}`)}
        width={720}
        confirmLoading={promoting}
        onOk={doPromote}
        onCancel={() => setPromoteOf(null)}
        okText={t('skill_promote_ok', '入库')}
        cancelText={t('confirm_no', '取消')}
      >
        <Form form={promoteForm} layout="vertical">
          <Form.Item
            name="code"
            label={t('skill_promote_code', '标识')}
            rules={[
              { required: true, message: t('skill_promote_code_required', '必填') },
              {
                pattern: /^[a-z0-9][a-z0-9._-]*$/,
                message: t('skill_promote_code_pattern', '小写字母、数字、点、下划线、连字符'),
              },
            ]}
            extra={t('skill_promote_code_help', '系统按名称生成,可改;入库之后也随时能改')}
          >
            <Input />
          </Form.Item>
          <Form.Item name="category" label={t('skill_promote_category', '分类')}>
            <Input allowClear />
          </Form.Item>

          <div style={{ marginBottom: 8 }}>
            <Text type="secondary">
              {t('skill_promote_source',
                `来源:提炼自 ${promoteOf?.source_task_ids?.length || 0} 个任务`)}
            </Text>
          </div>

          <div style={{ marginBottom: 8 }}>
            <Text strong>{t('skill_promote_content', '内容(只读,入库后在正式Skill中编辑)')}</Text>
          </div>
          <pre style={{
            maxHeight: '38vh', overflow: 'auto', background: 'rgba(0,0,0,.03)',
            padding: 12, borderRadius: 6, fontSize: 12, margin: 0,
          }}>{promoteOf?.rendered_content}</pre>

          <div style={{ marginTop: 12 }}>
            <Text type="secondary">
              {t('skill_promote_note',
                '入库后默认为「停用」状态。请在正式Skill中确认内容无误,再启用并绑定给需要的 agent。')}
            </Text>
          </div>
        </Form>
      </Modal>
    </div>
  )
}

export default SkillList
