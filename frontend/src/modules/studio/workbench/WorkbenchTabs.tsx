/**
 * 工作台管理.
 *
 * 设计：workspace 的 `docs/DESIGN-workbench-tabs.md`（刻意不在仓库里）。
 *
 * 管的是 `workbench_tabs`：`builtin`（内置栏，内容由前端组件渲染）和
 * `artifact`（产出标签页）。与「看板」那张表无关 —— 那是看板功能自己的。
 *
 * 版式照 Skill管理（同为列表型管理页）：图标+标题、一行说明、工具条卡片、表格卡片，
 * 操作列是文字链而不是一排带边框的按钮。
 *
 * 界面上有三条是刻意的，改之前先想清楚：
 *
 *  1. **没有删除按钮。** 栏里挂着历史记录，删了会留下一批找不到归属的产出。
 *     只有停用。
 *
 *  2. **停用前必须没有 Agent 绑着**（后端拦，这里把拦下来的名单摊开给人看）。
 *     只说「有绑定」会让人自己去一个个 Agent 里翻。
 *
 *  3. **迁移按钮只在「在这一栏有记录」且「当前发布到别的栏」时出现。**
 *     源和目标相同的迁移是空操作 —— 让人点下去再报错，是把校验当成了交互。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Button, Card, Checkbox, Divider, Drawer, Form, Input, InputNumber, Modal, Select,
  Space, Table, Tag, Tooltip, Typography, message,
} from 'antd'
import { AppstoreOutlined, PlusOutlined, SwapOutlined } from '@ant-design/icons'
import { api } from '@/api'

const { Text, Paragraph } = Typography

interface Tab {
  id: string
  slug: string
  name: string
  description: string | null
  kind: 'builtin' | 'artifact'
  position: number
  enabled: boolean
  visibility: string
  allowed_roles: string[]
  /** 「看板」那一行：它渲染的是登录落地解析的结果，不支持修改 */
  readonly: boolean
  artifact_count: number
  bound_agents: number
}

interface TabAgent {
  agent_id: string
  agent_name: string
  record_count: number
  bound_tab_id: string | null
  can_migrate: boolean
}

const VISIBILITY = [
  { value: 'tenant', label: '全员可见' },
  { value: 'restricted', label: '指定范围' },
]

