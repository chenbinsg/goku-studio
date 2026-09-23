/**
 * BoardPublishFields — Agent 的「会议产出进看板」配置（board_publish）.
 *
 * 四件事：进不进看板、用哪份显示模板、落哪个 tab、谁能看到。写进 agent 的
 * `board_publish` 一列 JSON：
 *   {enabled, template:{key,version}, target:{mode,dashboard_id,name},
 *    visibility, allowed_roles}
 *
 * 会议侧全靠它：publish 轮给主持人哪个工具、给什么指令（字段清单由所选模板生成）、
 * 会议结束的兜底投递、以及制品的可见性和落位。配置即授权 —— 配了模板就等于把
 * publish_artifact 给了这个主持人，不必再去 allowed_tools 里单独勾一遍。
 *
 * Studio 和 Core 各有一份 agent 编辑页，所以这个组件被两边共用同一份逻辑：
 * 两处各写一遍必然漂移（这个仓库在 workflows.py 上已经漂过一次）。
 */
import { Alert, Form, Input, Radio, Select, Space, Switch, Typography } from 'antd'
import { useEffect, useState } from 'react'

export interface BoardPublishValue {
  enabled?: boolean
  template?: { key?: string; version?: string | number }
  target?: { mode?: 'existing' | 'dedicated'; dashboard_id?: string | null; name?: string }
  visibility?: string
  allowed_roles?: string[]
}

interface TemplateOption { key: string; name: string; status: string; current_version?: number | null }
interface DashboardOption { id: string; name: string }
interface RoleOption { id: string; name: string }

/** 表单里的扁平字段 → board_publish 的嵌套形状。提交前调。 */
export function toBoardPublish(values: Record<string, unknown>): BoardPublishValue | null {
  if (!values.board_publish_enabled) return { enabled: false }
  const mode = (values.board_publish_target_mode as 'existing' | 'dedicated') || 'dedicated'
  return {
    enabled: true,
    template: { key: values.board_publish_template as string, version: 'latest' },
    target: mode === 'existing'
      ? { mode, dashboard_id: (values.board_publish_dashboard as string) || null }
      : { mode, name: (values.board_publish_tab_name as string) || '会议产出' },
    visibility: (values.board_publish_visibility as string) || 'private',
    allowed_roles: (values.board_publish_roles as string[]) || [],
  }
}

/** board_publish → 表单的扁平字段。加载 agent 时调。 */
export function fromBoardPublish(config: BoardPublishValue | null | undefined): Record<string, unknown> {
  const cfg = config || {}
  return {
    board_publish_enabled: !!cfg.enabled,
    board_publish_template: cfg.template?.key,
    board_publish_target_mode: cfg.target?.mode || 'dedicated',
    board_publish_dashboard: cfg.target?.dashboard_id || undefined,
    board_publish_tab_name: cfg.target?.name || '',
    board_publish_visibility: cfg.visibility || 'private',
    board_publish_roles: cfg.allowed_roles || [],
  }
}

/** 两个仓库的 api 客户端类型不同，这里只要求「能 get 回 JSON」这一件事。 */
type Getter = { get: (url: string, config?: never) => Promise<unknown> }

