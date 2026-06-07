/**
 * LLMHealthBadge
 * Shows the primary and secondary LLM status as two inline pills.
 * Checks once on mount (2 s delay) and on manual "re-check" click.
 * No auto-polling — the upstream LLM health endpoint can be rate-limited
 * (e.g. ngrok free tier) and 30 s polling was exhausting the quota.
 *
 *   ● gpt-4o-mini   ● qwen2.5-7b
 *   (green/red)      (green/red)
 */

import React, { useEffect, useState } from 'react'
import { Popover, Space, Typography } from 'antd'
import { api } from '../api'

const { Text } = Typography

const INIT_MS = 2_000

interface LLMStatus {
  status: 'ok' | 'degraded' | 'error' | 'checking'
  model: string
  provider: string
  base_url: string
  latency_ms: number
  error: string | null
}

const CHECKING: LLMStatus = {
  status: 'checking', model: '…', provider: '…',
  base_url: '', latency_ms: 0, error: null,
}

function dotColor(s: LLMStatus) {
  if (s.status === 'checking')  return '#d9d9d9'
  if (s.status === 'error')     return '#ff4d4f'
  if (s.status === 'degraded')  return '#faad14'
  if (s.latency_ms > 2000)      return '#faad14'
  return '#52c41a'
}

function shortModel(model: string) {
  // Truncate long model names: "qwen2.5-7b-instruct" → "qwen2.5-7b"
  return model.length > 14 ? model.slice(0, 13) + '…' : model
}

function DetailTable({ info, label }: { info: LLMStatus; label: string }) {
  const color = dotColor(info)
  return (
    <div style={{ minWidth: 240, fontSize: 13, marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color, fontSize: 16, lineHeight: 1 }}>●</span>
        <Text strong style={{ fontSize: 13 }}>
          {label}: {
            info.status === 'ok' ? 'Healthy' :
            info.status === 'degraded' ? 'Degraded (fallback)' :
            info.status === 'error' ? 'Unavailable' : 'Checking…'
          }
        </Text>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {([
            ['Model',    info.model],
            ['Provider', info.provider],
            ['Endpoint', info.base_url || '—'],
            ['Latency',  info.status === 'ok' || info.status === 'degraded' ? `${info.latency_ms} ms` : '—'],
          ] as [string, string][]).map(([k, v]) => (
            <tr key={k}>
              <td style={{ color: '#8c8c8c', paddingRight: 12, paddingBottom: 4, whiteSpace: 'nowrap' }}>{k}</td>
              <td style={{ wordBreak: 'break-all', paddingBottom: 4 }}>{v}</td>
            </tr>
          ))}
          {info.error && (
            <tr>
              <td style={{ color: '#ff4d4f', paddingRight: 12, verticalAlign: 'top', whiteSpace: 'nowrap' }}>Error</td>
              <td style={{ color: '#ff4d4f', wordBreak: 'break-word' }}>
                {info.error}
                {/* Explain cross-provider failure: gpt model red because qwen is down */}
                {info.status === 'error' && info.error.includes('Provider') && (
                  <div style={{ marginTop: 4, color: '#fa8c16', fontSize: 12 }}>
                    ℹ️ This model routes through the local LLM gateway. The gateway's upstream provider is down, making this model unavailable.
                  </div>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function LLMPill({
  info, label, onClick,
}: { info: LLMStatus; label: string; onClick: () => void }) {
  const color = dotColor(info)
  const isError = info.status === 'error'
  const isChecking = info.status === 'checking'
  const isDegraded = info.status === 'degraded'
  const bg = isError ? '#fff1f0' : isDegraded ? '#fffbe6' : isChecking ? '#fafafa' : '#f6ffed'
  const border = isError ? '#ffa39e' : isDegraded ? '#ffe58f' : isChecking ? '#d9d9d9' : '#b7eb8f'
  return (
    <div
      onClick={onClick}
      title={label}
      style={{
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 10,
        background: bg,
        border: `1px solid ${border}`,
        transition: 'all 0.3s',
        userSelect: 'none',
      }}
    >
      <span style={{ color, fontSize: 9, lineHeight: 1 }}>●</span>
      <Text style={{ fontSize: 11, color: '#595959' }}>
        {isChecking ? '…' : shortModel(info.model)}
      </Text>
      {info.status === 'ok' && info.latency_ms > 0 && (
        <Text style={{ fontSize: 10, color: '#8c8c8c' }}>{info.latency_ms}ms</Text>
      )}
    </div>
  )
}

export const LLMHealthBadge: React.FC = () => {
  const [primary,   setPrimary]   = useState<LLMStatus>(CHECKING)
  const [secondary, setSecondary] = useState<LLMStatus | null>(null)
  const [open, setOpen]           = useState(false)

  const probe = async () => {
    try {
      const data = await api.get<{ primary: LLMStatus; secondary: LLMStatus | null }>('/llm/health')
      const d = data as any
      if (d.primary)   setPrimary(d.primary)
      if ('secondary' in d) setSecondary(d.secondary)
    } catch {
      setPrimary(prev => ({ ...prev, status: 'error', error: 'Health check failed' }))
    }
  }

  useEffect(() => {
    const t = setTimeout(probe, INIT_MS)
    return () => clearTimeout(t)
  }, [])

  const popoverContent = (
    <div>
      <DetailTable info={primary} label="Primary" />
      {secondary && (
        <>
          <div style={{ borderTop: '1px solid #f0f0f0', margin: '8px 0' }} />
          <DetailTable info={secondary} label="Secondary" />
        </>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: '#bfbfbf' }}>
        Checked on page load ·{' '}
        <span
          style={{ cursor: 'pointer', color: '#1677ff' }}
          onClick={() => { probe(); setOpen(false) }}
        >
          re-check now
        </span>
      </div>
    </div>
  )

  return (
    <Popover
      content={popoverContent}
      title={null}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
    >
      <Space size={4} style={{ cursor: 'pointer' }}>
        <LLMPill info={primary}   label="Primary LLM"   onClick={() => setOpen(o => !o)} />
        {secondary && (
          <LLMPill info={secondary} label="Secondary LLM" onClick={() => setOpen(o => !o)} />
        )}
      </Space>
    </Popover>
  )
}

export default LLMHealthBadge
