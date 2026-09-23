/**
 * 显示模板管理 —— 列表 + 编辑器（左写右预览）+ 版本 + 引用反查.
 *
 * 这一页是「新增一种会议产出只写配置、不改代码」的入口：模板声明数据契约
 * （header_fields / item_kinds）、布局（受限标签）、行为（on_publish），会议、
 * 工作流、REST 三个入口共用它。
 *
 * 两个刻意的设计：
 *   1. **保存即校验**。布局有错后端直接 400 并给出行列号，这里原样标出来 ——
 *      配置页不能成为把线上页面打白的入口。
 *   2. **草稿 / 发布分离**。编辑改的是草稿，引用方看到的永远是已发布版本；
 *      「发布」是单独一个按钮（也是单独一个权限 templates.publish）。
 */
import {
  Alert, Button, Drawer, Empty, Form, Input, List, Modal, Space, Spin,
  Table, Tabs, Tag, Typography, message,
} from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { templateApi, type LayoutError, type PreviewResult, type References, type TemplateDetail, type TemplateSummary } from './api'

const { TextArea } = Input

/** 新模板的起手内容：一份能直接渲出东西的最小 HTML 模板。
 *
 * 不能给空白 —— 面对空编辑框，第一件事就是去别处抄一份，抄错了还得靠报错试出来。
 * 这份里把常用的几样都示范了一遍：占位符、条目循环、空状态、样式。 */
const SAMPLE_LAYOUT = `<style>
  .tpl-title { font-size: 20px; font-weight: 600; }
  .tpl-meta { color: var(--dt-text-muted); font-size: 12px; margin-bottom: 12px; }
  .tpl-h3 { font-size: 14px; font-weight: 600; color: var(--dt-accent);
            border-left: 4px solid var(--dt-accent); padding-left: 8px; margin: 18px 0 8px; }
  .tpl-table { border-collapse: collapse; width: 100%; font-size: 14px; }
  .tpl-table th, .tpl-table td { border: 1px solid var(--dt-border); padding: 8px; text-align: left; }
  .tpl-table th { background: var(--dt-surface-sunken); font-weight: 600; }
  .tpl-empty { color: var(--dt-text-muted); }
</style>

{{#part name="row"}}
  <div>{{title}}</div>
  <div class="tpl-meta">{{created_at}} · {{status}}</div>
{{/part}}

<div class="tpl-title">{{title}}</div>
<div class="tpl-meta">产出于 {{created_at}} · 状态 {{status}}</div>

<div class="tpl-h3">条目</div>
<table class="tpl-table">
  <tr><th>名称</th><th>说明</th></tr>
  {{#items kind="item"}}
  <tr><td>{{title}}</td><td>{{description}}</td></tr>
  {{/items}}
</table>
{{^items kind="item"}}<div class="tpl-empty">还没有条目</div>{{/items}}

<div class="tpl-h3">正文</div>
<div class="dt-narrative">{{md:body_md}}</div>`

const SAMPLE_HEADER = JSON.stringify(
  [{ key: 'status', label: '状态' }], null, 2)
const SAMPLE_KINDS = JSON.stringify(
  [{ key: 'item', label: '条目', fields: [] }], null, 2)

function ErrorList({ errors }: { errors: LayoutError[] }) {
  if (!errors.length) return null
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 10 }}
      message={`布局有 ${errors.length} 处问题`}
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {errors.map((e, i) => (
            <li key={i}><code>行{e.line}:{e.col}</code> {e.message}</li>
          ))}
        </ul>
      }
    />
  )
}

/** 编辑区高度。左右两列共用一个值，两边底部才对得齐。 */
const EDITOR_HEIGHT = 560