export default function BoardPublishFields({ api }: { api: Getter }) {
  const fetchList = async <T,>(url: string): Promise<T[]> => {
    const data = (await api.get(url)) as { items?: T[] } | T[] | undefined
    if (Array.isArray(data)) return data
    return (data?.items as T[]) || []
  }

  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [dashboards, setDashboards] = useState<DashboardOption[]>([])
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    // 只列已发布的模板：草稿模板发布时会被拒（没有已发布版本），
    // 在这里就不该让人选到
    fetchList<TemplateOption>('/display-templates')
      .then((rows) => setTemplates(rows.filter((t) => t.status === 'published')))
      .catch(() => setLoadFailed(true))
    fetchList<DashboardOption>('/dashboards').then(setDashboards).catch(() => setDashboards([]))
    fetchList<RoleOption>('/roles').then(setRoles).catch(() => setRoles([]))
    // fetchList 依赖 api，api 在两端都是模块级单例，不会每次渲染都变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  return (
    <>
      <Form.Item
        label="会议产出进看板"
        name="board_publish_enabled"
        valuePropName="checked"
        initialValue={false}
        tooltip="打开后，这个 Agent 主持的每场会议结束时，产出会按下面选的模板自动落到看板上"
        style={{ marginBottom: 8 }}
      >
        <Switch checkedChildren="开" unCheckedChildren="关" style={{ minWidth: 100 }} />
      </Form.Item>

      <Form.Item shouldUpdate noStyle>
        {({ getFieldValue }) => {
          // 关掉时**不隐藏**下面这些，只置灰：藏起来的话，想看"上次配的是什么"
          // 就得先打开开关，而打开本身就是一次改动 —— 看一眼不该有副作用。
          const on = !!getFieldValue('board_publish_enabled')
          const mode = getFieldValue('board_publish_target_mode') || 'dedicated'
          return (
            <div style={{ paddingLeft: 12, borderLeft: '2px solid var(--b-f0f0f0)',
                          opacity: on ? 1 : 0.45 }}>
              {loadFailed && (
                <Alert type="warning" showIcon style={{ marginBottom: 10 }}
                       message="模板列表没取到，可能是没有 templates.read 权限" />
              )}

              <Form.Item
                label="模板"
                name="board_publish_template"
                rules={on ? [{ required: true, message: '选一份模板 —— 产出长什么样由它决定' }] : []}
                tooltip="产出的呈现（有哪些字段、哪些条目、怎么排版）由模板决定。在「模板管理」页里维护"
              >
                <Select
                  disabled={!on}
                  placeholder="选择一份已发布的模板"
                  showSearch
                  optionFilterProp="label"
                  options={templates.map((t) => ({
                    value: t.key,
                    label: `${t.name}（${t.key} v${t.current_version ?? '-'}）`,
                  }))}
                />
              </Form.Item>

              <Form.Item label="落到哪个 tab" name="board_publish_target_mode" initialValue="dedicated">
                <Radio.Group disabled={!on}>
                  <Radio value="dedicated">新建专用 tab</Radio>
                  <Radio value="existing">选已有看板</Radio>
                </Radio.Group>
              </Form.Item>

              {mode === 'dedicated' ? (
                <Form.Item
                  label="tab 名称"
                  name="board_publish_tab_name"
                  tooltip="组织级 tab，不属于某个人；谁能看到由下面的可见范围决定"
                >
                  <Input disabled={!on} placeholder="例如：变更评审" />
                </Form.Item>
              ) : (
                <Form.Item label="已有看板" name="board_publish_dashboard">
                  <Select
                    disabled={!on}
                    placeholder="选一个看板"
                    showSearch
                    optionFilterProp="label"
                    options={dashboards.map((d) => ({ value: d.id, label: d.name }))}
                  />
                </Form.Item>
              )}

              <Form.Item
                label="谁可以看到"
                name="board_publish_visibility"
                initialValue="private"
                tooltip="和「装没装这个 Agent」无关，只看这里配的范围"
              >
                <Select
                  disabled={!on}
                  options={[
                    { value: 'private', label: '仅归属人' },
                    { value: 'department', label: '同部门' },
                    { value: 'tenant', label: '同租户' },
                  ]}
                />
              </Form.Item>

              <Form.Item
                label="额外可见角色"
                name="board_publish_roles"
                tooltip="在上面的范围之外再放行这些角色（并集，不是收窄）"
              >
                <Select
                  disabled={!on}
                  mode="multiple"
                  allowClear
                  placeholder="不限定"
                  optionFilterProp="label"
                  options={roles.map((r) => ({ value: r.id, label: r.name }))}
                />
              </Form.Item>

              <Space direction="vertical" size={2} style={{ marginTop: -6 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  选了模板就等于把 publish_artifact 授权给这个主持人，不必再到工具列表里单独勾。
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  开启后，这个 Agent 主持的会议不再使用 publish_plan / publish_campaign_spec —— 产物类型由模板决定，模型只填内容。
                </Typography.Text>
              </Space>
            </div>
          )
        }}
      </Form.Item>
    </>
  )
}
