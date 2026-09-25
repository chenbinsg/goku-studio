/**
 * BoardPublishFields — Agent 的「产出发布」配置（board_publish）.
 *
 * 四件事：发不发布、用哪份显示模板、落工作台的哪个标签页、**这个 Agent 发布的内容**给谁看。
 * 发布不限于会议 —— 工作流节点和普通任务同样会产出，`publish_artifact` 的守卫是
 * 「能不能确定归属人」而不是「是不是会议轮」。
 * 写进 agent 的 `board_publish` 一列 JSON：
 *   {enabled, template:{key,version}, target:{mode,dashboard_id,name},
 *    audience:{scope,departments,roles,users}}
 *
 * 会议侧尤其依赖它：publish 轮给主持人哪个工具、给什么指令（字段清单由所选模板生成）、
 * 会议结束的兜底投递、以及制品的可见性和落位。配置即授权 —— 配了模板就等于把
 * publish_artifact 给了这个主持人，不必再去 allowed_tools 里单独勾一遍。
 *
 * ## 受众为什么是「指定主体」而不是「仅归属人 / 同部门 / 同租户」
 *
 * 那三档是**相对于归属人**的范围。而这份配置管的是发到组织级 tab 上的产出，配置人
 * 心里想的是一个确定的人群（风控部、审计角色、某几个人），相对范围只在「归属人恰好
 * 是那群人里的一员」时才碰巧重合。更早的版本还把它写到**看板行**上，而自动建出来的
 * tab 没有归属人 —— 后端 `_owner_in_my_departments()` 第一行就返回 false，界面上选
 * 「同部门」、实际效果是「只有超管能看」。
 *
 * 所以改成直接说出主体。全空 = 只有归属人和超管看得到（没配就最严，不是没配就放开）。
 *
 * Studio 和 Core 各有一份 agent 编辑页，所以这个组件被两边共用同一份逻辑：
 * 两处各写一遍必然漂移（这个仓库在 workflows.py 上已经漂过一次）。
 */
import { Alert, Checkbox, Form, Radio, Select, Space, Switch, Typography } from 'antd'
import { useEffect, useState } from 'react'

export interface BoardPublishAudience {
  scope?: 'tenant' | 'restricted'
  departments?: string[]
  roles?: string[]
  users?: string[]
}

export interface BoardPublishValue {
  enabled?: boolean
  /** 适用的协作模式。缺省（存量配置）= 三种都发，与本次改动前行为一致。 */
  modes?: string[]
  template?: { key?: string; version?: string | number }
  target?: { tab_id?: string | null; mode?: string; dashboard_id?: string | null; name?: string }
  audience?: BoardPublishAudience
  /** 存量形状。后端照原样解析，不做转换 —— 见 service.audience_of。 */
  visibility?: string
  allowed_roles?: string[]
}

interface TemplateOption { key: string; name: string; status: string; current_version?: number | null }
interface RoleOption { id: string; name: string }
interface DepartmentOption { id: string; name: string }
interface BindableTab { id: string; name: string; slug: string | null }
interface MigratePreview { record_count: number; source_tabs: number }
interface UserOption { id: string; username: string; full_name?: string | null }

/** 存量 `visibility` 取值的中文名，仅用于提示 —— 新表单里没有对应的选项。 */
const LEGACY_LABELS: Record<string, string> = {
  private: '仅归属人',
  department: '同部门',
  tenant: '同租户',
  team: '同团队',
}

/** 表单里的扁平字段 → board_publish 的嵌套形状。提交前调。
 *
 * 返回 `undefined` 表示**这一页没被渲染过，调用方不要提交这个字段**，与
 * 「用户把开关关掉了」（返回 `{enabled:false}`）是两回事。
 *
 * 看板配置在编辑弹窗的第四个标签页，不点进去就不渲染；而保存走的是
 * `form.validateFields()`，它**只返回已注册的字段**。两件事撞在一起，
 * 就是「改个 Agent 名字，看板发布配置被静默清空」——`board_publish_enabled`
 * 拿到 undefined，旧代码直接当成「关掉了」，把整份配置连目标标签页、模板、
 * 受众一起抹掉，没有任何提示。2026-09-25 在本地受控复现过一次。
 */
