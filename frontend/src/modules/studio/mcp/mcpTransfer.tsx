/**
 * MCP 导入/导出的前端公共逻辑,MCP Server 列表页和外部连接页共用。
 *
 * 导出:后端返回的 JSON bundle 中,敏感值已被说明文字占位符代替,文件可以
 * 安全分享;导入后需要到页面重新填写真实密钥。
 *
 * 导入(只新建,绝不修改已有配置):选文件后先调 check-code 探测编码冲突;
 * 有冲突就弹窗让用户逐条决定 —— 跳过,或重新输入一个新编码导入。新编码
 * 输入后立即做唯一性校验(查库 + 查文件内重复),重复会标红提醒。
 */
import React, { useRef, useState } from 'react'
import { Button, Checkbox, Input, Modal, Radio, Select, Space, Tooltip, Typography, message } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { api } from '@/api'
import { useAuthStore } from '@/stores/auth'

const { Text } = Typography

export interface TransferImportResult {
  total: number
  created: string[]
  skipped: string[]
  errors: { code: string; message: string }[]
}

/** 与后端 schema 的 code 校验一致(MCPServerCreate._validate_code)。 */
export const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** 导出时敏感值被抹成的占位说明文字(与后端 SECRET_PLACEHOLDER 对应)。
 *  用来判断导入文件里的 secret 值是"真密钥"还是"待填占位"。 */
function isSecretPlaceholder(v: unknown): boolean {
  if (typeof v !== 'string') return true          // 非字符串/缺失 → 视为待填
  const s = v.trim()
  if (!s) return true                             // 空 → 待填
  return s.includes('敏感信息不随导出文件提供') || s.includes('********')
}

/** 查库:codes 里哪些已被占用。新建抽屉的实时校验也用它。 */
export async function fetchExistingCodes(path: string, codes: string[]): Promise<string[]> {
  if (!codes.length) return []
  const res = await api.get<{ existing: string[] }>(
    `${path}/check-code`, { params: { codes: codes.join(',') } },
  )
  return res.existing || []
}

/** GET `${path}/export?codes=…`,把 bundle 存成本地 JSON 文件下载。
 *  codes 必传:单行导出传一个 code,批量导出传勾选的 code 列表(导出
 *  全部 = 表头全选)。 */
