/**
 * PromptTokenMeter
 * ─────────────────────────────────────────────────────────────────────────────
 * Wraps a prompt textarea with:
 *   • Color-band token-budget indicator (🟢🟡🟠🔴)
 *   • Bilingual CJK ↔ English size statistics
 *   • "✨ Optimize" button — compresses + translates CJK prompts to English
 *     via POST /api/v1/agents/optimize-prompt, shows a before/after modal
 *
 * Color thresholds (Agent Custom Prompt, 600-token budget):
 *   🟢 Optimal   ≤ 200 tok
 *   🟡 Moderate  201–400 tok
 *   🟠 Tight     401–550 tok
 *   🔴 Critical  > 550 tok
 *
 * CJK token estimation (empirical, Qwen2.5-14B):
 *   Chinese/Japanese ≈ 1 token / 1.7 chars
 *   English          ≈ 1 token / 4.5 chars
 */

import React, { useMemo, useState } from 'react'
import { Button, Modal, Spin, Tag, Tooltip, message } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { api } from '../api'

// ── Budget config ─────────────────────────────────────────────────────────────

export interface TokenBudgetConfig {
  optimal: number   // 🟢
  moderate: number  // 🟡
  tight: number     // 🟠
  max: number       // 🔴 hard cap
  label?: string
}

export const AGENT_PROMPT_BUDGET: TokenBudgetConfig = {
  optimal: 200, moderate: 400, tight: 550, max: 600,
  label: 'Custom Prompt',
}

export const SOUL_PROMPT_BUDGET: TokenBudgetConfig = {
  optimal: 300, moderate: 600, tight: 900, max: 1200,
  label: 'Soul Prompt',
}

// ── Token estimation ──────────────────────────────────────────────────────────

function isCJK(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xff00 && cp <= 0xffef)
  )
}

interface TextStats {
  chars: number
  cjkChars: number
  nonCjkChars: number
  cjkRatio: number
  estimatedTokens: number
  englishEquivChars: number
}

function analyzeText(text: string): TextStats {
  const chars = text.length
  let cjk = 0
  for (const ch of text) if (isCJK(ch)) cjk++
  const nonCjk = chars - cjk
  const tokens = Math.round(cjk / 1.7 + nonCjk / 4.5)
  return {
    chars,
    cjkChars: cjk,
    nonCjkChars: nonCjk,
    cjkRatio: chars > 0 ? cjk / chars : 0,
    estimatedTokens: tokens,
    englishEquivChars: Math.round(tokens * 4.5),
  }
}

// ── Status color ──────────────────────────────────────────────────────────────

interface StatusInfo {
  color: string; bgColor: string; borderColor: string
  emoji: string; label: string; labelEn: string
}

function getStatus(tokens: number, cfg: TokenBudgetConfig): StatusInfo {
  if (tokens <= cfg.optimal)  return { color: '#52c41a', bgColor: '#f6ffed', borderColor: '#b7eb8f', emoji: '🟢', label: '精简', labelEn: 'Optimal' }
  if (tokens <= cfg.moderate) return { color: '#fadb14', bgColor: '#fffbe6', borderColor: '#ffe58f', emoji: '🟡', label: '适中', labelEn: 'Moderate' }
  if (tokens <= cfg.tight)    return { color: '#fa8c16', bgColor: '#fff7e6', borderColor: '#ffd591', emoji: '🟠', label: '偏大', labelEn: 'Tight' }
  return                             { color: '#ff4d4f', bgColor: '#fff2f0', borderColor: '#ffccc7', emoji: '🔴', label: '超标', labelEn: 'Critical' }
}

// ── Optimize API ──────────────────────────────────────────────────────────────

interface OptimizeResult {
  optimized: string
  original_tokens: number
  optimized_tokens: number
  original_chars: number
  optimized_chars: number
}

async function callOptimize(text: string): Promise<OptimizeResult> {
  return api.post<OptimizeResult>('/agents/optimize-prompt', { text })
}

// ── Main component ────────────────────────────────────────────────────────────

export interface PromptTokenMeterProps {
  value?: string
  onChange?: (val: string) => void
  budget?: TokenBudgetConfig
  children: React.ReactNode
  showEquivalence?: boolean
}