export function toBoardPublish(values: Record<string, unknown>): BoardPublishValue | null | undefined {
  if (values.board_publish_enabled === undefined) return undefined
  if (!values.board_publish_enabled) return { enabled: false }
  const scope = (values.board_publish_scope as 'tenant' | 'restricted') || 'restricted'
  // 一种都没勾 = 哪儿都不发。这时仍然写 `enabled: true`：开关和适用范围是两件事，
  // 把它改写成 enabled=false 会让人下次打开时以为自己关过这个开关。
  const modes = (values.board_publish_modes as string[]) || []
  return {
    enabled: true,
    modes,
    template: { key: values.board_publish_template as string, version: 'latest' },
    // 绑定只有一种形状：一个标签页的 id。**不再有「新建专用 tab」** ——
    // 发布动作顺手建栏是「改个名字就劈成两个栏」「打错一个字悄悄多一个」的来源。
    // 标签页在「工作台管理」里建，这里只负责选一个。
    target: { tab_id: (values.board_publish_tab as string) || null },
    audience: {
      scope,
      // 选了「全员」时名单照样带上：它是并集叠加，留着既不会收窄范围，
      // 又让人切回「指定范围」时不用重填一遍
      departments: (values.board_publish_departments as string[]) || [],
      roles: (values.board_publish_roles as string[]) || [],
      users: (values.board_publish_users as string[]) || [],
    },
  }
}

/** board_publish → 表单的扁平字段。加载 agent 时调。 */
export function fromBoardPublish(config: BoardPublishValue | null | undefined): Record<string, unknown> {
  const cfg = config || {}
  // 存量配置（visibility + allowed_roles）在这里映射成新形状，但**只映射到表单上**：
  // 库里那份要等人按了保存才改。权限不该在打开一个页面时被静默改掉。
  const audience = cfg.audience || {
    scope: cfg.visibility === 'tenant' ? 'tenant' : 'restricted',
    departments: [],
    roles: cfg.allowed_roles || [],
    users: [],
  }
  return {
    board_publish_enabled: !!cfg.enabled,
    // 存量配置没有 modes，按「三种都发」回填 —— 后端同一口径（service.publish_modes）。
    // 回填成空数组会让人一保存就把发布范围缩成零，而他什么都没改。
    board_publish_modes: (cfg.modes && cfg.modes.length)
      ? cfg.modes : ['independent', 'delegate', 'meeting'],
    board_publish_template: cfg.template?.key,
    // 存量的 dashboard_id 与新的 tab_id 是同一个值（搬表时 id 沿用），所以直接认
    board_publish_tab: cfg.target?.tab_id || cfg.target?.dashboard_id || undefined,
    // 打开这一页时绑的是哪个。只用来判断「绑定变了没有」，不提交给后端
    board_publish_bound_at_load: cfg.target?.tab_id || cfg.target?.dashboard_id || undefined,
    // 还按名字绑的存量配置：留一份名字用于提示，**不自作主张替他选一个同名的栏** ——
    // 那等于在他没点保存的情况下改掉了绑定
    board_publish_legacy_name:
      (cfg.target?.tab_id || cfg.target?.dashboard_id) ? undefined : (cfg.target?.name || undefined),
    board_publish_scope: audience.scope || 'restricted',
    board_publish_departments: audience.departments || [],
    board_publish_roles: audience.roles || [],
    board_publish_users: audience.users || [],
    // 存量的相对范围里只有「同租户」在新形状里有等价项（scope=tenant），其余几档
    // 没有 —— 只在那几档上提示，免得给一份等价的配置报一个假警。
    board_publish_legacy_visibility:
      !cfg.audience && cfg.visibility && cfg.visibility !== 'tenant'
        ? cfg.visibility : undefined,
  }
}

/** 两个仓库的 api 客户端类型不同，这里只要求「能 get 回 JSON」这一件事。 */
type Getter = { get: (url: string, config?: never) => Promise<unknown> }