export default function WorkbenchTabs() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState<Tab | null>(null)
  const [agentsOf, setAgentsOf] = useState<Record<string, TabAgent[]>>({})
  const [showDisabled, setShowDisabled] = useState(true)
  // 孤儿记录（发布它的 Agent 已不再绑定任何栏）要迁到哪儿，只能人来指定
  const [orphan, setOrphan] = useState<{ tab: Tab; agent: TabAgent } | null>(null)
  const [orphanTarget, setOrphanTarget] = useState<string | undefined>(undefined)
  const [form] = Form.useForm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<{ items: Tab[] }>('/workbench/tabs')
      setTabs(data.items || [])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const loadAgents = async (tabId: string) => {
    try {
      const data = await api.get<{ items: TabAgent[] }>(`/workbench/tabs/${tabId}/agents`)
      setAgentsOf((prev) => ({ ...prev, [tabId]: data.items || [] }))
    } catch {
      setAgentsOf((prev) => ({ ...prev, [tabId]: [] }))
    }
  }

  const openDetail = (tab: Tab) => {
    setDetail(tab)
    form.setFieldsValue(tab)
    void loadAgents(tab.id)
  }

  const save = async (values: Record<string, unknown>) => {
    try {
      if (creating) await api.post('/workbench/tabs', values)
      else await api.patch(`/workbench/tabs/${detail!.id}`, values)
      message.success('已保存')
      setCreating(false); setDetail(null)
      void load()
    } catch (e: unknown) {
      const detailMsg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(typeof detailMsg === 'string' ? detailMsg : '保存失败')
    }
  }

  const toggle = async (tab: Tab) => {
    if (!tab.enabled) {
      await api.post(`/workbench/tabs/${tab.id}/enable`, {})
      message.success('已启用'); setDetail(null); void load()
      return
    }
    // 停用不是界面开关：里面的记录会对所有人不可访问，深链也打不开。
    // 所以把影响面写在确认框里，而不是让人点完才发现。
    Modal.confirm({
      title: `确认停用「${tab.name}」？`,
      content: tab.artifact_count > 0
        ? `该标签页下有 ${tab.artifact_count} 份记录，停用后将无法访问（含已分享的链接）。`
          + '如需保留访问，请先将记录迁移至其他标签页。'
        : '停用后该标签页不再显示，也不再接收新的产出。',
      okText: '确认停用', okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await api.post(`/workbench/tabs/${tab.id}/disable`, {})
          message.success('已停用'); setDetail(null); void load()
        } catch (e: unknown) {
          const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
          const body = d as { message?: string; bindings?: { agent_name: string; artifact_count: number }[] }
          if (body?.bindings) {
            // 说清楚是谁挡着 —— 只说「有绑定」会让人自己去翻每个 Agent
            Modal.warning({
              title: body.message,
              content: (
                <ul style={{ paddingLeft: 18, marginTop: 8 }}>
                  {body.bindings.map((b) => (
                    <li key={b.agent_name}>{b.agent_name}：{b.artifact_count} 份记录</li>
                  ))}
                </ul>
              ),
            })
          } else message.error('停用失败')
        }
      },
    })
  }

  const migrate = (tab: Tab, agent: TabAgent) => {
    const target = tabs.find((t) => t.id === agent.bound_tab_id)
    Modal.confirm({
      title: `迁移「${agent.agent_name}」的记录`,
      content: `将该 Agent 在「${tab.name}」下的 ${agent.record_count} 份记录，`
        + `迁移至其当前绑定的「${target?.name ?? '目标标签页'}」。记录的可见范围保持不变。`,
      okText: '确认迁移',
      onOk: async () => {
        try {
          const r = await api.post<{ moved: number; to_tab_name: string }>(
            '/workbench/tabs/migrate', { agent_id: agent.agent_id, from_tab_id: tab.id })
          message.success(`已迁移 ${r.moved} 份记录至「${r.to_tab_name}」`)
          void load(); void loadAgents(tab.id)
        } catch {
          message.error('迁移失败')
        }
      },
    })
  }

  const columns = [
    {
      title: '标签页', dataIndex: 'name', key: 'name',
      render: (name: string, row: Tab) => (
        <Space direction="vertical" size={0}>
          <a onClick={() => openDetail(row)}>{name}</a>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.slug}</Text>
        </Space>
      ),
    },
    {
      title: '类型', dataIndex: 'kind', key: 'kind', width: 90,
      render: (kind: string) => <Tag>{kind === 'builtin' ? '内置' : '产出'}</Tag>,
    },
    {
      title: '状态', dataIndex: 'enabled', key: 'enabled', width: 90,
      render: (enabled: boolean) =>
        enabled ? <Tag color="success">启用</Tag> : <Tag color="error">已停用</Tag>,
    },
    { title: '顺序', dataIndex: 'position', key: 'position', width: 70 },
    {
      title: '可见范围', dataIndex: 'visibility', key: 'visibility', width: 120,
      render: (v: string) => VISIBILITY.find((o) => o.value === v)?.label ?? v,
    },
    {
      title: '记录数', dataIndex: 'artifact_count', key: 'artifact_count', width: 80,
      render: (n: number) => (n ? n : <Text type="secondary">—</Text>),
    },
    {
      title: '关联 Agent', dataIndex: 'bound_agents', key: 'bound_agents', width: 110,
      render: (n: number) => (n ? `${n} 个` : <Text type="secondary">—</Text>),
    },
    {
      title: '操作', key: 'ops', width: 150, align: 'right' as const,
      render: (_: unknown, row: Tab) => (
        <Space size={0}>
          <Button size="small" type="link" onClick={() => openDetail(row)}>详情</Button>
          {row.readonly ? (
            <Tooltip title="系统内置标签页，不支持停用">
              <Button size="small" type="link" disabled>停用</Button>
            </Tooltip>
          ) : (
            <Button size="small" type="link" onClick={() => void toggle(row)}>
              {row.enabled ? '停用' : '启用'}
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 4 }} align="center">
        <AppstoreOutlined style={{ fontSize: 24, color: '#1677ff' }} />
        <Typography.Title level={3} style={{ margin: 0 }}>工作台管理</Typography.Title>
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Text type="secondary">管理「我的工作台」的标签页：名称、排序与可见范围。</Text>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />}
                  onClick={() => { setCreating(true); form.resetFields() }}>
            新建标签页
          </Button>
          <Checkbox checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)}>
            显示已停用
          </Checkbox>
        </Space>
      </Card>

      <Card>
        <Table
          rowKey="id" size="small" loading={loading} columns={columns}
          dataSource={showDisabled ? tabs : tabs.filter((t) => t.enabled)}
          pagination={false}
        />
      </Card>

      <Drawer
        open={!!detail}
        width={620}
        title={detail?.name}
        onClose={() => setDetail(null)}
        extra={detail && !detail.readonly && (
          <Button danger={detail.enabled} onClick={() => void toggle(detail)}>
            {detail.enabled ? '停用' : '启用'}
          </Button>
        )}
      >
        {detail && (
          <>
            {detail.readonly && (
              <Paragraph type="secondary">
                系统内置标签页，其内容由登录落地逻辑决定，不支持修改名称、排序或停用。
              </Paragraph>
            )}

            <Form form={form} layout="vertical" onFinish={save} preserve={false}
                  disabled={detail.readonly}>
              <Form.Item label="名称" name="name"
                         rules={[{ required: true, message: '请输入名称' }]}>
                <Input />
              </Form.Item>
              <Form.Item
                label="编码" name="slug"
                tooltip="唯一标识，不随名称变更。内置标签页的编码与前端组件关联，不可修改。"
              >
                <Input disabled={detail.kind === 'builtin'} />
              </Form.Item>
              <Form.Item
                label="可见范围" name="visibility"
                tooltip="控制该标签页本身的可见范围。标签页内的每份产出另有独立的可见范围，两者同时生效。"
              >
                <Select options={VISIBILITY} />
              </Form.Item>
              <Form.Item label="顺序" name="position"
                         tooltip="数值越小越靠前。内置标签页占 0–4，产出标签页从 10 开始。">
                <InputNumber min={0} max={9999} style={{ width: 140 }} />
              </Form.Item>
              {!detail.readonly && (
                <Button type="primary" onClick={() => form.submit()}>保存</Button>
              )}
            </Form>

            {detail.kind === 'artifact' && (
              <>
                <Divider />
                <Typography.Title level={5} style={{ marginTop: 0 }}>关联 Agent</Typography.Title>
                {!agentsOf[detail.id] ? <Text type="secondary">加载中…</Text>
                  : !agentsOf[detail.id].length ? <Text type="secondary">暂无数据</Text>
                  : (
                    <Table
                      rowKey="agent_id" size="small" pagination={false}
                      dataSource={agentsOf[detail.id]}
                      columns={[
                        { title: 'Agent', dataIndex: 'agent_name', key: 'n' },
                        { title: '记录数', dataIndex: 'record_count', key: 'c', width: 80 },
                        {
                          title: '当前发布至', key: 'b', width: 140,
                          render: (_: unknown, a: TabAgent) => (
                            a.bound_tab_id
                              ? <Text>{tabs.find((t) => t.id === a.bound_tab_id)?.name ?? a.bound_tab_id}</Text>
                              : <Text type="secondary">未绑定</Text>
                          ),
                        },
                        {
                          title: '操作', key: 'op', width: 110, align: 'right' as const,
                          render: (_: unknown, a: TabAgent) => {
                            // 绑定在别的栏：目标由绑定决定，一键迁过去
                            if (a.can_migrate) {
                              return (
                                <Button size="small" type="link" icon={<SwapOutlined />}
                                        onClick={() => migrate(detail, a)}>迁移</Button>
                              )
                            }
                            // Agent 已删 / 关掉了看板发布 / 从没配过目标 —— 没有绑定可依据。
                            // 不给入口的话这批记录就搬不走，而停用会让它们不可访问。
                            if (!a.bound_tab_id) {
                              return (
                                <Button size="small" type="link" icon={<SwapOutlined />}
                                        onClick={() => setOrphan({ tab: detail, agent: a })}>迁移</Button>
                              )
                            }
                            // 绑定就是本栏：源和目标同一个，迁移是空操作
                            return null
                          },
                        },
                      ]}
                    />
                  )}
              </>
            )}
          </>
        )}
      </Drawer>

      <Modal
        open={!!orphan}
        title={orphan ? `迁移「${orphan.agent.agent_name}」的记录` : ''}
        okText="确认迁移"
        okButtonProps={{ disabled: !orphanTarget }}
        onCancel={() => { setOrphan(null); setOrphanTarget(undefined) }}
        onOk={async () => {
          if (!orphan || !orphanTarget) return
          try {
            const r = await api.post<{ moved: number; to_tab_name: string }>(
              '/workbench/tabs/migrate',
              { agent_id: orphan.agent.agent_id, from_tab_id: orphan.tab.id,
                to_tab_id: orphanTarget })
            message.success(`已迁移 ${r.moved} 份记录至「${r.to_tab_name}」`)
            const tabId = orphan.tab.id
            setOrphan(null); setOrphanTarget(undefined)
            void load(); void loadAgents(tabId)
          } catch {
            message.error('迁移失败')
          }
        }}
      >
        <Paragraph type="secondary">
          该 Agent 当前未绑定任何标签页，请指定迁移目标。记录的可见范围保持不变。
        </Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder="请选择目标标签页"
          value={orphanTarget}
          onChange={setOrphanTarget}
          // 停用的栏不在候选里：迁进去等于把记录藏起来，那不是迁移的意思
          notFoundContent="暂无可选的标签页"
          options={tabs
            .filter((t) => t.kind === 'artifact' && t.enabled && t.id !== orphan?.tab.id)
            .map((t) => ({ value: t.id, label: t.name }))}
        />
      </Modal>

      {/* 新建走弹窗，**修改一律走详情抽屉** —— 两处各摆一份设置表单必然漂，
          而且「编辑」和「详情」在用户看来本来就是同一件事。 */}
      <Modal
        open={creating}
        title="新建标签页"
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={save} preserve={false}>
          <Form.Item label="名称" name="name"
                     rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="请输入名称" />
          </Form.Item>
          <Form.Item label="编码" name="slug"
                     tooltip="唯一标识，不随名称变更。仅支持小写字母、数字与连字符；留空则自动生成。">
            <Input placeholder="留空自动生成" />
          </Form.Item>
          <Form.Item label="可见范围" name="visibility" initialValue="tenant"
                     tooltip="控制该标签页本身的可见范围。标签页内的每份产出另有独立的可见范围，两者同时生效。">
            <Select options={VISIBILITY} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