const PromptTokenMeter: React.FC<PromptTokenMeterProps> = ({
  value = '',
  onChange,
  budget = AGENT_PROMPT_BUDGET,
  children,
  showEquivalence = true,
}) => {
  const stats  = useMemo(() => analyzeText(value), [value])
  const status = useMemo(() => getStatus(stats.estimatedTokens, budget), [stats, budget])
  const fillPct = Math.min(100, Math.round((stats.estimatedTokens / budget.max) * 100))

  // Optimize modal state
  const [optimizing, setOptimizing] = useState(false)
  const [result, setResult]         = useState<OptimizeResult | null>(null)
  const [modalOpen, setModalOpen]   = useState(false)

  const showOptimizeBtn = stats.chars > 20 && stats.cjkRatio > 0.15

  async function handleOptimize() {
    if (!value.trim()) return
    setOptimizing(true)
    setModalOpen(true)
    setResult(null)
    try {
      const r = await callOptimize(value)
      setResult(r)
    } catch (err: any) {
      const detail: string = err?.response?.data?.detail || err?.message || ''
      const isLlm = detail.toLowerCase().includes('llm') || detail.toLowerCase().includes('llm call')
      message.error(
        isLlm
          ? `⚠️ LLM 服务异常，优化暂不可用 / LLM unavailable: ${detail}`
          : `优化失败，请稍后重试${detail ? `：${detail}` : ''}`,
        6,
      )
      setModalOpen(false)
    } finally {
      setOptimizing(false)
    }
  }

  function handleAdopt() {
    if (result && onChange) {
      onChange(result.optimized)
      message.success('已替换为优化版本 ✨')
    }
    setModalOpen(false)
    setResult(null)
  }

  // Tooltip detail
  const tooltipContent = (
    <div style={{ fontSize: 12, lineHeight: 1.8 }}>
      <div><strong>Token 预算详情</strong></div>
      <div>总字符: {stats.chars} | CJK: {stats.cjkChars}（{Math.round(stats.cjkRatio * 100)}%）</div>
      <div>估算 Tokens: <strong>{stats.estimatedTokens}</strong> / {budget.max}</div>
      {stats.cjkChars > 0 && (
        <div style={{ marginTop: 4, color: '#faad14' }}>
          ⚠ 同等内容英文约 {stats.englishEquivChars} 字符
        </div>
      )}
      <div style={{ marginTop: 6, color: '#8c8c8c' }}>
        🟢≤{budget.optimal} 🟡≤{budget.moderate} 🟠≤{budget.tight} 🔴&gt;{budget.tight}
      </div>
    </div>
  )

  // Result stats for modal
  const resultStats = result ? analyzeText(result.optimized) : null

  return (
    <div>
      {/* ── Color band header ── */}
      <div
        style={{
          borderRadius: '6px 6px 0 0',
          overflow: 'hidden',
          border: `1px solid ${status.borderColor}`,
          borderBottom: 'none',
          background: status.bgColor,
        }}
      >
        {/* Progress bar */}
        <div style={{ height: 5, background: '#f0f0f0', position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, height: '100%',
            width: `${fillPct}%`,
            background: fillPct <= 33
              ? '#52c41a'
              : fillPct <= 66
              ? 'linear-gradient(to right,#52c41a,#fadb14)'
              : fillPct <= 91
              ? 'linear-gradient(to right,#fadb14,#fa8c16)'
              : 'linear-gradient(to right,#fa8c16,#ff4d4f)',
            borderRadius: '3px 0 0 3px',
            transition: 'width 0.2s ease, background 0.3s ease',
          }} />
        </div>

        {/* Stats row */}
        <div style={{
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between',
          padding: '3px 10px 4px', fontSize: 11, color: '#595959', gap: 8,
        }}>
          {/* Left: status + label */}
          <Tooltip title={tooltipContent} placement="topLeft">
            <span style={{ cursor: 'default' }}>
              {status.emoji}{' '}
              <span style={{ color: status.color, fontWeight: 600 }}>
                {status.label} / {status.labelEn}
              </span>
              {budget.label && (
                <span style={{ marginLeft: 6, color: '#8c8c8c' }}>· {budget.label}</span>
              )}
            </span>
          </Tooltip>

          {/* Right: token count + EN equiv + optimize btn */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>
              <span style={{ color: status.color, fontWeight: 700 }}>{stats.estimatedTokens}</span>
              <span style={{ color: '#8c8c8c' }}>/{budget.max} tok</span>
            </span>
            {showEquivalence && stats.cjkChars > 0 && stats.chars > 0 && (
              <span style={{ color: '#8c8c8c', borderLeft: '1px solid #d9d9d9', paddingLeft: 10 }}>
                EN equiv ~{stats.englishEquivChars} chars
              </span>
            )}
            {showOptimizeBtn && (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={optimizing}
                onClick={handleOptimize}
                style={{ fontSize: 11, height: 20, padding: '0 7px', lineHeight: '18px' }}
              >
                优化 / Optimize
              </Button>
            )}
          </span>
        </div>
      </div>

      {/* ── Textarea ── */}
      <div style={{
        border: `1px solid ${status.borderColor}`,
        borderTop: 'none',
        borderRadius: '0 0 6px 6px',
        overflow: 'hidden',
        transition: 'border-color 0.3s ease',
      }}>
        {children}
      </div>

      {/* ── Optimize result modal ── */}
      <Modal
        title="✨ 提示词优化结果 / Prompt Optimization"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setResult(null) }}
        width={780}
        footer={result ? [
          <Button key="cancel" onClick={() => { setModalOpen(false); setResult(null) }}>
            取消 / Cancel
          </Button>,
          <Button key="adopt" type="primary" onClick={handleAdopt}>
            采用优化版本 / Adopt ✨
          </Button>,
        ] : null}
      >
        {optimizing && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: '#8c8c8c', fontSize: 13 }}>
              LLM 正在压缩并翻译…
            </div>
          </div>
        )}

        {result && resultStats && (
          <div>
            {/* Before / After stats bar */}
            <div style={{
              display: 'flex', gap: 16, marginBottom: 16,
              padding: '10px 14px',
              background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 8,
              fontSize: 12,
            }}>
              <span>
                <strong>原版：</strong>
                <Tag color={getStatus(result.original_tokens, budget).emoji === '🔴' ? 'red' : getStatus(result.original_tokens, budget).emoji === '🟠' ? 'orange' : 'gold'}>
                  {result.original_tokens} tok
                </Tag>
                {result.original_chars} 字符
              </span>
              <span style={{ color: '#52c41a', fontWeight: 700 }}>→</span>
              <span>
                <strong>优化后：</strong>
                <Tag color="green">{result.optimized_tokens} tok</Tag>
                {result.optimized_chars} 字符
              </span>
              <span style={{ marginLeft: 'auto', color: '#52c41a', fontWeight: 600 }}>
                节省 {result.original_tokens - result.optimized_tokens} tok
                （-{Math.round((1 - result.optimized_tokens / result.original_tokens) * 100)}%）
              </span>
            </div>

            {/* Two-column diff view */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#8c8c8c' }}>
                  原版 / Original
                </div>
                <textarea
                  readOnly
                  value={value}
                  rows={16}
                  style={{
                    width: '100%', fontFamily: 'monospace', fontSize: 12,
                    padding: 10, border: '1px solid #ffccc7', borderRadius: 6,
                    background: '#fff2f0', resize: 'none', lineHeight: 1.6,
                    color: '#595959',
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#52c41a' }}>
                  优化版 / Optimized ✨
                </div>
                <textarea
                  readOnly
                  value={result.optimized}
                  rows={16}
                  style={{
                    width: '100%', fontFamily: 'monospace', fontSize: 12,
                    padding: 10, border: '1px solid #b7eb8f', borderRadius: 6,
                    background: '#f6ffed', resize: 'none', lineHeight: 1.6,
                    color: '#262626',
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: '#8c8c8c' }}>
              💡 点击「采用优化版本」将替换编辑区内容。如需调整，采用后可继续手动编辑。
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

export default PromptTokenMeter