/** `agentId` 只在编辑已有 Agent 时有：新建的 Agent 还没有任何记录可迁。 */
export default function BoardPublishFields({ api, agentId }:
  { api: Getter; agentId?: string }) {
  const fetchList = async <T,>(url: string): Promise<T[]> => {
    const data = (await api.get(url)) as { items?: T[] } | T[] | undefined
    if (Array.isArray(data)) return data
    return (data?.items as T[]) || []
  }

  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [departments, setDepartments] = useState<DepartmentOption[]>([])
  const [users, setUsers] = useState<UserOption[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [bindable, setBindable] = useState<BindableTab[]>([])
  // 取不到就如实说，而不是显示成「没有可选的」——后者会让人去建一个已经存在的
  const [bindableFailed, setBindableFailed] = useState(false)
  const [migratePreview, setMigratePreview] = useState<MigratePreview | null>(null)

  useEffect(() => {
    // 只列已发布的模板：草稿模板发布时会被拒（没有已发布版本），
    // 在这里就不该让人选到
    fetchList<TemplateOption>('/display-templates')
      .then((rows) => setTemplates(rows.filter((t) => t.status === 'published')))
      .catch(() => setLoadFailed(true))
    fetchList<RoleOption>('/roles').then(setRoles).catch(() => setRoles([]))
    fetchList<DepartmentOption>('/departments').then(setDepartments).catch(() => setDepartments([]))
    // 取一页就够做下拉：人多时靠搜索找，不是靠滚。size 与用户管理页同一量级
    fetchList<UserOption>('/users?page=1&size=200').then(setUsers).catch(() => setUsers([]))
    // 能绑哪些栏。权限要 agents.write 而不是 workbench.read —— 配 Agent 的人
    // 不一定管得了工作台，但他必须看得见有哪些栏可选。
    fetchList<BindableTab>('/workbench/tabs/bindable')
      .then((rows) => { setBindable(rows); setBindableFailed(false) })
      .catch(() => setBindableFailed(true))
    // fetchList 依赖 api，api 在两端都是模块级单例，不会每次渲染都变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  // 迁移会动多少东西 —— 勾之前就该看得见，而不是点完才知道。
  // 只在编辑已有 Agent 时问：新建的还没有任何记录。
  useEffect(() => {
    if (!agentId) return
    api.get(`/workbench/tabs/migrate/preview?agent_id=${encodeURIComponent(agentId)}`)
      .then((d) => setMigratePreview(d as MigratePreview))
      .catch(() => setMigratePreview(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, agentId])


  return (
    <>
      <Form.Item
        label="产出发布到工作台"
        name="board_publish_enabled"
        valuePropName="checked"
        initialValue={false}
        tooltip="启用后，该 Agent 的产出将按所选模板发布到工作台的指定标签页。会议、工作流与普通任务都适用。"
        style={{ marginBottom: 8 }}
      >
        <Switch checkedChildren="开" unCheckedChildren="关" style={{ minWidth: 100 }} />
      </Form.Item>

      <Form.Item shouldUpdate noStyle>
        {({ getFieldValue }) => {
          // 关掉时**不隐藏**下面这些，只置灰：藏起来的话，想看"上次配的是什么"
          // 就得先打开开关，而打开本身就是一次改动 —— 看一眼不该有副作用。
          const on = !!getFieldValue('board_publish_enabled')
          // 存量配置还按名字绑着 —— 提示他重选一个，但不替他选
          const legacyName = getFieldValue('board_publish_legacy_name')
          // 绑定变了才谈得上迁移。没变时复选框置灰：源和目标是同一个，迁移是空操作
          const bindingChanged = !!agentId
            && !!getFieldValue('board_publish_tab')
            && getFieldValue('board_publish_tab') !== getFieldValue('board_publish_bound_at_load')
          const scope = getFieldValue('board_publish_scope') || 'restricted'
          const legacyVisibility = getFieldValue('board_publish_legacy_visibility')
          const hasAudience = ['board_publish_departments', 'board_publish_roles',
                               'board_publish_users']
            .some((field) => (getFieldValue(field) || []).length > 0)
          return (
            <div style={{ paddingLeft: 12, borderLeft: '2px solid var(--b-f0f0f0)',
                          opacity: on ? 1 : 0.45 }}>
              {loadFailed && (
                <Alert type="warning" showIcon style={{ marginBottom: 10 }}
                       message="模板列表加载失败，可能缺少 templates.read 权限。" />
              )}

              <Form.Item
                label="适用模式"
                name="board_publish_modes"
                // 一个都不勾 = 哪条路都不发布，那这份配置就只是摆设，而且不会报错。
                // 开了开关就必须选，与模板、目标标签页同级。
                rules={on ? [{
                  validator: (_rule, value: string[] | undefined) =>
                    (value && value.length)
                      ? Promise.resolve()
                      : Promise.reject(new Error('请至少勾选一种适用模式，否则该配置不会发布任何产出。')),
                }] : []}
                tooltip="该 Agent 在哪些协作模式下发布产出。未勾选的模式完全不发布，也不做兜底投递。工作流不在此列 —— 工作流节点自己调用发布工具，模板在节点上配置。"
              >
                <Checkbox.Group
                  disabled={!on}
                  options={[
                    { label: '独立模式', value: 'independent' },
                    { label: '协作模式', value: 'delegate' },
                    { label: '会议模式', value: 'meeting' },
                  ]}
                />
              </Form.Item>

              <Form.Item
                label="模板"
                name="board_publish_template"
                rules={on ? [{ required: true, message: '请选择模板：产出的呈现形式由模板决定。' }] : []}
                tooltip="产出包含哪些字段与条目、以何种版式呈现，均由模板决定。模板在「模板管理」中维护。"
              >
                <Select
                  disabled={!on}
                  placeholder="请选择已发布的模板"
                  showSearch
                  optionFilterProp="label"
                  options={templates.map((t) => ({
                    value: t.key,
                    label: `${t.name}（${t.key} v${t.current_version ?? '-'}）`,
                  }))}
                />
              </Form.Item>

              {legacyName && (
                <Alert
                  type="warning" showIcon style={{ marginBottom: 10 }}
                  message={`当前配置按名称绑定：「${legacyName}」`}
                  description={
                    '名称可被修改，重命名后等同于指向另一个目标：历史记录留在原处，'
                    + '新产出落入新建的标签页。请在下方重新选择，保存后将按 ID 绑定。'
                  }
                />
              )}

              <Form.Item
                label="目标标签页"
                name="board_publish_tab"
                rules={on ? [{ required: true, message: '请选择目标标签页' }] : []}
                tooltip="标签页在「工作台管理」中创建与重命名。此处按 ID 绑定，重命名不影响已有记录。"
              >
                <Select
                  disabled={!on}
                  placeholder={bindableFailed ? '加载失败' : '请选择目标标签页'}
                  showSearch
                  optionFilterProp="label"
                  options={bindable.map((t) => ({ value: t.id, label: t.name }))}
                  notFoundContent="暂无可用标签页，请先在「工作台管理」中创建"
                />
              </Form.Item>

              <Form.Item name="board_publish_migrate" valuePropName="checked"
                         initialValue={false} style={{ marginTop: -8 }}>
                <Checkbox disabled={!on || !bindingChanged}>
                  保存时将该 Agent 的历史记录一并迁移至新标签页
                  {migratePreview && migratePreview.record_count > 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                      共 {migratePreview.record_count} 份（来自 {migratePreview.source_tabs} 个标签页）
                    </Typography.Text>
                  )}
                </Checkbox>
              </Form.Item>

              <Form.Item
                label="产出可见范围"
                name="board_publish_scope"
                initialValue="restricted"
                tooltip="仅作用于该 Agent 发布的产出。同一 tab 上其他 Agent 的产出各自独立判定，此处配置不改变 tab 本身的访问权限。"
                style={{ marginBottom: 8 }}
              >
                <Radio.Group disabled={!on}>
                  <Radio value="restricted">指定范围</Radio>
                  <Radio value="tenant">全员可见</Radio>
                </Radio.Group>
              </Form.Item>

              {legacyVisibility && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message={`当前为旧版可见性配置：${LEGACY_LABELS[legacyVisibility] || legacyVisibility}`}
                  description={
                    '旧版按产出归属人的相对范围判定，在无归属人的组织级 tab 上无法命中任何用户。'
                    + '保存后以上方所选范围为准；保存前既有配置维持不变。'
                  }
                />
              )}

              {scope === 'restricted' && (
                <>
                  <Typography.Text type="secondary"
                                   style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                    下列三项为<b>并集</b>关系 —— 满足任一项即可查看。
                  </Typography.Text>

                  <Form.Item
                    label="部门"
                    name="board_publish_departments"
                    tooltip="按部门授予查看权限，与产出归属人所属部门无关。"
                  >
                    <Select
                      disabled={!on}
                      mode="multiple"
                      allowClear
                      placeholder="不限定"
                      optionFilterProp="label"
                      options={departments.map((d) => ({ value: d.name, label: d.name }))}
                    />
                  </Form.Item>

                  <Form.Item label="角色" name="board_publish_roles">
                    <Select
                      disabled={!on}
                      mode="multiple"
                      allowClear
                      placeholder="不限定"
                      optionFilterProp="label"
                      options={roles.map((r) => ({ value: r.id, label: r.name }))}
                    />
                  </Form.Item>

                  <Form.Item label="成员" name="board_publish_users">
                    <Select
                      disabled={!on}
                      mode="multiple"
                      allowClear
                      showSearch
                      placeholder="不限定"
                      optionFilterProp="label"
                      options={users.map((u) => ({
                        value: u.id,
                        label: u.full_name ? `${u.full_name}（${u.username}）` : u.username,
                      }))}
                    />
                  </Form.Item>
                </>
              )}

              <Space direction="vertical" size={2} style={{ marginTop: -6 }}>
                {scope === 'restricted' && !hasAudience && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    三项均为空时，仅产出归属人与超级管理员可查看。
                  </Typography.Text>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  选定模板即视为向该主持人授予 publish_artifact 权限，无需在工具列表中另行勾选。
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  启用后，该 Agent 主持的会议不再调用 publish_plan / publish_campaign_spec；产出类型由模板决定，模型仅填充内容。
                </Typography.Text>
              </Space>
            </div>
          )
        }}
      </Form.Item>
    </>
  )
}