/** 编辑器：模板（HTML+CSS）+ 数据契约，下方整行是预览。 */
function Editor({ detail, onSaved }: { detail: TemplateDetail | null; onSaved: () => void }) {
  const draft = detail?.versions.find((v) => !v.is_published)
    || detail?.versions.find((v) => v.version === detail.current_version)
  const [layout, setLayout] = useState(draft?.layout || SAMPLE_LAYOUT)
  const [headerJson, setHeaderJson] = useState(
    JSON.stringify(draft?.header_fields || JSON.parse(SAMPLE_HEADER), null, 2))
  const [kindsJson, setKindsJson] = useState(
    JSON.stringify(draft?.item_kinds || JSON.parse(SAMPLE_KINDS), null, 2))
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const parsed = useCallback(() => {
    try {
      const header_fields = JSON.parse(headerJson || '[]')
      const item_kinds = JSON.parse(kindsJson || '[]')
      setJsonError(null)
      return { header_fields, item_kinds }
    } catch (e) {
      setJsonError(String(e))
      return null
    }
  }, [headerJson, kindsJson])

  // 边写边预览：500ms 防抖，够跟手又不会把后端打满
  useEffect(() => {
    const spec = parsed()
    if (!spec) return
    const timer = setTimeout(() => {
      // 时区跟着浏览器走：不传的话预览里的时间是 UTC，和看板差几个小时
      templateApi.preview({ key: detail?.key, layout, ...spec,
                            tz_offset: -new Date().getTimezoneOffset() })
        .then(setPreview).catch(() => setPreview(null))
    }, 500)
    return () => clearTimeout(timer)
  }, [layout, headerJson, kindsJson, parsed, detail?.key])

  const save = async () => {
    const spec = parsed()
    if (!spec || !detail) return
    setSaving(true)
    try {
      await templateApi.update(detail.key, { layout, ...spec })
      message.success('草稿已保存')
      onSaved()
    } catch (e: unknown) {
      const detailBody = (e as { response?: { data?: { detail?: { message?: string } } } })?.response?.data?.detail
      message.error(detailBody?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    // 预览占整行：它和看板同宽才看得到真实排版 —— 挤在右半栏里，模板自己的窄屏
    // 断点会生效，于是看到的是手机版的一栏，却容易以为是模板写错了。
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* 左：模板本身（HTML + CSS），这是主要在改的东西，给它高一点的编辑框 */}
      <div style={{ gridColumn: '1 / -1' }}>
        {jsonError && <Alert type="error" showIcon style={{ marginBottom: 10 }} message={`JSON 解析失败：${jsonError}`} />}
        <ErrorList errors={preview?.errors || []} />
        {/* 保存按钮放在这一行而不是左列底部：留在列里的话，左列最后是个按钮、
            右列最后是输入框，两列可见的底边就对不齐（容器齐了也没用，看的是边框）。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Button type="primary" loading={saving} disabled={!detail?.editable || !!preview?.errors?.length}
                  onClick={save}>
            保存草稿
          </Button>
          {!detail?.editable && <Typography.Text type="secondary">种子模板只读，请先复制为新模板</Typography.Text>}
        </div>
      </div>
      {/* 两列等高、编辑框自己撑满：左边一个框、右边两个框，各自写死行数的话
          两列底部对不齐，看着像排版坏了。 */}
      <div style={{ display: 'flex', flexDirection: 'column', height: EDITOR_HEIGHT, minHeight: 0, overflow: 'hidden' }}>
        <Typography.Text strong>模板（HTML + CSS）</Typography.Text>
        <TextArea value={layout} onChange={(e) => setLayout(e.target.value)}
                  style={{ flex: 1, minHeight: 0, fontFamily: 'monospace', fontSize: 12,
                           margin: '4px 0 0', resize: 'none' }} />
      </div>
      {/* 右：数据契约。改得少，但要和模板对照着看 —— 占位符写得对不对全看它 */}
      <div style={{ display: 'flex', flexDirection: 'column', height: EDITOR_HEIGHT, minHeight: 0, overflow: 'hidden' }}>
        <Typography.Text strong>头部字段 header_fields</Typography.Text>
        <TextArea value={headerJson} onChange={(e) => setHeaderJson(e.target.value)}
                  style={{ flex: 1, minHeight: 0, fontFamily: 'monospace', fontSize: 12,
                           margin: '4px 0 10px', resize: 'none' }} />
        <Typography.Text strong>条目类型 item_kinds</Typography.Text>
        <TextArea value={kindsJson} onChange={(e) => setKindsJson(e.target.value)}
                  style={{ flex: 2, minHeight: 0, fontFamily: 'monospace', fontSize: 12,
                           margin: '4px 0 0', resize: 'none' }} />
      </div>
      <div style={{ gridColumn: '1 / -1', marginTop: 10 }}>
        <Space style={{ marginBottom: 8 }}>
          <Typography.Text strong>预览</Typography.Text>
          {/* 一律示例数据：模板页是配置页，不展示生产内容 */}
          <Tag>示例数据</Tag>
        </Space>
        {preview?.html ? (
          // 预览 = 看板上那一段 HTML，原样塞进 iframe。用 iframe 是因为模板自带
          // <style>，不隔离会污染 Studio 自己的页面；除此之外不做任何处理。
          <iframe
            title="预览"
            // 容器必须是 .dt-root：模板里的 var(--dt-border) 这些变量定义在它上面
            // （见 theme.css），看板的容器就是这个 class。少了它，用变量的规则
            // 全部失效 —— 表格边框、表头底色、分节标题的蓝色都会消失，看起来像
            // 模板写错了，其实是预览的容器不对。
            srcDoc={`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}${preview.css || ''}</style><div class="dt-root">${preview.html}</div>`}
            style={{ width: '100%', height: 620, border: '1px solid var(--b-e5e7eb)',
                     borderRadius: 4, background: 'var(--s-ffffff)', display: 'block',
                     marginTop: 2 }}
          />
        ) : (
          <Empty description="布局校验通过后才会出现预览" />
        )}
      </div>
    </div>
  )
}

export default function TemplateList() {
  const [items, setItems] = useState<TemplateSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [references, setReferences] = useState<References | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [form] = Form.useForm()

  const load = useCallback(async (preferred?: string) => {
    const result = await templateApi.list()
    setItems(result.items)
    setSelected((current) => preferred || current || result.items[0]?.key || null)
  }, [])

  const loadDetail = useCallback(async (key: string) => {
    setDetail(await templateApi.get(key))
    setReferences(await templateApi.references(key))
  }, [])

  useEffect(() => { load().catch(() => setItems([])) }, [load])
  useEffect(() => { if (selected) void loadDetail(selected) }, [selected, loadDetail])

  const create = async (values: Record<string, string>) => {
    try {
      await templateApi.create({
        key: values.key, name: values.name, description: values.description,
        layout: SAMPLE_LAYOUT, header_fields: JSON.parse(SAMPLE_HEADER),
        item_kinds: JSON.parse(SAMPLE_KINDS), targets: ['board_panel', 'html_report'],
        default_visibility: 'private', on_publish: { require_approval: false },
      })
      message.success('模板已创建（草稿）')
      setCreateOpen(false)
      form.resetFields()
      await load(values.key)
    } catch (e: unknown) {
      const body = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      message.error(typeof body === 'string' ? body : '创建失败')
    }
  }

  const copy = () => {
    if (!detail) return
    let key = `${detail.key}-copy`
    Modal.confirm({
      title: `复制「${detail.name}」`,
      content: (
        <Input defaultValue={key} onChange={(e) => { key = e.target.value }}
               placeholder="新模板的 key（小写字母、数字、连字符）" style={{ marginTop: 8 }} />
      ),
      onOk: async () => {
        try {
          await templateApi.copy(detail.key, { key })
          message.success('已复制为草稿')
          await load(key)
        } catch {
          message.error('复制失败（key 可能已存在）')
        }
      },
    })
  }

  const publish = async () => {
    if (!detail) return
    try {
      await templateApi.publish(detail.key)
      message.success('已发布新版本')
      await loadDetail(detail.key)
      await load(detail.key)
    } catch (e: unknown) {
      const body = (e as { response?: { data?: { detail?: { message?: string } | string } } })?.response?.data?.detail
      message.error(typeof body === 'string' ? body : body?.message || '发布失败')
    }
  }

  const rollback = async (version: number) => {
    if (!detail) return
    await templateApi.rollback(detail.key, version)
    message.success(`已回退到 v${version}`)
    await loadDetail(detail.key)
  }

  const remove = async () => {
    if (!detail) return
    Modal.confirm({
      title: `删除模板 ${detail.key}？`,
      content: '有任何引用时会被拒绝 —— 删掉在用的模板会让引用方下次发布失败。',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await templateApi.remove(detail.key)
          message.success('已删除')
          setSelected(null)
          setDetail(null)
          await load()
        } catch {
          message.error('仍被引用，无法删除')
        }
      },
    })
  }

  /** 导出成 JSON 文件。文件名带 key 和版本，搬到别的环境时一眼知道是哪份。 */
  const exportOne = async () => {
    if (!detail) return
    try {
      const data = await templateApi.exportOne(detail.key)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${detail.key}.v${data.exported_version ?? 'draft'}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch {
      message.error('导出失败')
    }
  }

  /** 导入：读文件 → 校验由后端做（布局有错会 400，错误带行号）。 */
  const importFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text())
      const res = await templateApi.importOne(data)
      message.success(res.created
        ? `已导入为新模板 ${res.key}（草稿 v${res.imported_version}）`
        : `已加到 ${res.key} 的草稿 v${res.imported_version}，线上那版未改动`)
      await load()
      setSelected(res.key)
    } catch (e: any) {
      const detailMsg = e?.response?.data?.detail
      message.error(typeof detailMsg === 'string' ? detailMsg
        : detailMsg?.message || '导入失败：文件不是有效的模板 JSON')
    }
  }

  if (!items) return <Spin />

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 18 }}>
      <div>
        <Space.Compact block style={{ marginBottom: 10 }}>
          <Button type="primary" style={{ flex: 1 }} onClick={() => setCreateOpen(true)}>
            新建模板
          </Button>
          {/* 导入：跨环境搬模板走这里（对面用「导出」下载 JSON）。
              同 key 已存在时只加草稿版本，不动线上那份。 */}
          <Button style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>导入</Button>
        </Space.Compact>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
               onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f) }} />
        <List
          bordered
          dataSource={items}
          renderItem={(item) => (
            <List.Item style={{ cursor: 'pointer', background: selected === item.key ? '#f0f5ff' : undefined }}
                       onClick={() => setSelected(item.key)}>
              <List.Item.Meta
                title={<Space size={4}>{item.name}{item.source === 'seed' && <Tag>内置</Tag>}</Space>}
                description={
                  <Space size={4} wrap>
                    <Typography.Text code style={{ fontSize: 11 }}>{item.key}</Typography.Text>
                    <Tag color={item.status === 'published' ? 'green' : 'default'}>
                      {item.status === 'published' ? `v${item.current_version}` : '草稿'}
                    </Tag>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      </div>

      <div>
        {!detail ? <Empty description="选一份模板" /> : (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Typography.Title level={4} style={{ margin: 0 }}>{detail.name}</Typography.Title>
              <Tag color={detail.status === 'published' ? 'green' : 'default'}>
                {detail.status === 'published' ? `已发布 v${detail.current_version}` : '草稿'}
              </Tag>
              <Button onClick={publish} disabled={!detail.versions.some((v) => !v.is_published)}>
                发布草稿
              </Button>
              <Button onClick={copy}>复制为新模板</Button>
              <Button onClick={exportOne}>导出</Button>
              <Button danger onClick={remove} disabled={!!references?.total}>删除</Button>
              {references?.total ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  被 {references.agents.length} 个 Agent、{references.workflows.length} 个工作流引用，
                  已产出 {references.artifacts} 份
                </Typography.Text>
              ) : null}
            </Space>

            <Tabs
              items={[
                { key: 'editor', label: '编辑与预览',
                  // key 必须带上模板 key 与版本：Editor 的 state 是用 props 初始化的
                  // （useState(draft?.layout ...)），只在**挂载时**生效。不给 key，
                  // 切换模板时组件不会重挂，编辑框里留着的还是上一份模板的布局 ——
                  // 界面上表现为「选了营销战役，看到的却是单维度审查报告的布局」。
                  children: <Editor key={`${detail.key}@${detail.current_version ?? 'draft'}`}
                                    detail={detail}
                                    onSaved={() => void loadDetail(detail.key)} /> },
                { key: 'versions', label: `版本（${detail.versions.length}）`,
                  children: (
                    <Table
                      size="small"
                      rowKey="version"
                      pagination={false}
                      dataSource={detail.versions}
                      columns={[
                        { title: '版本', dataIndex: 'version',
                          render: (v: number) => (
                            <Space>v{v}{v === detail.current_version && <Tag color="green">当前</Tag>}</Space>) },
                        { title: '状态', dataIndex: 'is_published',
                          render: (p: boolean) => (p ? <Tag color="green">已发布</Tag> : <Tag>草稿</Tag>) },
                        { title: '变更说明', dataIndex: 'changelog' },
                        { title: '发布时间', dataIndex: 'published_at' },
                        { title: '', key: 'op',
                          render: (_: unknown, row: { version: number; is_published: boolean }) =>
                            row.is_published && row.version !== detail.current_version ? (
                              <Button size="small" onClick={() => void rollback(row.version)}>回退到此版</Button>
                            ) : null },
                      ]}
                    />
                  ) },
                { key: 'refs', label: '引用反查',
                  children: !references?.total ? <Empty description="还没有任何引用" /> : (
                    <div>
                      <Typography.Title level={5} style={{ fontSize: 13 }}>Agent</Typography.Title>
                      <List size="small" bordered dataSource={references.agents}
                            renderItem={(a) => <List.Item>{a.name} <Typography.Text code>{a.id.slice(0, 8)}</Typography.Text>（版本：{String(a.version ?? 'latest')}）</List.Item>} />
                      <Typography.Title level={5} style={{ fontSize: 13, marginTop: 12 }}>工作流</Typography.Title>
                      {references.workflows.length ? (
                        <List size="small" bordered dataSource={references.workflows}
                              renderItem={(w) => <List.Item>{w.name}</List.Item>} />
                      ) : <Empty description="无" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
                      <Typography.Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
                        已产出制品 {references.artifacts} 份
                      </Typography.Paragraph>
                    </div>
                  ) },
              ]}
            />
          </>
        )}
      </div>

      <Drawer open={createOpen} onClose={() => setCreateOpen(false)} title="新建模板" width={420}>
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="key" label="key（小写字母、数字、连字符）"
                     rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]*$/, message: '只允许小写字母、数字和连字符' }]}>
            <Input placeholder="例如 weekly-report" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="例如 周报" />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <TextArea rows={3} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>创建（草稿）</Button>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10 }}>
            创建后在「编辑与预览」里改布局，确认无误再点「发布草稿」。发布会立刻改变所有引用方的呈现。
          </Typography.Paragraph>
        </Form>
      </Drawer>
    </div>
  )
}