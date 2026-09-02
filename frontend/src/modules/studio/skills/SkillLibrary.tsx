import React, { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd'
import {
  AuditOutlined,
  CheckSquareOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  InboxOutlined,
  SearchOutlined,
  TeamOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { skillApi, type Skill, type SkillFinding, type SkillRevision, type SkillUsage } from '@/api'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth'
import dayjs from 'dayjs'

/** Backend timestamps are UTC (the API stamps them with `Z`). Rendering the raw
 *  string showed 01:37 for something that happened at 10:37 local — dayjs does
 *  the conversion, which is why every other list in Studio goes through it. */
const fmtTime = (v?: string | null) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '—')

/**
 * Render content with every flagged span marked.
 *
 * What a reviewer is being asked is "is THIS line acceptable" — so the answer
 * has to point at the line. Handing over the whole body with a note saying
 * "contains sudo" makes them search a 300-line procedure for it, and the honest
 * outcome of that is approving without looking.
 */
const highlight = (content: string, findings: SkillFinding[]) => {
  const spans = findings
    .flatMap(f => (f.matches || []).map(m => ({ ...m, kind: f.kind })))
    .filter(m => m.end > m.start)
    .sort((a, b) => a.start - b.start)
  if (!spans.length) return content

  const out: React.ReactNode[] = []
  let cursor = 0
  spans.forEach((m, i) => {
    if (m.start < cursor) return          // overlapping hits: keep the first
    if (m.start > cursor) out.push(content.slice(cursor, m.start))
    out.push(
      <mark key={i} title={m.label || m.kind}
        style={{ background: '#ffe58f', padding: '0 2px', borderRadius: 2 }}>
        {content.slice(m.start, m.end)}
      </mark>,
    )
    cursor = m.end
  })
  if (cursor < content.length) out.push(content.slice(cursor))
  return out
}

const { Text, Paragraph } = Typography
const { TextArea } = Input

const TEMPLATE = `---
name: 新技能
summary: 一句话说清它是什么（给人看，列表里显示这句）
description: 什么时候该加载这个技能（给模型看，可以长，堆触发词）
---

## 适用场景

## 步骤

1.
`

/**
 * Skill 库 — the pool agents bind to.
 *
 * Everything that changes a skill goes through here, which is why the table
 * leads with "被绑定" rather than burying it: editing or removing a skill
 * changes the behaviour of every agent bound to it, and the person doing it is
 * otherwise blind to who that is.
 */
const SkillLibrary: React.FC = () => {
  const { t } = useTranslation()

  const [rows, setRows] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<string>('')
  // 选择模式:平时不显示复选框,点「批量操作」才进入 —— 复选框的显示方式
  // 与 MCP 服务器列表一致(常驻列宽,按需渲染),但入口按名字说明模式本身,
  // 因为这里的批量动作有四个,不止导出。
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  // The rows behind those keys, kept separately.
  //
  // `preserveSelectedRowKeys` lets a selection span searches — tick five under
  // one filter, three under another — but `rows` only ever holds the current
  // result. Deriving the targets from `rows` therefore silently dropped
  // everything selected under a previous filter: the button said 8 and the
  // batch touched 3, with no error. Remembering the row when it is ticked is
  // the only way the two numbers can agree.
  const [selectedMap, setSelectedMap] = useState<Record<string, Skill>>({})

  const onSelectChange = (keys: React.Key[], picked: Skill[]) => {
    setSelectedKeys(keys)
    setSelectedMap(prev => {
      const next: Record<string, Skill> = {}
      const seen = new Map(picked.map(r => [r.id, r]))
      for (const k of keys.map(String)) {
        next[k] = seen.get(k) || prev[k] || rows.find(r => r.id === k) as Skill
      }
      return next
    })
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedKeys([])
    setSelectedMap({})
  }

  // Editor drawer
  const [editing, setEditing] = useState<Skill | null>(null)
  const [isNew, setIsNew] = useState(false)
  // A deleted skill opens read-only: its content and history still have to be
  // readable (that is the whole reason delete is soft), but nothing about it
  // can be changed — the backend refuses the write anyway, so offering the
  // fields would only produce an error at the end of a wasted edit.
  const [readOnly, setReadOnly] = useState(false)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [usage, setUsage] = useState<SkillUsage | null>(null)

  // Four-eyes decides which buttons exist, so the page has to know who is
  // looking: you can review someone else's draft, never your own.
  const me = useAuthStore(st => st.user?.id) || ''

  // Review — its own dialog, not a corner of the editor. Reviewing is not
  // editing: what the reviewer needs is what CHANGED, side by side.
  const [reviewOf, setReviewOf] = useState<Skill | null>(null)
  const [reviewLive, setReviewLive] = useState<string>('')
  const [reviewLoading, setReviewLoading] = useState(false)
  // Which queued version is on the table. Several can be waiting, and approving
  // one is a statement about that text specifically — so it is picked, never
  // inferred from "the newest".
  const [reviewVersion, setReviewVersion] = useState<number | null>(null)
  const [reviewDraft, setReviewDraft] = useState<{ content: string; findings: SkillFinding[] } | null>(null)

  // Version history
  const [historyOf, setHistoryOf] = useState<Skill | null>(null)
  const [revisions, setRevisions] = useState<SkillRevision[]>([])
  const [revisionView, setRevisionView] = useState<{ version: number; content: string } | null>(null)

  // Import
  const [importOpen, setImportOpen] = useState(false)
  const [importFiles, setImportFiles] = useState<{ name: string; skills: any[] }[]>([])
  const [importDupes, setImportDupes] = useState<string[]>([])
  const [preview, setPreview] = useState<any>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    try {
      // 待复核 is a property that cuts across statuses, not a status of its own,
      // so it is filtered here rather than being pushed into the status query.
      const reviewOnly = status === '__review'
      const res = await skillApi.list({
        keyword: keyword || undefined,
        status: reviewOnly ? undefined : (status || undefined),
        include_deleted: status === 'deleted',
      })
      setRows((res.items || []).filter(s => !reviewOnly || s.needs_review))
    } catch {
      message.error(t('skill_lib_fetch_failed', '加载正式Skill失败'))
    } finally {
      setLoading(false)
    }
  }, [keyword, status, t])

  useEffect(() => { fetch() }, [fetch])
  // Only a CHANGED FILTER goes back to page 1. Doing it inside fetch() sent the
  // operator to the top after every delete, status flip or batch run — the same
  // "the list moved under me" complaint as the unstable sort, just triggered by
  // their own action instead of a refresh.
  useEffect(() => { setPage(1) }, [keyword, status])

  // ── editor ────────────────────────────────────────────────────────────────

  const openNew = () => {
    setIsNew(true)
    setReadOnly(false)
    setEditing({} as Skill)
    setUsage(null)
    form.setFieldsValue({
      code: '', name: '', summary: '', description: '', category: undefined,
      tags_text: '', tool_sequence_text: '',
      content: TEMPLATE, auto_injectable: false,
    })
  }

  const openEdit = async (row: Skill) => {
    setIsNew(false)
    setReadOnly(row.status === 'deleted')
    setEditing(row)
    setUsage(null)
    try {
      const full = await skillApi.get(row.id)
      setEditing(full)
      setUsage(full.usage || null)
      form.setFieldsValue({
        code: full.code, name: full.name, summary: full.summary,
        description: full.description,
        category: full.category, auto_injectable: full.auto_injectable,
        tags_text: (full.tags || []).join(', '),
        tool_sequence_text: full.tool_sequence?.length
          ? JSON.stringify(full.tool_sequence, null, 2) : '',
        // The last text submitted, not the live one: with a draft queued, an
        // author who opens the editor is coming back to what they wrote. They
        // are the same string whenever nothing is waiting.
        content: full.head_content ?? full.content,
      })
    } catch {
      message.error(t('skill_lib_load_failed', '读取内容失败'))
      setEditing(null)
      setReadOnly(false)
    }
  }

  const save = async () => {
    let values: any
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    // The field holds JSON text; the API takes the parsed array. Validated by
    // the Form rule above, so a parse failure here cannot reach the server.
    const tagsText = String(values.tags_text || '').trim()
    delete values.tags_text
    values.tags = tagsText
      ? tagsText.split(/[,，]/).map(x => x.trim()).filter(Boolean)
      : []

    const seqText = String(values.tool_sequence_text || '').trim()
    const seq = seqText ? JSON.parse(seqText) : null
    delete values.tool_sequence_text
    values.tool_sequence = seq

    setSaving(true)
    try {
      if (isNew) {
        await skillApi.create(values)
        message.success(t('skill_lib_created', '已创建'))
      } else {
        // Only send what changed: core appends a revision whenever `content`
        // is present, so resending an untouched body would inflate the history.
        const patch: any = {}
        for (const k of ['code', 'name', 'summary', 'description', 'category', 'auto_injectable']) {
          if (values[k] !== (editing as any)[k]) patch[k] = values[k]
        }
        // Compare the body against what the editor was opened on — comparing it
        // against the live version would resend an untouched queued draft as a
        // fresh edit every time.
        const base = editing?.head_content ?? editing?.content
        if (values.content !== base) patch.content = values.content
        // Compared as JSON: the field is free text, so whitespace differences
        // would otherwise read as a change on every save.
        const beforeSeq = JSON.stringify(editing?.tool_sequence ?? null)
        if (JSON.stringify(seq) !== beforeSeq) patch.tool_sequence = seq
        if (JSON.stringify(values.tags) !== JSON.stringify(editing?.tags ?? []))
          patch.tags = values.tags
        if (Object.keys(patch).length === 0) {
          message.info(t('skill_lib_no_change', '没有改动'))
          setSaving(false)
          return
        }
        const saved = await skillApi.update(editing!.id, patch)
        if (saved.needs_review) {
          // Saying only "已保存" would leave the author thinking it is live.
          message.warning(t('skill_lib_saved_pending',
            '已保存,但内容触发了告警 —— 需要另一个人复核通过后才会生效,当前 agent 仍在用上一版'), 6)
        } else {
          message.success(t('skill_lib_saved', '已保存'))
        }
      }
      setEditing(null)
      fetch()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_save_failed', '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  // ── status / delete ───────────────────────────────────────────────────────

  const toggleStatus = async (row: Skill) => {
    const next = row.status === 'active' ? 'disabled' : 'active'
    try {
      await skillApi.setStatus(row.id, next)
      message.success(next === 'active'
        ? t('skill_lib_enabled', '已启用')
        : t('skill_lib_disabled', '已停用,绑定关系保留'))
      fetch()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_status_failed', '操作失败'))
    }
  }

  /**
   * Delete always asks first, and the question names the agents that lose the
   * skill. They do not error afterwards — they just quietly stop having the
   * capability, which is the hardest kind of regression to trace back.
   */
  const confirmDelete = async (row: Skill) => {
    let u: SkillUsage | null = null
    try { u = await skillApi.usage(row.id) } catch { /* fall through to a plain confirm */ }

    const names = (u?.agents || []).filter(a => a.is_active).map(a => a.name)
    Modal.confirm({
      title: t('skill_lib_delete_title', { defaultValue: '删除「{{name}}」?', name: row.name }),
      width: 520,
      content: (
        <div>
          {names.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('skill_lib_delete_impact', { defaultValue: '{{count}} 个 agent 正在使用它', count: names.length })}
              description={
                <>
                  <div>{names.join(' · ')}</div>
                  <div style={{ marginTop: 6 }}>
                    {t('skill_lib_delete_impact_note',
                      '删除后会先解除这些绑定,它们从下一个任务起不再具备该能力,且不会报错。')}
                  </div>
                </>
              }
            />
          ) : (
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={t('skill_lib_delete_no_impact', '当前没有 agent 绑定它')} />
          )}
          <Text type="secondary">
            {t('skill_lib_delete_soft',
              '软删除:内容和版本历史仍可查询,但不可恢复。')}
          </Text>
        </div>
      ),
      okText: t('skill_lib_delete_ok', '解除绑定并删除'),
      okButtonProps: { danger: true },
      cancelText: t('common_cancel', '取消'),
      onOk: async () => {
        try {
          const res = await skillApi.delete(row.id)
          message.success(res.unbound.length
            ? t('skill_lib_deleted_unbound', { defaultValue: '已删除,并解除了 {{count}} 个绑定', count: res.unbound.length })
            : t('skill_lib_deleted', '已删除'))
          fetch()
        } catch (e: any) {
          // Without this the rejection is swallowed and the dialog just closes,
          // leaving the row on screen and the operator assuming it worked.
          message.error(e?.response?.data?.detail || t('skill_lib_delete_failed', '删除失败'))
          throw e   // keeps the dialog open
        }
      },
    })
  }

  const openReview = async (row: Skill, opts?: { mine?: boolean }) => {
    setReviewOf(row)
    setReviewLive('')
    setReviewDraft(null)
    setReviewVersion(null)
    setReviewLoading(true)
    try {
      const [full, live] = await Promise.all([
        skillApi.get(row.id),
        row.active_version
          ? skillApi.revision(row.id, row.active_version).catch(() => null)
          : Promise.resolve(null),
      ])
      setReviewOf(full)
      setReviewLive(live?.content || '')
      const queued = full.pending || []
      // Open on what the caller came to do: 复核 lands on the newest draft this
      // person can actually decide, 我的待复核 on their own. Opening on your own
      // draft from the 复核 button would show a dialog whose every button is
      // refused. The list row only carries the authors, not the versions, so
      // the choice is made here, once the detail is in hand.
      const pick = opts?.mine
        ? queued.find(p => p.author_id === me)?.version
        : (queued.find(p => p.author_id !== me)?.version ?? queued[0]?.version)
      if (pick != null) await loadDraft(full.id, pick)
    } catch {
      message.error(t('skill_lib_review_load_failed', '读取待复核内容失败'))
      setReviewOf(null)
    } finally {
      setReviewLoading(false)
    }
  }

  const loadDraft = async (skillId: string, version: number) => {
    setReviewVersion(version)
    setReviewDraft(null)
    try {
      const rev = await skillApi.revision(skillId, version)
      setReviewDraft({ content: rev.content, findings: rev.findings || [] })
    } catch {
      message.error(t('skill_lib_review_load_failed', '读取待复核内容失败'))
    }
  }

  const approveReview = async (row: Skill, version: number) => {
    try {
      await skillApi.approveReview(row.id, version)
      message.success(t('skill_lib_review_approved', { defaultValue: 'v{{version}} 已通过复核,开始生效', version: version }))
      setEditing(null)
      setReviewOf(null)
      fetch()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_review_failed', '复核失败'))
    }
  }

  const rejectReview = (row: Skill, version: number) => {
    let reason = ''
    Modal.confirm({
      title: t('skill_lib_reject_title', { defaultValue: '驳回「{{name}}」的 v{{version}}?', name: row.name, version: version }),
      content: (
        <div>
          <Paragraph type="secondary">
            {t('skill_lib_reject_note', { defaultValue: '这一版从未生效过,驳回只是让它不再能生效 —— agent 继续用 v{{active}},正文留在版本历史里。', active: row.active_version })}
          </Paragraph>
          <Input.TextArea
            rows={3}
            placeholder={t('skill_lib_reject_reason', '驳回理由(会记入版本历史)')}
            onChange={e => { reason = e.target.value }}
          />
        </div>
      ),
      okText: t('skill_lib_reject_ok', '驳回'),
      okButtonProps: { danger: true },
      cancelText: t('common_cancel', '取消'),
      onOk: async () => {
        try {
          await skillApi.rejectReview(row.id, version, reason)
          message.success(t('skill_lib_rejected', '已驳回'))
          setEditing(null)
          setReviewOf(null)
          fetch()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('skill_lib_review_failed', '复核失败'))
          throw e
        }
      },
    })
  }

  // Withdrawing your own draft is not a hole in four-eyes: it removes a change
  // rather than enabling one. Without it an author who spots their own mistake
  // has to ask a colleague to formally reject it.
  const withdrawReview = (row: Skill, version: number) => {
    Modal.confirm({
      title: t('skill_lib_withdraw_title', { defaultValue: '撤回自己提交的 v{{version}}?', version: version }),
      content: t('skill_lib_withdraw_note', { defaultValue: '撤回后它不再等待复核,也不会再生效;正文留在版本历史里。agent 当前用的 v{{active}} 不受影响。', active: row.active_version }),
      okText: t('skill_lib_withdraw_ok', '撤回'),
      cancelText: t('common_cancel', '取消'),
      onOk: async () => {
        try {
          await skillApi.withdrawReview(row.id, version)
          message.success(t('skill_lib_withdrawn', '已撤回'))
          setReviewOf(null)
          fetch()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('skill_lib_withdraw_failed', '撤回失败'))
          throw e
        }
      },
    })
  }

  // ── history ───────────────────────────────────────────────────────────────

  const openHistory = async (row: Skill) => {
    setHistoryOf(row)
    setRevisions([])
    try {
      const res = await skillApi.revisions(row.id)
      setRevisions(res.items || [])
    } catch {
      message.error(t('skill_lib_history_failed', '读取版本历史失败'))
    }
  }

  const doRollback = (row: Skill, version: number) => {
    Modal.confirm({
      title: t('skill_lib_rollback_title', { defaultValue: '回滚到 v{{version}}?', version: version }),
      content: t('skill_lib_rollback_note',
        '会用该版本的内容生成一个新版本,历史不会被覆盖。'),
      okText: t('skill_lib_rollback_ok', '回滚'),
      cancelText: t('common_cancel', '取消'),
      onOk: async () => {
        try {
          await skillApi.rollback(row.id, version)
          message.success(t('skill_lib_rolled_back', '已回滚'))
          setHistoryOf(null)
          fetch()
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('skill_lib_rollback_failed', '回滚失败'))
          throw e
        }
      },
    })
  }

  /** Copy whatever is in the editor right now — including unsaved edits, since
   *  that is what the person is looking at. */
  const copyContent = async () => {
    const text = form.getFieldValue('content') || ''
    try {
      await navigator.clipboard.writeText(text)
      message.success(t('skill_lib_copied', '已复制'))
    } catch {
      // Clipboard access needs a secure context; say so rather than failing mute.
      message.error(t('skill_lib_copy_failed', '复制失败,请手动选中复制'))
    }
  }

  const download = (payload: any, filename: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectedRows = (): Skill[] =>
    selectedKeys.map(k => selectedMap[String(k)]).filter(Boolean)

  /**
   * Run one operation across the selection, reporting per-row failures.
   *
   * Sequential, not Promise.all: these are writes, and a partial failure has to
   * name which rows landed and which did not. Firing them all at once would
   * make "3 succeeded, 2 failed" impossible to attribute.
   */
  const runBatch = async (
    targets: Skill[],
    op: (s: Skill) => Promise<unknown>,
    okMsg: (n: number) => string,
  ) => {
    const failed: string[] = []
    let ok = 0
    for (const s of targets) {
      try { await op(s); ok += 1 } catch { failed.push(s.code) }
    }
    if (ok) message.success(okMsg(ok))
    if (failed.length) {
      message.error(t('skill_lib_batch_failed', { defaultValue: '{{count}} 条失败:{{items}}', count: failed.length, items: failed.join('、') }))
    }
    exitSelectMode()
    fetch()
  }

  const batchSetStatus = (next: 'active' | 'disabled') => {
    const all = selectedRows()
    const targets = all.filter(r => r.status !== 'deleted' && r.status !== next)
    if (!targets.length) {
      message.info(t('skill_lib_batch_noop', '选中的 skill 都已经是这个状态了'))
      return
    }
    // Say what is being left out. Acting on 3 of the 5 you ticked without a
    // word is how someone walks away believing all five changed.
    if (targets.length < all.length) {
      message.info(t('skill_lib_batch_skipped', { defaultValue: '选中 {{total}} 条,其中 {{skipped}} 条已是该状态或已删除,将跳过', total: all.length, skipped: all.length - targets.length }))
    }
    runBatch(
      targets,
      s => skillApi.setStatus(s.id, next),
      n => next === 'active'
        ? t('skill_lib_batch_enabled', { defaultValue: '已启用 {{count}} 条', count: n })
        : t('skill_lib_batch_disabled', { defaultValue: '已停用 {{count}} 条,绑定关系保留', count: n }),
    )
  }

  /**
   * Batch delete. The confirmation leads with the combined impact — the counts
   * are already on the loaded rows, so it costs nothing to be specific, and
   * "12 个 agent 会受影响" is the only number that should decide this.
   */
  const batchDelete = () => {
    const all = selectedRows()
    const targets = all.filter(r => r.status !== 'deleted')
    if (!targets.length) {
      message.info(t('skill_lib_batch_all_deleted', '选中的 skill 都已经是删除状态'))
      return
    }
    const skipped = all.length - targets.length
    const affected = targets.reduce((n, r) => n + (r.usage?.active_count || 0), 0)
    const bound = targets.filter(r => (r.usage?.active_count || 0) > 0)

    Modal.confirm({
      title: t('skill_lib_batch_delete_title', { defaultValue: '删除选中的 {{count}} 条 skill?', count: targets.length }),
      width: 560,
      content: (
        <div>
          {skipped > 0 && (
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={t('skill_lib_batch_delete_skipped', { defaultValue: '另有 {{count}} 条已经是删除状态,不在本次操作内', count: skipped })} />
          )}
          {affected > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={t('skill_lib_batch_delete_impact', { defaultValue: '其中 {{count}} 条正在被使用,共影响 {{affected}} 个 agent 绑定', count: bound.length, affected: affected })}
              description={
                <>
                  <div>{bound.map(r => `${r.name}(${r.usage?.active_count})`).join(' · ')}</div>
                  <div style={{ marginTop: 6 }}>
                    {t('skill_lib_delete_impact_note',
                      '删除后会先解除这些绑定,它们从下一个任务起不再具备该能力,且不会报错。')}
                  </div>
                </>
              }
            />
          ) : (
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={t('skill_lib_batch_delete_no_impact', '选中的 skill 都没有 agent 绑定')} />
          )}
          <Text type="secondary">
            {t('skill_lib_delete_soft',
              '软删除:内容和版本历史仍可查询,但不可恢复。')}
          </Text>
        </div>
      ),
      okText: t('skill_lib_batch_delete_ok', { defaultValue: '删除 {{count}} 条', count: targets.length }),
      okButtonProps: { danger: true },
      cancelText: t('common_cancel', '取消'),
      onOk: () => runBatch(
        targets,
        s => skillApi.delete(s.id),
        n => t('skill_lib_batch_deleted', { defaultValue: '已删除 {{count}} 条', count: n }),
      ),
    })
  }

  /** Export exactly what is ticked. Use the header checkbox to take everything.
   *
   *  Two formats, one entry point. JSON is the one that imports back through
   *  this page; the zip is the file form — `<code>/SKILL.md`, the same layout
   *  the repo's `skills/` has — for putting skills back into a checkout. */
  const exportSelected = async (format: 'json' | 'md' = 'json') => {
    const ids = selectedKeys.map(String)
    if (!ids.length) return
    const stamp = new Date().toISOString().slice(0, 10)
    try {
      if (format === 'md') {
        const blob = await skillApi.exportFiles({ ids })
        // One skill comes back as the file itself; several come back zipped,
        // because a browser cannot be handed more than one at a time.
        const one = ids.length === 1 ? selectedRows()[0] : null
        saveBlob(blob as any,
          one ? `${one.code}.md` : `skills-${ids.length}-${stamp}.zip`)
      } else {
        download(await skillApi.export({ ids }), `skills-${ids.length}-${stamp}.json`)
      }
      exitSelectMode()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_export_failed', '导出失败'))
    }
  }

  // ── import ────────────────────────────────────────────────────────────────

  /**
   * Merge the selected files into one import set, keyed by code.
   *
   * A code appearing in two files is not an error — exports overlap all the
   * time — but it IS something to say out loud, because only one of the two
   * bodies survives. Last file wins, and the collision is reported so nobody
   * has to guess which version landed.
   */
  const mergeFiles = (files: { name: string; skills: any[] }[]) => {
    const byCode = new Map<string, any>()
    const dupes: string[] = []
    for (const f of files) {
      for (const s of f.skills) {
        const code = s?.code
        if (!code) continue
        if (byCode.has(code)) dupes.push(code)
        byCode.set(code, s)
      }
    }
    return { skills: [...byCode.values()], dupes: [...new Set(dupes)] }
  }

  const refreshPreview = async (files: { name: string; skills: any[] }[]) => {
    const { skills, dupes } = mergeFiles(files)
    setImportDupes(dupes)
    if (!skills.length) { setPreview(null); return }
    try {
      setPreview(await skillApi.import({ skills, dry_run: true }))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_import_failed', '预览失败'))
    }
  }

  /**
   * Read a batch of chosen files and immediately run the dry-run.
   *
   * The preview is not an extra step the user has to remember — picking files
   * is the whole gesture, and what follows is a report, not a write.
   */
  const acceptFiles = async (batch: File[]) => {
    const accepted: { name: string; skills: any[] }[] = []
    // .md files are read server-side: their metadata block is YAML, and the
    // rule for reading it has to be the one the seed and the executor use.
    // Everything after this point is identical for both formats.
    const mdFiles = batch.filter(f => /\.(md|markdown)$/i.test(f.name))
    if (mdFiles.length) {
      try {
        const res = await skillApi.parseImportFiles(mdFiles)
        if (res.skipped?.length) {
          message.warning(t('skill_lib_import_md_skipped', { defaultValue: '{{count}} 个文件的文件名不能作为标识,已跳过:{{items}}', count: res.skipped.length, items: res.skipped.join('、') }))
        }
        res.skills.forEach((sk: any) => {
          accepted.push({ name: `${sk.code}.md`, skills: [sk] })
        })
      } catch (e: any) {
        message.error(e?.response?.data?.detail
          || t('skill_lib_import_bad_md', 'md 文件解析失败'))
      }
    }
    for (const file of batch) {
      if (/\.(md|markdown)$/i.test(file.name)) continue
      let parsed: any
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        message.error(t('skill_lib_import_bad_json', { defaultValue: '{{name}} 不是合法的 JSON,已跳过', name: file.name }))
        continue
      }
      const skills = Array.isArray(parsed) ? parsed : parsed.skills
      if (!Array.isArray(skills)) {
        message.error(t('skill_lib_import_no_skills', { defaultValue: '{{name}} 里没有 skills 数组,已跳过', name: file.name }))
        continue
      }
      accepted.push({ name: file.name, skills })
    }
    if (!accepted.length) return
    // Re-picking the same file replaces it rather than doubling it up.
    const next = [
      ...importFiles.filter(f => !accepted.some(a => a.name === f.name)),
      ...accepted,
    ]
    setImportFiles(next)
    await refreshPreview(next)
  }

  const dropFile = async (name: string) => {
    const next = importFiles.filter(f => f.name !== name)
    setImportFiles(next)
    await refreshPreview(next)
  }

  const runImport = async () => {
    const { skills } = mergeFiles(importFiles)
    if (!skills.length) return
    try {
      const res = await skillApi.import({ skills })
      message.success(t('skill_lib_imported', { defaultValue: '新增 {{created}} 条,更新 {{updated}} 条', created: res.created.length, updated: res.updated.length }))
      if (res.failed?.length) {
        message.warning(t('skill_lib_import_partial', { defaultValue: '{{count}} 条失败,详见预览', count: res.failed.length }))
      }
      setImportOpen(false)
      setImportFiles([])
      setImportDupes([])
      setPreview(null)
      fetch()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('skill_lib_import_failed', '导入失败'))
    }
  }

  // ── table ─────────────────────────────────────────────────────────────────

  const columns = [
    {
      title: t('skill_lib_col_name', '名称'),
      dataIndex: 'name',
      // No defaultSortOrder: the table renders exactly the order the API
      // returned (code ascending). Setting a client-side default meant two
      // orderings for the same list — MySQL's collation and JS localeCompare
      // disagree on digits, hyphens and underscores — so the rows the server
      // sent and the rows on screen were sorted by different rules.
      sorter: (a: Skill, b: Skill) => a.code.localeCompare(b.code),
      render: (_: any, r: Skill) => (
        <Space direction="vertical" size={0}>
          <a onClick={() => openEdit(r)}>{r.name}</a>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.code}</Text>
          {/* The one-line summary, not `description`: that one is written for
              the model, averages 101 characters and runs to 597 — it does not
              fit a table cell and was never meant to. No fallback when it is
              empty: a blank here is how you find the rows still to write. */}
          {r.summary && (
            <Text type="secondary" style={{ fontSize: 12, color: '#4b5563' }}>{r.summary}</Text>
          )}
        </Space>
      ),
    },
    {
      title: t('skill_lib_col_category', '分类'),
      dataIndex: 'category',
      width: 110,
      sorter: (a: Skill, b: Skill) => (a.category || '').localeCompare(b.category || ''),
      render: (v: string) => v ? <Tag>{v}</Tag> : <Text type="secondary">—</Text>,
    },
    {
      title: (
        <Tooltip title={t('skill_lib_col_bound_tip', '有多少 agent 绑定了它 —— 改动会影响这些 agent')}>
          <Space size={4}><TeamOutlined />{t('skill_lib_col_bound', '被绑定')}</Space>
        </Tooltip>
      ),
      width: 110,
      align: 'right' as const,
      sorter: (a: Skill, b: Skill) =>
        (a.usage?.active_count || 0) - (b.usage?.active_count || 0),
      render: (_: any, r: Skill) => {
        const n = r.usage?.active_count
        return n === undefined
          ? <Text type="secondary">—</Text>
          : <Tag color={n > 0 ? 'blue' : undefined}>{n}</Tag>
      },
    },
    {
      title: t('skill_lib_col_origin', '来源'),
      dataIndex: 'origin',
      width: 110,
      render: (v: string, r: Skill) => {
        const label: Record<string, string> = {
          manual: t('skill_lib_origin_manual', '人工'),
          agent: t('skill_lib_origin_agent', 'agent 提交'),
          auto: t('skill_lib_origin_auto', '来自 Auto'),
          import: t('skill_lib_origin_import', '导入'),
        }
        return <Tag color={r.origin === 'auto' ? 'orange' : undefined}>{label[v] || v}</Tag>
      },
    },
    {
      title: (
        <Tooltip title={t('skill_lib_col_auto_tip',
          '打开后,不经绑定即可注入所有接受自动注入的 agent')}>
          {t('skill_lib_col_auto', '自动注入')}
        </Tooltip>
      ),
      dataIndex: 'auto_injectable',
      width: 100,
      render: (v: boolean) => v
        ? <Tag color="purple">{t('skill_lib_auto_on', '开')}</Tag>
        : <Text type="secondary">—</Text>,
    },
    {
      title: t('skill_lib_col_status', '状态'),
      dataIndex: 'status',
      width: 100,
      render: (v: string, r: Skill) => (
        <Space direction="vertical" size={2}>
          {v === 'active' && <Tag color="green">{t('skill_lib_status_active', '启用')}</Tag>}
          {v === 'disabled' && <Tag>{t('skill_lib_status_disabled', '停用')}</Tag>}
          {v === 'deleted' && <Tag color="red">{t('skill_lib_status_deleted', '已删除')}</Tag>}
          {r.needs_review && (
            <Tooltip title={t('skill_lib_pending_tip', {
              defaultValue: '{{authors}} 提交的版本在等复核,agent 仍在用 v{{active}}',
              authors: (r.pending_authors || []).join('、') || '?',
              active: r.active_version,
            })}>
              <Tag color="orange">{t('skill_lib_pending_tag', '待复核')}</Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('skill_lib_col_updated', '更新时间'),
      dataIndex: 'updated_at',
      width: 160,
      sorter: (a: Skill, b: Skill) => (a.updated_at || '').localeCompare(b.updated_at || ''),
      render: (v: string, r: Skill) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}>{fmtTime(v)}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            v{r.version}{r.updated_by ? ` · ${r.updated_by}` : ''}
          </Text>
        </Space>
      ),
    },
    {
      title: t('skill_lib_col_actions', '操作'),
      width: 300,
      // Last column, so it sits against the table edge rather than floating in
      // the middle of the leftover space.
      align: 'right' as const,
      render: (_: any, r: Skill) => r.status === 'deleted' ? (
        <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => openHistory(r)}>
          {t('skill_lib_history', '版本历史')}
        </Button>
      ) : (
        <Space size={0}>
          {/* Only what this person can actually do. Offering 复核 on your own
              draft is a button that always fails — the refusal belongs in the
              service, but the operator should not be sent at it. */}
          {(r.pending_author_ids || []).some(a => a !== me) && (
            <Button size="small" type="link" style={{ color: '#d46b08' }}
              icon={<AuditOutlined />} onClick={() => openReview(r)}>
              {t('skill_lib_review', '复核')}
            </Button>
          )}
          {(r.pending_author_ids || []).includes(me) && (
            <Button size="small" type="link" onClick={() => openReview(r, { mine: true })}>
              {t('skill_lib_my_pending', '我的待复核')}
            </Button>
          )}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            {t('skill_lib_edit', '编辑')}
          </Button>
          <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => openHistory(r)}>
            {t('skill_lib_history', '版本历史')}
          </Button>
          <Button size="small" type="link" onClick={() => toggleStatus(r)}>
            {r.status === 'active'
              ? t('skill_lib_disable', '停用')
              : t('skill_lib_enable', '启用')}
          </Button>
          <Button size="small" type="link" danger icon={<DeleteOutlined />}
            onClick={() => confirmDelete(r)}>
            {t('skill_lib_delete', '删除')}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder={t('skill_lib_search', '按名称、标识或描述搜索')}
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onPressEnter={fetch}
            style={{ width: 300 }}
            prefix={<SearchOutlined />}
            allowClear
          />
          <Select
            value={status}
            onChange={setStatus}
            style={{ width: 150 }}
            // 「全部」rather than listing the statuses it covers: a new status
            // should join it without anyone editing this label. 已删除 stays a
            // separate choice — it is a hidden lifecycle state, not one more
            // status you would want mixed into the working list.
            options={[
              { value: '', label: t('skill_lib_filter_all', '全部') },
              { value: 'active', label: t('skill_lib_status_active', '启用') },
              { value: 'disabled', label: t('skill_lib_status_disabled', '停用') },
              { value: 'deleted', label: t('skill_lib_status_deleted', '已删除') },
              { value: '__review', label: t('skill_lib_filter_review', '待复核') },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={fetch} />
          <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
            {t('skill_lib_new', '新建 Skill')}
          </Button>
          <Button icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>
            {t('skill_lib_import', '导入')}
          </Button>
          {selectMode ? (
            <>
              {/* One export entry, two formats. A second button elsewhere for
                  the file form would leave the page with two things called
                  "export" that produce different artifacts. */}
              <Dropdown.Button
                type="primary"
                icon={<DownOutlined />}
                disabled={selectedKeys.length === 0}
                onClick={() => exportSelected('json')}
                menu={{
                  items: [
                    {
                      key: 'json',
                      label: t('skill_lib_export_json', 'JSON —— 可从本页导回'),
                      onClick: () => exportSelected('json'),
                    },
                    {
                      key: 'md',
                      label: t('skill_lib_export_md', 'SKILL.md —— 按目录打包成 zip'),
                      onClick: () => exportSelected('md'),
                    },
                  ],
                }}
              >
                <DownloadOutlined />
                {t('skill_lib_export_selected', '导出所选')}
                {selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
              </Dropdown.Button>
              {/* All four stay put and go disabled together. Showing or hiding
                  them as the selection changes made the toolbar jump on every
                  tick — a stable row of buttons that greys out reads far
                  quieter than one that rearranges itself. */}
              <Divider type="vertical" />
              <Button disabled={!selectedKeys.length} onClick={() => batchSetStatus('disabled')}>
                {t('skill_lib_batch_disable', '批量停用')}
              </Button>
              <Button disabled={!selectedKeys.length} onClick={() => batchSetStatus('active')}>
                {t('skill_lib_batch_enable', '批量启用')}
              </Button>
              <Button danger disabled={!selectedKeys.length} icon={<DeleteOutlined />} onClick={batchDelete}>
                {t('skill_lib_batch_delete', '批量删除')}
              </Button>
              <Button onClick={exitSelectMode}>{t('common_cancel', '取消')}</Button>
            </>
          ) : (
            // The entry names the MODE, not one of the actions inside it.
            // Calling it 「导出」 (as the MCP list does, where export is the only
            // batch action) would put 停用 / 启用 / 删除 behind a button that
            // says nothing about them.
            <Tooltip title={t('skill_lib_batch_tip', '勾选若干条后可导出、停用、启用或删除;表头可全选')}>
              <Button icon={<CheckSquareOutlined />} onClick={() => setSelectMode(true)}>
                {t('skill_lib_batch_mode', '批量操作')}
              </Button>
            </Tooltip>
          )}
        </Space>
      </Card>

      {/* Card wrapper, matching the 自悟Skill tab — without it the first column
          sits flush against the page edge. */}
      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          columns={columns as any}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: onSelectChange as any,
            // Survives paging and filtering, so a selection built across a few
            // searches still exports as one file.
            preserveSelectedRowKeys: true,
            // The column keeps its width outside select mode and simply renders
            // nothing, so entering the mode does not shift every other column.
            hideSelectAll: !selectMode,
            renderCell: selectMode ? undefined : () => null,
          }}
          pagination={{
            // `pageSize` was passed as a bare constant, which makes it a
            // controlled prop with nothing driving it — the size changer moved
            // and the table ignored it. Both page and size live in state now.
            current: page,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showTotal: total => t('skill_lib_total', { defaultValue: '共 {{count}} 条', count: total }),
          }}
          locale={{ emptyText: <Empty description={t('skill_lib_empty', '正式Skill 还是空的')} /> }}
        />
      </Card>

      {/* ── editor ─────────────────────────────────────────────────────── */}
      <Drawer
        open={!!editing}
        width={860}
        onClose={() => setEditing(null)}
        title={isNew
          ? t('skill_lib_new', '新建 Skill')
          : readOnly
            ? t('skill_lib_view_title', { defaultValue: '查看 — {{name}}', name: editing?.name })
            : t('skill_lib_edit_title', { defaultValue: '编辑 — {{name}}', name: editing?.name })}
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>
              {readOnly ? t('common_close', '关闭') : t('common_cancel', '取消')}
            </Button>
            {!readOnly && (
              <Button type="primary" loading={saving} onClick={save}>
                {t('common_save', '保存')}
              </Button>
            )}
          </Space>
        }
      >
        {/* Informational, with one way through to the review dialog. Deciding a
            version means picking one and reading its text — doing that from a
            banner would be a second, thinner copy of the same screen. */}
        {!!editing?.pending?.length && !isNew && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t('skill_lib_pending_review', { defaultValue: '{{count}} 个版本待复核 —— agent 当前仍在使用 v{{active}}', count: editing.pending.length, active: editing.active_version })}
            description={
              <>
                <div style={{ marginBottom: 8 }}>
                  {editing.pending.map(p => (
                    <div key={p.version}>
                      <Text>v{p.version}</Text>
                      <Text type="secondary" style={{ marginLeft: 8 }}>
                        {p.author || '—'}
                        {p.author_id === me ? t('skill_lib_review_is_me', '(我)') : ''}
                        {' · '}{(p.findings || []).map(f => f.detail).join('、')}
                      </Text>
                    </div>
                  ))}
                </div>
                <Button
                  size="small"
                  icon={<AuditOutlined />}
                  onClick={() => {
                    const row = editing
                    setEditing(null)
                    openReview(row, { mine: !editing.pending!.some(p => p.author_id !== me) })
                  }}
                >
                  {t('skill_lib_goto_review', '去复核')}
                </Button>
              </>
            }
          />
        )}

        {readOnly && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            // Only what the rest of the UI cannot already say. That it is
            // deleted and read-only is visible from the title and the disabled
            // form; when it happened and who lost a binding is not.
            message={t('skill_lib_deleted_at', { defaultValue: '已于 {{time}} 删除', time: fmtTime(editing?.deleted_at) })}
            description={
              editing?.deleted_bindings?.length
                ? t('skill_lib_deleted_unbound_list', { defaultValue: '解除了 {{count}} 个绑定:{{items}}', count: editing.deleted_bindings.length, items: editing.deleted_bindings.map(b => b.agent_name).join('、') })
                : undefined
            }
          />
        )}
        {!isNew && usage && usage.active_count > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={t('skill_lib_edit_impact', { defaultValue: '{{count}} 个 agent 正在使用它', count: usage.active_count })}
            description={
              <>
                <div>{usage.agents.filter(a => a.is_active).map(a => a.name).join(' · ')}</div>
                {usage.inactive_count > 0 && (
                  <div style={{ marginTop: 4 }}>
                    {t('skill_lib_edit_impact_inactive', { defaultValue: '另有 {{count}} 个已停用的 agent 绑定 —— 它们被重新启用时会用上这里的改动', count: usage.inactive_count })}
                  </div>
                )}
              </>
            }
          />
        )}

        <Form form={form} layout="vertical" disabled={readOnly}>
          <Space align="start" style={{ width: '100%' }} size={16}>
            <Form.Item
              name="code"
              label={t('skill_lib_field_code', '标识')}
              rules={[
                { required: true, message: t('skill_lib_code_required', '必填') },
                {
                  pattern: /^[a-z0-9][a-z0-9._-]*$/,
                  message: t('skill_lib_code_pattern', '小写字母、数字、点、下划线、连字符,首字符是字母或数字'),
                },
              ]}
              style={{ width: 300 }}
            >
              <Input placeholder="elasticsearch-ops" />
            </Form.Item>
            <Form.Item name="name" label={t('skill_lib_field_name', '名称')}
              rules={[{ required: true, message: t('skill_lib_name_required', '必填') }]}
              style={{ width: 300 }}>
              <Input />
            </Form.Item>
            <Form.Item name="category" label={t('skill_lib_field_category', '分类')} style={{ width: 160 }}>
              <Input allowClear />
            </Form.Item>
          </Space>

          {/* Two texts, two readers, and now exactly one box each. `summary` is
              the line a person reads in the list and the skill picker;
              `description` is what the model is given, and it stopped living in
              the body when the frontmatter moved into columns — leaving it with
              no input at all until this went back. */}
          <Form.Item name="summary" label={t('skill_lib_field_summary', '简介')}>
            <Input maxLength={255} showCount />
          </Form.Item>

          <Form.Item
            name="auto_injectable"
            label={
              <Space size={4}>
                {t('skill_lib_field_auto', '允许自动注入')}
                <Tooltip title={t('skill_lib_auto_help',
                  '打开后,不经绑定即可注入所有接受自动注入的 agent')}>
                  <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
                </Tooltip>
              </Space>
            }
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>

          {/* The one frontmatter key the executor acts on, so it gets a field.
              JSON rather than a step builder: five skills use it, the shape is
              small, and a bespoke editor would be more code than the thing it
              edits. Validated on save — a malformed constraint would otherwise
              be discovered only when an agent silently stopped honouring it. */}
          <Form.Item
            name="tags_text"
            label={
              <Space size={4}>
                {t('skill_lib_field_tags', '标签')}
                <Tooltip title={t('skill_lib_tags_help',
                  '只用于本页检索,不进提示词。逗号分隔')}>
                  <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
                </Tooltip>
              </Space>
            }
          >
            <Input placeholder="餐厅推荐, 美食, 出行" />
          </Form.Item>

          <Form.Item
            name="description"
            label={
              <Space size={4}>
                {t('skill_lib_field_desc', '描述')}
                <Tooltip title={t('skill_lib_desc_help',
                  '随技能一起进入提示词,模型据此判断何时按它执行')}>
                  <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
                </Tooltip>
              </Space>
            }
          >
            <TextArea autoSize={{ minRows: 2, maxRows: 8 }} />
          </Form.Item>

          <Form.Item
            name="tool_sequence_text"
            label={
              <Space size={4}>
                {t('skill_lib_field_seq', '工具顺序约束')}
                <Tooltip title={t('skill_lib_seq_help',
                  '规定第几步必须调用哪个工具,留空表示不限制')}>
                  <QuestionCircleOutlined style={{ color: '#8c8c8c' }} />
                </Tooltip>
              </Space>
            }
            rules={[{
              validator: (_, v) => {
                if (!v || !String(v).trim()) return Promise.resolve()
                try {
                  const parsed = JSON.parse(String(v))
                  if (!Array.isArray(parsed)) {
                    return Promise.reject(new Error(t('skill_lib_seq_not_array',
                      '要是一个数组,例如 [{"step": 1, "required_tool": "get_location"}]')))
                  }
                  for (const item of parsed) {
                    if (!item || typeof item !== 'object' || !item.required_tool) {
                      return Promise.reject(new Error(t('skill_lib_seq_shape',
                        '每一项都要有 step 和 required_tool')))
                    }
                  }
                  return Promise.resolve()
                } catch {
                  return Promise.reject(new Error(t('skill_lib_seq_bad_json', 'JSON 格式不对')))
                }
              },
            }]}
          >
            <TextArea
              autoSize={{ minRows: 2, maxRows: 10 }}
              placeholder={'[{"step": 1, "required_tool": "get_location"}]'}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Form.Item>

          <Form.Item
            name="content"
            label={
              <Space size={4}>
                {t('skill_lib_field_content', 'Skill 正文')}
                <Button
                  type="link"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={copyContent}
                  style={{ padding: '0 4px', height: 'auto' }}
                >
                  {t('skill_lib_copy', '复制')}
                </Button>
              </Space>
            }
            extra={t('skill_lib_content_help',
              '开头的 YAML frontmatter 会被执行器解析;写坏了保存会被拒绝')}
            rules={[{ required: true, message: t('skill_lib_content_required', '必填') }]}
          >
            <TextArea rows={20} style={{ fontFamily: 'monospace', fontSize: 13 }} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* ── history ────────────────────────────────────────────────────── */}
      <Modal
        open={!!historyOf}
        title={t('skill_lib_history_title', { defaultValue: '版本历史 — {{name}}', name: historyOf?.name })}
        width={720}
        onCancel={() => setHistoryOf(null)}
        footer={null}
      >
        <Table
          rowKey="version"
          size="small"
          dataSource={revisions}
          pagination={false}
          columns={[
            {
              title: t('skill_lib_rev_version', '版本'),
              dataIndex: 'version',
              width: 130,
              // Which one agents actually run. Without it the newest row reads
              // as the live one, which is exactly wrong while a version is held
              // back for review.
              render: (v: number) => (
                <Space size={4}>
                  <span>v{v}</span>
                  {/* active_version 在删除后仍留在记录上,所以不能只看它 —— 已删除的
                      skill 没有任何版本在生效。但仍要标出删之前跑的是哪一版:一个版本
                      可能卡在待复核,最新一行并不等于最后生效的那一行,而看已删 skill 的
                      历史通常就是为了导出正确的那一版。 */}
                  {v === historyOf?.active_version && (
                    historyOf?.status === 'deleted' ? (
                      <Tooltip title={t('skill_lib_rev_was_live_tip',
                        'Skill 已删除,当前没有任何版本在生效。这是删除前最后生效的版本。')}>
                        <Tag style={{ marginInlineEnd: 0 }}>
                          {t('skill_lib_rev_was_live', '曾生效')}
                        </Tag>
                      </Tooltip>
                    ) : (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>
                        {t('skill_lib_rev_live', '生效中')}
                      </Tag>
                    )
                  )}
                  {/* Each version carries its own verdict — several can be
                      waiting at once, and deciding one says nothing about the
                      others. */}
                  {(() => {
                    const rv = revisions.find(x => x.version === v)
                    if (!rv || rv.review_status === 'approved') return null
                    const who = rv.reviewed_by ? `(${rv.reviewed_by})` : ''
                    const label: Record<string, [string, string, string]> = {
                      pending:    ['orange', '待复核', '等另一个人复核,通过前不会被 agent 加载'],
                      rejected:   ['red', '已驳回', `复核未通过${who},从未生效`],
                      withdrawn:  ['default', '已撤回', `提交人自己撤回了${who},从未生效`],
                    }
                    const [color, text, tip] =
                      label[rv.review_status] || ['default', rv.review_status, '']
                    return (
                      <Tooltip title={t(`skill_lib_rev_${rv.review_status}_tip`, tip)}>
                        <Tag color={color} style={{ marginInlineEnd: 0 }}>
                          {t(`skill_lib_rev_${rv.review_status}`, text)}
                        </Tag>
                      </Tooltip>
                    )
                  })()}
                </Space>
              ),
            },
            { title: t('skill_lib_rev_message', '改动说明'), dataIndex: 'message' },
            { title: t('skill_lib_rev_author', '操作人'), dataIndex: 'author', width: 110 },
            { title: t('skill_lib_rev_time', '时间'), dataIndex: 'created_at', width: 160,
              render: (v: string) => fmtTime(v) },
            {
              title: t('skill_lib_col_actions', '操作'),
              width: 170,
              align: 'right' as const,
              render: (_: any, r: SkillRevision) => (
                <Space size={0}>
                  <Button size="small" type="link" onClick={async () => {
                    const full = await skillApi.revision(historyOf!.id, r.version)
                    setRevisionView({ version: r.version, content: full.content })
                  }}>{t('skill_lib_rev_view', '查看')}</Button>
                  {/* Only versions that were actually cleared can be rolled
                      back to. The live one is a no-op; anything never approved
                      is text nobody let run, and restoring it under the name
                      "rollback" would slip it past the review that refused it. */}
                  {historyOf?.status !== 'deleted'
                    && r.review_status === 'approved'
                    && r.version < (historyOf?.active_version ?? 0) && (
                    <Button size="small" type="link"
                      onClick={() => doRollback(historyOf!, r.version)}>
                      {t('skill_lib_rev_rollback', '回滚')}
                    </Button>
                  )}
                  {/* Same two formats as the list export. One "导出" that
                      means JSON here and something else there would be the
                      page contradicting itself. */}
                  <Dropdown
                    menu={{
                      items: [
                        {
                          key: 'json',
                          label: t('skill_lib_export_json_short', 'JSON'),
                          onClick: async () => {
                            const payload = await skillApi.exportRevision(historyOf!.id, r.version)
                            download(payload, `${historyOf!.code}-v${r.version}.json`)
                          },
                        },
                        {
                          key: 'md',
                          label: t('skill_lib_export_md_short', 'SKILL.md'),
                          onClick: async () => {
                            const blob = await skillApi.exportRevisionFile(historyOf!.id, r.version)
                            saveBlob(blob as any, `${historyOf!.code}-v${r.version}.md`)
                          },
                        },
                      ],
                    }}
                  >
                    <Button size="small" type="link">
                      {t('skill_lib_rev_export', '导出')} <DownOutlined />
                    </Button>
                  </Dropdown>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        open={!!revisionView}
        title={t('skill_lib_rev_view_title', { defaultValue: 'v{{version}} 全文', version: revisionView?.version })}
        width={760}
        onCancel={() => setRevisionView(null)}
        footer={null}
      >
        <pre style={{
          maxHeight: '60vh', overflow: 'auto', background: 'rgba(0,0,0,.03)',
          padding: 12, borderRadius: 6, fontSize: 13,
        }}>{revisionView?.content}</pre>
      </Modal>

      {/* ── review ─────────────────────────────────────────────────────── */}
      <Modal
        open={!!reviewOf}
        title={t('skill_lib_review_title', { defaultValue: '复核 — {{name}}', name: reviewOf?.name })}
        width={1040}
        onCancel={() => setReviewOf(null)}
        footer={(() => {
          const cur = (reviewOf?.pending || []).find(p => p.version === reviewVersion)
          const mine = !!cur && cur.author_id === me
          return (
            <Space>
              <Button onClick={() => setReviewOf(null)}>{t('common_cancel', '取消')}</Button>
              {/* Fixing it here is usually shorter than bouncing it back: the
                  reviewer already knows which line is the problem. Four-eyes
                  still holds — editing makes them the author, so if the result
                  still trips a warning they cannot approve it either. */}
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  const row = reviewOf!
                  setReviewOf(null)
                  openEdit(row)
                }}
              >
                {t('skill_lib_review_edit', '直接修改')}
              </Button>
              {mine ? (
                <Button danger onClick={() => reviewOf && withdrawReview(reviewOf, cur!.version)}>
                  {t('skill_lib_withdraw', '撤回')}
                </Button>
              ) : (
                <>
                  <Button
                    danger
                    disabled={reviewVersion == null}
                    onClick={() => reviewOf && rejectReview(reviewOf, reviewVersion!)}
                  >
                    {t('skill_lib_reject', '驳回')}
                  </Button>
                  <Button
                    type="primary"
                    disabled={reviewVersion == null}
                    onClick={() => reviewOf && approveReview(reviewOf, reviewVersion!)}
                  >
                    {t('skill_lib_approve', { defaultValue: '通过 v{{version}}', version: reviewVersion ?? '' })}
                  </Button>
                </>
              )}
            </Space>
          )
        })()}
      >
        {reviewLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            {t('common_loading', '读取中…')}
          </div>
        ) : reviewOf ? (() => {
          const queued = reviewOf.pending || []
          const cur = queued.find(p => p.version === reviewVersion)
          const mine = !!cur && cur.author_id === me
          const findings = reviewDraft?.findings || cur?.findings || []
          return (
            <>
              {/* More than one draft can be queued. Which one is being decided
                  has to be a choice on screen, not "the newest" — approving is a
                  statement about a specific text. */}
              {queued.length > 1 && (
                <div style={{ marginBottom: 12 }}>
                  <Text type="secondary" style={{ marginRight: 8 }}>
                    {t('skill_lib_review_pick', { defaultValue: '{{count}} 个版本在等复核,选择要处理的:', count: queued.length })}
                  </Text>
                  <Radio.Group
                    size="small"
                    value={reviewVersion}
                    onChange={e => loadDraft(reviewOf.id, e.target.value)}
                  >
                    {queued.map(p => (
                      <Radio.Button key={p.version} value={p.version}>
                        v{p.version}
                        <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                          {p.author || '—'}{p.author_id === me ? t('skill_lib_review_is_me', '(我)') : ''}
                        </Text>
                      </Radio.Button>
                    ))}
                  </Radio.Group>
                </div>
              )}

              {mine && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={t('skill_lib_review_own',
                    '这版是你自己提交的,只能撤回,不能自己放行 —— 要生效得另一个人复核')}
                />
              )}

              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message={t('skill_lib_review_reason', '触发复核的原因')}
                description={
                  <>
                    {(cur?.findings || []).map(f => (
                      <div key={f.kind}>· {f.detail}</div>
                    ))}
                    <div style={{ marginTop: 6 }}>
                      <Text type="secondary">
                        {t('skill_lib_review_submitter', { defaultValue: '提交人:{{author}} · {{time}}', author: cur?.author || '—', time: fmtTime(cur?.created_at || '') })}
                        {cur?.message ? ` · ${cur.message}` : ''}
                      </Text>
                    </div>
                  </>
                }
              />

              {/* 逐条列出命中的位置 —— 复核要判断的就是这几处 */}
              <div style={{ marginBottom: 12 }}>
                {findings.flatMap(f =>
                  (f.matches || []).map((m, i) => (
                    <Tag key={`${f.kind}-${i}`} color="orange" style={{ marginBottom: 4 }}>
                      {m.label || f.kind}
                      {m.text ? `:${m.text.trim().slice(0, 40)}` : ''}
                    </Tag>
                  )),
                )}
              </div>

              <div style={{ marginBottom: 6 }}>
                <Tag color="orange">{t('skill_lib_review_new', { defaultValue: '待复核 v{{version}}', version: reviewVersion ?? '' })}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('skill_lib_review_new_note', '黄色标记处即触发复核的内容;通过后才会被 agent 加载')}
                </Text>
              </div>
              <pre style={{
                maxHeight: '46vh', overflow: 'auto', background: 'rgba(250,173,20,.06)',
                padding: 12, borderRadius: 6, fontSize: 12, margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>{reviewDraft
                ? highlight(reviewDraft.content, findings)
                : t('common_loading', '读取中…')}</pre>

              {/* The previous text is secondary: useful for context, but the
                  question on the table is whether the flagged lines are acceptable. */}
              <Collapse
                ghost
                style={{ marginTop: 8 }}
                items={[{
                  key: 'live',
                  label: t('skill_lib_review_show_live', { defaultValue: '对照 agent 当前加载的 v{{version}}', version: reviewOf.active_version }),
                  children: (
                    <pre style={{
                      maxHeight: '36vh', overflow: 'auto', background: 'rgba(0,0,0,.03)',
                      padding: 12, borderRadius: 6, fontSize: 12, margin: 0,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>{reviewLive || t('skill_lib_review_no_live', '(没有已生效的版本 —— 这是新建的 skill)')}</pre>
                  ),
                }]}
              />
            </>
          )
        })() : null}
      </Modal>

      {/* ── import ─────────────────────────────────────────────────────── */}
      <Modal
        open={importOpen}
        title={t('skill_lib_import_title', '导入 Skill')}
        width={720}
        onCancel={() => { setImportOpen(false); setImportFiles([]); setImportDupes([]); setPreview(null) }}
        footer={
          <Space>
            <Button onClick={() => { setImportOpen(false); setImportFiles([]); setImportDupes([]); setPreview(null) }}>
              {t('common_cancel', '取消')}
            </Button>
            <Button type="primary" disabled={!preview} onClick={runImport}>
              {t('skill_lib_import_confirm', '确认导入')}
            </Button>
          </Space>
        }
      >
        <Paragraph type="secondary">
          {t('skill_lib_import_help',
            '选择导出得到的 .json 或 .md(可多选)。按标识匹配:已存在的更新内容并生成新版本(内部 id 不变,绑定不受影响),不存在的新建。')}
        </Paragraph>

        <Upload.Dragger
          accept="application/json,.json,text/markdown,.md"
          multiple
          showUploadList={false}
          // Nothing is uploaded: the files are parsed in the browser and only
          // the merged skills go to the dry-run endpoint. beforeUpload fires
          // once per file, so the whole batch is handled on the first call and
          // the rest are ignored — otherwise each file would trigger its own
          // preview round trip and the last one to return would win.
          beforeUpload={(file, batch) => {
            if (file === batch[0]) acceptFiles(batch as File[])
            return false
          }}
          style={{ padding: '8px 0' }}
        >
          <p style={{ margin: 0 }}><InboxOutlined style={{ fontSize: 28, color: '#1677ff' }} /></p>
          <p style={{ margin: '8px 0 0' }}>
            {t('skill_lib_import_drop', '点击选择,或把 .json / .md 文件拖到这里(可多选)')}
          </p>
        </Upload.Dragger>

        {importFiles.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {importFiles.map(f => (
              <Tag
                key={f.name}
                closable
                onClose={e => { e.preventDefault(); dropFile(f.name) }}
                style={{ marginBottom: 4 }}
              >
                {f.name} · {f.skills.length}
              </Tag>
            ))}
          </div>
        )}

        {importDupes.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 12 }}
            message={t('skill_lib_import_dupes', { defaultValue: '{{count}} 个标识在多个文件里都出现了,以最后选中的文件为准', count: importDupes.length })}
            description={importDupes.join('、')}
          />
        )}

        {preview && (
          <div style={{ marginTop: 16 }}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Text>
                {t('skill_lib_import_will_create', { defaultValue: '将新增 {{count}} 条', count: preview.will_create.length })}
                {preview.will_create.length > 0 &&
                  <Text type="secondary">:{preview.will_create.map((x: any) => x.code).join(', ')}</Text>}
              </Text>
              <Text>
                {t('skill_lib_import_will_update', { defaultValue: '将更新 {{count}} 条', count: preview.will_update.length })}
                {preview.will_update.length > 0 &&
                  <Text type="secondary">:{preview.will_update.map((x: any) => x.code).join(', ')}</Text>}
              </Text>
              {preview.invalid?.length > 0 && (
                <Alert
                  type="error"
                  showIcon
                  message={t('skill_lib_import_invalid', { defaultValue: '{{count}} 条无法导入', count: preview.invalid.length })}
                  description={preview.invalid.map((x: any) => `${x.code}: ${x.reason}`).join('; ')}
                />
              )}
            </Space>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default SkillLibrary