export async function downloadExport(
  path: string, filenamePrefix: string, codes: string[],
  opts?: { withConnCodes?: string[] },
): Promise<void> {
  if (!codes.length) return
  try {
    // Batch (2+) returns a zip, single returns JSON — the response is binary
    // either way and we need the headers to name the file, so fetch directly
    // (the api wrapper only exposes response.data).
    const qs = new URLSearchParams({ codes: codes.join(',') })
    if (opts?.withConnCodes?.length) qs.set('with_conn_codes', opts.withConnCodes.join(','))
    const base = (import.meta as any).env?.VITE_API_URL || '/api/v1'
    const token = useAuthStore.getState().token
    const resp = await fetch(`${base}${path}/export?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!resp.ok) {
      let msg = `导出失败 (${resp.status})`
      try { const j = await resp.json(); msg = j?.detail?.message || j?.detail || msg } catch { /* not json */ }
      message.error(msg)
      return
    }
    const blob = await resp.blob()
    const cd = resp.headers.get('content-disposition') || ''
    const m = cd.match(/filename="?([^"]+)"?/)
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const isZip = (resp.headers.get('content-type') || '').includes('zip')
    const fallback = codes.length === 1
      ? `${filenamePrefix}-${codes[0]}-${stamp}.json`
      : `${filenamePrefix}-${stamp}.${isZip ? 'zip' : 'json'}`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = m ? m[1] : fallback
    a.click()
    URL.revokeObjectURL(url)
    message.success(i18n.t('mcp_transfer_export_success'))
  } catch (e: any) {
    message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
  }
}

interface ServerBinding {
  code: string
  name: string
  bound_connections: string[]
}

/** 批量导出确认弹窗:逐个服务器勾选是否一并导出其绑定的外部连接。
 *  确认后:多个服务器 → 后端返回 zip(每服务器一个 JSON);单个 → JSON。
 *  ``codes`` 为空(null)= 关闭。 */
export function ExportServersModal({
  codes, onClose,
}: { codes: string[] | null; onClose: () => void }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ServerBinding[]>([])
  const [withConn, setWithConn] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  React.useEffect(() => {
    if (!codes?.length) return
    setLoading(true)
    setWithConn(new Set())
    api.get<{ servers: ServerBinding[] }>('/mcp-servers/binding-summary', { params: { codes: codes.join(',') } })
      .then((r) => setRows(r.servers || []))
      .catch(() => setRows(codes.map((c) => ({ code: c, name: c, bound_connections: [] }))))
      .finally(() => setLoading(false))
  }, [codes])

  const toggle = (code: string, on: boolean) => {
    setWithConn((prev) => {
      const next = new Set(prev)
      if (on) next.add(code); else next.delete(code)
      return next
    })
  }
  const bindable = rows.filter((r) => r.bound_connections.length > 0)
  const allOn = bindable.length > 0 && bindable.every((r) => withConn.has(r.code))

  const onOk = async () => {
    if (!codes?.length) return
    setExporting(true)
    try {
      await downloadExport('/mcp-servers', 'mcp-servers', codes, { withConnCodes: [...withConn] })
      onClose()
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      open={!!codes?.length}
      title={t('mcp_transfer_export_modal_title')}
      okText={t('mcp_transfer_export_modal_ok')}
      okButtonProps={{ loading: exporting }}
      onOk={onOk}
      onCancel={onClose}
      width={560}
    >
      <p><Text type="secondary">{t('mcp_transfer_export_modal_hint', { count: codes?.length || 0 })}</Text></p>
      {bindable.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <a onClick={() => setWithConn(allOn ? new Set() : new Set(bindable.map((r) => r.code)))}>
            {allOn ? t('mcp_transfer_export_modal_none') : t('mcp_transfer_export_modal_all')}
          </a>
        </div>
      )}
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        {(loading ? (codes || []).map((c) => ({ code: c, name: c, bound_connections: [] })) : rows).map((r) => (
          <div key={r.code} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span><Text code>{r.code}</Text> <Text type="secondary" style={{ fontSize: 12 }}>{r.name}</Text></span>
            {r.bound_connections.length > 0 ? (
              <Checkbox checked={withConn.has(r.code)} onChange={(e) => toggle(r.code, e.target.checked)}>
                {t('mcp_transfer_export_modal_incl', { n: r.bound_connections.length })}
              </Checkbox>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{t('mcp_transfer_export_modal_no_binding')}</Text>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}

/** 导入结束弹窗:显示本轮结果(新建/跳过/失败明细),两个按钮——
 *  「关闭」结束,「继续导入」立即再开一轮文件选择,方便一个个连着导。 */
function showImportResult(
  res: TransferImportResult, userSkipped: number, onContinue: () => void,
): void {
  // 用户在冲突弹窗里选「跳过」的条目不会发给后端,这里合并计入提示
  const line = i18n.t('mcp_transfer_import_result_line', {
    created: res.created.length,
    skipped: res.skipped.length + userSkipped,
    failed: res.errors.length,
  })
  const modal = Modal[res.errors?.length ? 'warning' : 'success']({
    title: i18n.t(res.errors?.length
      ? 'mcp_transfer_import_partial_title'
      : 'mcp_transfer_import_done_title'),
    width: 560,
    content: (
      <div>
        <p>{line}</p>
        {res.created.length > 0 && (
          <p style={{ margin: '4px 0' }}>
            <span style={{ color: '#52c41a' }}>✓ </span>
            {i18n.t('mcp_transfer_import_created_list', { codes: res.created.join('、') })}
          </p>
        )}
        {res.errors?.length > 0 && (
          <ul style={{ maxHeight: 200, overflow: 'auto', paddingLeft: 18 }}>
            {res.errors.map((er, idx) => (
              <li key={idx}><b>{er.code || '?'}</b>: {er.message}</li>
            ))}
          </ul>
        )}
      </div>
    ),
    okText: i18n.t('mcp_transfer_import_close'),
    // 「继续导入」用 cancel 位放一个次要按钮。禁掉 X / 遮罩关闭,避免误触
    // continue —— 只能从两个明确按钮里选。
    okCancel: true,
    cancelText: i18n.t('mcp_transfer_import_continue'),
    closable: false,
    maskClosable: false,
    keyboard: false,
    onCancel: () => { modal.destroy(); onContinue() },
  })
}

interface ConflictDecision {
  original: string
  action: 'skip' | 'rename'
  newCode: string
  error: string
  validated: boolean  // rename 的新 code 是否已通过查重校验(未通过则禁用确定)
}

/** 服务器条目需要绑定外部连接时的选择。绑定靠连接的 code
 *  (env_config.connection_id 存的就是 code)。导出时绑定值被清空,
 *  导入时由用户从本环境已有连接中选择;不选 = 留空稍后再配。 */
interface ConnFix {
  itemCode: string                                   // 文件里该服务器的 code
  field: 'connection_id' | 'server_auth_connection_id'
  chosen: string                                     // 选中的本环境连接 code;空 = 留空
}

interface ConnOption {
  code: string
  name: string
  connection_type: string
}

/** 外部连接导入时,一条连接的鉴权(secret)填写。导出时 secret 的值被抹成
 *  占位符;导入时给一个 JSON 文本框,预填整个 secret 结构,用户直接改——
 *  把占位符换成真密钥即建好;保留占位符/留空 = 该字段只当 label 稍后再填。
 *  用文本框而非逐字段输入,是因为 secret 结构不固定(可能多字段/嵌套),
 *  程序无法可靠拆成一个个输入框。 */
interface SecretFill {
  connCode: string   // 文件里该连接的 code
  json: string       // 该连接 secret 的 JSON 文本(预填导出结构,用户编辑)
  error: string      // JSON 解析错误提示,空 = 无错
}

/** 「导入」按钮 + 冲突确认弹窗。path 形如 '/mcp-servers'。 */
export function McpImportButton({ path, onDone }: { path: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [bundle, setBundle] = useState<any>(null)
  const [decisions, setDecisions] = useState<ConflictDecision[]>([])
  const [connFixes, setConnFixes] = useState<ConnFix[]>([])
  const [connOptions, setConnOptions] = useState<ConnOption[]>([])
  const [secretFills, setSecretFills] = useState<SecretFill[]>([])
  const [importing, setImporting] = useState(false)

  const refreshConnOptions = async () => {
    const res = await api.get<{ items: ConnOption[] }>('/mcp-external-connections')
    setConnOptions((res.items || []).map((c: any) => ({
      code: c.code, name: c.name, connection_type: c.connection_type,
    })))
  }

  /** 弹窗内「导入连接文件」入口:选一个连接导出文件直接导入(仅新建),
   *  完成后刷新下拉可选连接,用户即可选到刚导入的连接。 */
  const importConnectionsInline = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      let parsed: unknown
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        message.error(t('mcp_transfer_import_invalid_json'))
        return
      }
      try {
        const res = await api.post<TransferImportResult>('/mcp-external-connections/import', parsed)
        message.success(t('mcp_transfer_import_result_line', {
          created: res.created.length, skipped: res.skipped.length, failed: res.errors.length,
        }))
        await refreshConnOptions()
      } catch (e: any) {
        message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
      }
    }
    input.click()
  }

  const doImport = async (b: unknown, userSkipped = 0) => {
    setImporting(true)
    try {
      const res = await api.post<TransferImportResult>(`${path}/import`, b)
      closeModal()
      onDone()
      showImportResult(res, userSkipped, pickFile)
    } catch (e: any) {
      message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
    } finally {
      setImporting(false)
    }
  }

  const pickFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      let parsed: any
      try {
        parsed = JSON.parse(await file.text())
      } catch {
        message.error(t('mcp_transfer_import_invalid_json'))
        return
      }
      const codes: string[] = (parsed?.items || [])
        .map((it: any) => String(it?.code || '').trim())
        .filter(Boolean)
      let existing: string[] = []
      const fixes: ConnFix[] = []
      const fills: SecretFill[] = []
      try {
        existing = await fetchExistingCodes(path, codes)
        // 服务器导入:导出文件里连接绑定值已被清空(键仍在),说明这些
        // 服务器需要在本环境选连接。逐个收集,交给弹窗让用户下拉选。
        if (path === '/mcp-servers') {
          for (const it of parsed?.items || []) {
            const env = it?.env_config
            if (!env || typeof env !== 'object') continue
            for (const field of ['connection_id', 'server_auth_connection_id'] as const) {
              if (field in env) {
                fixes.push({ itemCode: String(it?.code || '').trim(), field, chosen: '' })
              }
            }
          }
          if (fixes.length > 0) {
            await refreshConnOptions()
          }
        }
        // 外部连接导入:凡有 secret 且其中有占位符字段的连接,给一个 JSON
        // 文本框让用户填鉴权(整块编辑,应对不固定/嵌套结构)。secret 里
        // 全是真值的连接不打扰,直接建好。
        if (path === '/mcp-external-connections') {
          for (const it of parsed?.items || []) {
            const secret = it?.secret
            if (!secret || typeof secret !== 'object') continue
            const hasPlaceholder = Object.values(secret).some(isSecretPlaceholder)
            if (!hasPlaceholder) continue  // 全真值 → 不用填
            fills.push({
              connCode: String(it?.code || '').trim(),
              json: JSON.stringify(secret, null, 2),
              error: '',
            })
          }
        }
      } catch (e: any) {
        message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
        return
      }
      if (existing.length === 0 && fixes.length === 0 && fills.length === 0) {
        await doImport(parsed)
        return
      }
      // 有编码冲突 / 缺连接绑定 / 待填鉴权 → 弹窗逐条确认
      setDecisions(existing.map((code) => ({
        original: code, action: 'skip', newCode: '', error: '', validated: false,
      })))
      setConnFixes(fixes)
      setSecretFills(fills)
      setBundle(parsed)
    }
    input.click()
  }

  const setDecision = (idx: number, patch: Partial<ConflictDecision>) => {
    setDecisions((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  // 输入停顿即校验(去抖),不必等失焦——填完停一下确定按钮就自动判定。
  // 显式传入待校验的值,避免去抖回调读到闭包里过期的 decisions。
  const codeDebounce = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const scheduleValidate = (idx: number, value: string) => {
    clearTimeout(codeDebounce.current[idx])
    codeDebounce.current[idx] = setTimeout(() => validateNewCode(idx, value), 400)
  }

  /** 新编码的即时校验:格式 → 文件内重复 → 查库重复。
   *  ``explicit`` 用于去抖路径传当次输入值;省略则读当前状态(失焦路径)。 */
  const validateNewCode = async (idx: number, explicit?: string) => {
    const d = decisions[idx]
    if (d.action !== 'rename') return
    const v = (explicit !== undefined ? explicit : d.newCode).trim()
    if (!v) { setDecision(idx, { error: t('mcp_transfer_code_required'), validated: false }); return }
    if (!CODE_PATTERN.test(v)) { setDecision(idx, { error: t('mcp_transfer_code_format'), validated: false }); return }
    const fileCodes: string[] = (bundle?.items || [])
      .map((it: any) => String(it?.code || '').trim())
      .filter((c: string) => c !== d.original)
    const otherNew = decisions
      .filter((x, i) => i !== idx && x.action === 'rename')
      .map((x) => x.newCode.trim())
    if (fileCodes.includes(v) || otherNew.includes(v)) {
      setDecision(idx, { error: t('mcp_transfer_code_duplicate_in_file'), validated: false })
      return
    }
    try {
      const taken = await fetchExistingCodes(path, [v])
      if (taken.includes(v)) {
        setDecision(idx, { error: t('mcp_transfer_code_taken'), validated: false })
      } else {
        setDecision(idx, { error: '', validated: true })   // 唯一通过校验的路径
      }
    } catch {
      // 查重接口偶发失败:不误报错,但也不算通过(确定按钮仍禁用,
      // 促使用户重试失焦触发校验)。
      setDecision(idx, { error: '', validated: false })
    }
  }

  const onConfirm = async () => {
    // 确认前整体复查:重命名项非空、格式对、库里和文件里都不重复
    const renames = decisions.filter((d) => d.action === 'rename')
    for (const d of renames) {
      const v = d.newCode.trim()
      if (!v || !CODE_PATTERN.test(v)) {
        message.error(t('mcp_transfer_conflict_fix_first'))
        return
      }
    }
    const newCodes = renames.map((d) => d.newCode.trim())
    if (new Set(newCodes).size !== newCodes.length) {
      message.error(t('mcp_transfer_code_duplicate_in_file'))
      return
    }
    if (newCodes.length) {
      const taken = await fetchExistingCodes(path, newCodes)
      if (taken.length) {
        setDecisions((prev) => prev.map((d) => (
          d.action === 'rename' && taken.includes(d.newCode.trim())
            ? { ...d, error: t('mcp_transfer_code_taken') } : d
        )))
        return
      }
    }
    const decisionByCode = new Map(decisions.map((d) => [d.original, d]))
    const fixesByItem = new Map<string, ConnFix[]>()
    for (const f of connFixes) {
      if (!fixesByItem.has(f.itemCode)) fixesByItem.set(f.itemCode, [])
      fixesByItem.get(f.itemCode)!.push(f)
    }
    // 校验并解析每条连接的 secret JSON。被跳过的连接(冲突选了跳过)不导入,
    // 其鉴权框内容一律忽略,不参与校验、不阻塞。
    const skippedCodes = new Set(
      decisions.filter((d) => d.action === 'skip').map((d) => d.original),
    )
    const parsedSecret = new Map<string, Record<string, unknown>>()
    let secretErr = false
    setSecretFills((prev) => prev.map((f) => {
      if (skippedCodes.has(f.connCode)) return { ...f, error: '' }
      try {
        const obj = JSON.parse(f.json || '{}')
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsedSecret.set(f.connCode, obj)
          return { ...f, error: '' }
        }
        secretErr = true
        return { ...f, error: t('mcp_transfer_secret_not_object') }
      } catch {
        secretErr = true
        return { ...f, error: t('mcp_transfer_import_invalid_json') }
      }
    }))
    if (secretErr) return
    const items = (bundle?.items || []).flatMap((it: any) => {
      const origCode = String(it?.code || '').trim()
      const d = decisionByCode.get(origCode)
      if (d?.action === 'skip') return []
      let out = d ? { ...it, code: d.newCode.trim() } : { ...it }
      // 写入用户选的连接(按文件里的原 code 匹配,改名不影响)。
      // 未选 → 值留空,后端会按"是否必须绑定"给出正确结果。
      const fixes = fixesByItem.get(origCode)
      if (fixes?.length) {
        const env = { ...(out.env_config || {}) }
        for (const f of fixes) env[f.field] = f.chosen || ''
        out = { ...out, env_config: env }
      }
      // 外部连接:用用户编辑后的 secret JSON 整体替换。后端按值分流——
      // 真值加密存,占位符/空值保留 key 当待填 label。
      if (parsedSecret.has(origCode)) {
        out = { ...out, secret: parsedSecret.get(origCode) }
      }
      return [out]
    })
    const userSkipped = decisions.filter((d) => d.action === 'skip').length
    if (items.length === 0) {
      // 全部选了跳过 → 提示已跳过,直接结束,不发导入请求
      message.info(t('mcp_transfer_all_skipped', { skipped: userSkipped }))
      closeModal()
      return
    }
    await doImport({ ...bundle, items }, userSkipped)
  }

  const closeModal = () => {
    setBundle(null)
    setDecisions([])
    setConnFixes([])
    setSecretFills([])
  }

  const setSecretJson = (idx: number, json: string) => {
    setSecretFills((prev) => prev.map((f, i) => (i === idx ? { ...f, json, error: '' } : f)))
  }

  // 确定按钮:任何"改名"项必须已通过查重校验(validated)才放行 —— 光输入、
  // 未失焦触发校验的中间态一律禁用。跳过项、留空鉴权不阻塞。
  const hasBlockingError = decisions.some(
    (d) => d.action === 'rename' && !d.validated,
  )

  /** 外部连接导入弹窗:按连接聚合渲染。每条连接一块,内容由其状态决定:
   *  - 冲突 → 跳过/改名单选;选改名再显示 code 框 +(如需要)鉴权 JSON 框;
   *          选跳过则该块下方不显示任何输入项。
   *  - 不冲突但需填鉴权 → 只显示鉴权 JSON 框(没有跳过/改名)。 */
  const renderConnBlocks = () => {
    // 有序去重:先冲突项、再纯待填项,按出现顺序
    const order: string[] = []
    const seen = new Set<string>()
    for (const d of decisions) if (!seen.has(d.original)) { order.push(d.original); seen.add(d.original) }
    for (const f of secretFills) if (!seen.has(f.connCode)) { order.push(f.connCode); seen.add(f.connCode) }

    return order.map((code) => {
      const dIdx = decisions.findIndex((d) => d.original === code)
      const d = dIdx >= 0 ? decisions[dIdx] : null
      const sIdx = secretFills.findIndex((f) => f.connCode === code)
      const s = sIdx >= 0 ? secretFills[sIdx] : null
      const skipped = d?.action === 'skip'
      // 鉴权框显示条件:有待填 secret,且没被跳过(冲突项须选了改名)
      const showSecret = !!s && !skipped && (!d || d.action === 'rename')
      return (
        <div key={code} style={{ padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            <Space wrap>
              <Text code>{code}</Text>
              {d && (
                <Radio.Group
                  size="small"
                  value={d.action}
                  onChange={(e) => setDecision(dIdx, { action: e.target.value, error: '', validated: false })}
                  options={[
                    { label: t('mcp_transfer_conflict_skip'), value: 'skip' },
                    { label: t('mcp_transfer_conflict_rename'), value: 'rename' },
                  ]}
                  optionType="button"
                />
              )}
              {d && <Text type="secondary" style={{ fontSize: 12 }}>{t('mcp_transfer_conn_conflict_tag')}</Text>}
            </Space>
            {d?.action === 'rename' && (
              <div>
                <Input
                  size="small"
                  style={{ width: 320 }}
                  placeholder={t('mcp_transfer_conflict_new_code_placeholder')}
                  value={d.newCode}
                  status={d.error ? 'error' : undefined}
                  onChange={(e) => { setDecision(dIdx, { newCode: e.target.value, error: '', validated: false }); scheduleValidate(dIdx, e.target.value) }}
                  onBlur={() => validateNewCode(dIdx)}
                />
                {/* 固定高度占位:报错显隐不改变下方布局,避免整窗跳动 */}
                <div style={{ height: 18, lineHeight: '18px' }}>
                  {d.error && <Text type="danger" style={{ fontSize: 12 }}>{d.error}</Text>}
                </div>
              </div>
            )}
            {showSecret && (
              <div>
                <Input.TextArea
                  rows={Math.min(8, (s!.json.match(/\n/g)?.length || 0) + 1)}
                  value={s!.json}
                  status={s!.error ? 'error' : undefined}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                  onChange={(e) => setSecretJson(sIdx, e.target.value)}
                />
                <div style={{ height: 18, lineHeight: '18px' }}>
                  {s!.error && <Text type="danger" style={{ fontSize: 12 }}>{s!.error}</Text>}
                </div>
              </div>
            )}
          </Space>
        </div>
      )
    })
  }

  return (
    <>
      <Tooltip title={t('mcp_transfer_import_tooltip')}>
        <Button icon={<UploadOutlined />} onClick={pickFile}>
          {t('mcp_transfer_import_button')}
        </Button>
      </Tooltip>
      <Modal
        open={bundle !== null && (decisions.length > 0 || connFixes.length > 0 || secretFills.length > 0)}
        title={t(decisions.length > 0
          ? 'mcp_transfer_conflict_title'
          : 'mcp_transfer_conn_only_title')}
        width={620}
        okText={t('mcp_transfer_conflict_confirm')}
        okButtonProps={{ disabled: hasBlockingError, loading: importing }}
        onOk={onConfirm}
        onCancel={closeModal}
      >
        {/* 外部连接:按连接聚合——每条一块,冲突处理与其鉴权框在一起,
            选跳过则不显示任何输入项(见 renderConnBlocks)。 */}
        {path === '/mcp-external-connections' ? (
          <>
            <p><Text type="secondary">{t('mcp_transfer_conn_aggregate_hint')}</Text></p>
            <div style={{ maxHeight: 380, overflow: 'auto' }}>{renderConnBlocks()}</div>
          </>
        ) : decisions.length > 0 && (
          <>
            <p><Text type="secondary">{t('mcp_transfer_conflict_hint')}</Text></p>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              {decisions.map((d, idx) => (
                <div key={d.original} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Space direction="vertical" style={{ width: '100%' }} size={4}>
                    <Space>
                      <Text code>{d.original}</Text>
                      <Radio.Group
                        size="small"
                        value={d.action}
                        onChange={(e) => setDecision(idx, { action: e.target.value, error: '' })}
                        options={[
                          { label: t('mcp_transfer_conflict_skip'), value: 'skip' },
                          { label: t('mcp_transfer_conflict_rename'), value: 'rename' },
                        ]}
                        optionType="button"
                      />
                    </Space>
                    {d.action === 'rename' && (
                      <>
                        <Input
                          size="small"
                          style={{ width: 320 }}
                          placeholder={t('mcp_transfer_conflict_new_code_placeholder')}
                          value={d.newCode}
                          status={d.error ? 'error' : undefined}
                          onChange={(e) => setDecision(idx, { newCode: e.target.value, error: '' })}
                          onBlur={() => validateNewCode(idx)}
                        />
                        {d.error && <Text type="danger" style={{ fontSize: 12 }}>{d.error}</Text>}
                      </>
                    )}
                  </Space>
                </div>
              ))}
            </div>
          </>
        )}
        {connFixes.length > 0 && (
          <>
            <p style={{ marginTop: decisions.length > 0 ? 16 : 0, marginBottom: 4 }}>
              <Text type="secondary">{t('mcp_transfer_conn_missing_hint')}</Text>
            </p>
            <p style={{ marginTop: 0 }}>
              <Button type="link" size="small" style={{ padding: 0 }}
                      icon={<UploadOutlined />} onClick={importConnectionsInline}>
                {t('mcp_transfer_conn_import_link')}
              </Button>
            </p>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              {connFixes.map((f, idx) => (
                <div key={`${f.itemCode}-${f.field}`} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Space wrap>
                    <Text code>{f.itemCode}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t(f.field === 'server_auth_connection_id'
                        ? 'mcp_transfer_conn_field_auth'
                        : 'mcp_transfer_conn_field_data')}
                    </Text>
                    <Select
                      size="small"
                      style={{ width: 300 }}
                      showSearch
                      allowClear
                      optionFilterProp="label"
                      placeholder={t('mcp_transfer_conn_pick_placeholder')}
                      value={f.chosen || undefined}
                      onChange={(v) => setConnFixes((prev) => prev.map((x, i) => (
                        i === idx ? { ...x, chosen: v || '' } : x
                      )))}
                      options={connOptions.map((c) => ({
                        value: c.code,
                        label: `${c.name}(${c.connection_type})`,
                      }))}
                    />
                  </Space>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
