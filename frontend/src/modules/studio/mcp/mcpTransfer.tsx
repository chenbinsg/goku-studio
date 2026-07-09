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
import React, { useState } from 'react'
import { Button, Input, Modal, Radio, Select, Space, Tooltip, Typography, message } from 'antd'
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { api } from '@/api'

const { Text } = Typography

export interface TransferImportResult {
  total: number
  created: string[]
  skipped: string[]
  errors: { code: string; message: string }[]
}

/** 与后端 schema 的 code 校验一致(MCPServerCreate._validate_code)。 */
export const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

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
): Promise<void> {
  if (!codes.length) return
  try {
    const bundle = await api.get<Record<string, unknown>>(
      `${path}/export`, { params: { codes: codes.join(',') } },
    )
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    a.href = url
    a.download = codes.length === 1
      ? `${filenamePrefix}-${codes[0]}-${stamp}.json`
      : `${filenamePrefix}-${stamp}.json`
    a.click()
    URL.revokeObjectURL(url)
    message.success(i18n.t('mcp_transfer_export_success'))
  } catch (e: any) {
    message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
  }
}

function showImportResult(res: TransferImportResult, userSkipped = 0): void {
  // 用户在冲突弹窗里选「跳过」的条目不会发给后端,这里合并计入提示
  const line = i18n.t('mcp_transfer_import_result_line', {
    created: res.created.length,
    skipped: res.skipped.length + userSkipped,
    failed: res.errors.length,
  })
  if (res.errors?.length) {
    Modal.warning({
      title: i18n.t('mcp_transfer_import_partial_title'),
      width: 560,
      content: (
        <div>
          <p>{line}</p>
          <ul style={{ maxHeight: 240, overflow: 'auto', paddingLeft: 18 }}>
            {res.errors.map((er, idx) => (
              <li key={idx}><b>{er.code || '?'}</b>: {er.message}</li>
            ))}
          </ul>
        </div>
      ),
    })
  } else {
    message.success(line)
  }
}

interface ConflictDecision {
  original: string
  action: 'skip' | 'rename'
  newCode: string
  error: string
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

/** 「导入」按钮 + 冲突确认弹窗。path 形如 '/mcp-servers'。 */
export function McpImportButton({ path, onDone }: { path: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [bundle, setBundle] = useState<any>(null)
  const [decisions, setDecisions] = useState<ConflictDecision[]>([])
  const [connFixes, setConnFixes] = useState<ConnFix[]>([])
  const [connOptions, setConnOptions] = useState<ConnOption[]>([])
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
      showImportResult(res, userSkipped)
      closeModal()
      onDone()
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
      } catch (e: any) {
        message.error(e?.response?.data?.detail?.message || e?.response?.data?.detail || e?.message || String(e))
        return
      }
      if (existing.length === 0 && fixes.length === 0) {
        await doImport(parsed)
        return
      }
      // 有编码冲突或缺失的连接绑定 → 弹窗逐条确认
      setDecisions(existing.map((code) => ({
        original: code, action: 'skip', newCode: '', error: '',
      })))
      setConnFixes(fixes)
      setBundle(parsed)
    }
    input.click()
  }

  const setDecision = (idx: number, patch: Partial<ConflictDecision>) => {
    setDecisions((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  /** 新编码的即时校验:格式 → 文件内重复 → 查库重复。 */
  const validateNewCode = async (idx: number) => {
    const d = decisions[idx]
    if (d.action !== 'rename') return
    const v = d.newCode.trim()
    if (!v) { setDecision(idx, { error: t('mcp_transfer_code_required') }); return }
    if (!CODE_PATTERN.test(v)) { setDecision(idx, { error: t('mcp_transfer_code_format') }); return }
    const fileCodes: string[] = (bundle?.items || [])
      .map((it: any) => String(it?.code || '').trim())
      .filter((c: string) => c !== d.original)
    const otherNew = decisions
      .filter((x, i) => i !== idx && x.action === 'rename')
      .map((x) => x.newCode.trim())
    if (fileCodes.includes(v) || otherNew.includes(v)) {
      setDecision(idx, { error: t('mcp_transfer_code_duplicate_in_file') })
      return
    }
    try {
      const taken = await fetchExistingCodes(path, [v])
      setDecision(idx, { error: taken.includes(v) ? t('mcp_transfer_code_taken') : '' })
    } catch {
      // 校验接口偶发失败不挡输入;确认导入前还会整体复查一遍
      setDecision(idx, { error: '' })
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
  }

  // 连接不选 = 留空稍后配,不阻塞确认;仅编码冲突未解决时禁用
  const hasBlockingError = decisions.some(
    (d) => d.action === 'rename' && (d.error !== '' || !d.newCode.trim()),
  )

  return (
    <>
      <Tooltip title={t('mcp_transfer_import_tooltip')}>
        <Button icon={<UploadOutlined />} onClick={pickFile}>
          {t('mcp_transfer_import_button')}
        </Button>
      </Tooltip>
      <Modal
        open={bundle !== null && (decisions.length > 0 || connFixes.length > 0)}
        title={t(decisions.length > 0
          ? 'mcp_transfer_conflict_title'
          : 'mcp_transfer_conn_only_title')}
        width={620}
        okText={t('mcp_transfer_conflict_confirm')}
        okButtonProps={{ disabled: hasBlockingError, loading: importing }}
        onOk={onConfirm}
        onCancel={closeModal}
      >
        {decisions.length > 0 && (
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
