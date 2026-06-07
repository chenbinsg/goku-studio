import React, { useState, useEffect, useRef } from 'react'
import { Card, Button, Space, Typography, message, Progress, Tag } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  CopyOutlined,
  ReloadOutlined,
  FileSearchOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, ToolExecutionCardData } from '../../types/card'

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const statusIcon = (status: ToolExecutionCardData['status']) => {
  switch (status) {
    case 'completed': return <CheckCircleOutlined style={{ color: '#52c41a' }} />
    case 'failed':    return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
    case 'running':   return <LoadingOutlined style={{ color: '#1890ff' }} />
  }
}

const SCORING_STEP_KEYS = [
  { name: 'biz_background',      labelKey: 'tool_card_prd_dimension_biz_background',   descKey: 'tool_card_prd_dimension_biz_background_desc' },
  { name: 'user_role',           labelKey: 'tool_card_prd_dimension_user_role',         descKey: 'tool_card_prd_dimension_user_role_desc' },
  { name: 'business_flow',       labelKey: 'tool_card_prd_dimension_business_flow',     descKey: 'tool_card_prd_dimension_business_flow_desc' },
  { name: 'functional_req',      labelKey: 'tool_card_prd_dimension_functional_req',    descKey: 'tool_card_prd_dimension_functional_req_desc' },
  { name: 'data_model',          labelKey: 'tool_card_prd_dimension_data_model',        descKey: 'tool_card_prd_dimension_data_model_desc' },
  { name: 'api_integration',     labelKey: 'tool_card_prd_dimension_api_integration',   descKey: 'tool_card_prd_dimension_api_integration_desc' },
  { name: 'nonfunctional',       labelKey: 'tool_card_prd_dimension_nonfunctional',     descKey: 'tool_card_prd_dimension_nonfunctional_desc' },
  { name: 'acceptance_criteria', labelKey: 'tool_card_prd_dimension_acceptance',        descKey: 'tool_card_prd_dimension_acceptance_desc' },
  { name: 'ai_constraints',      labelKey: 'tool_card_prd_dimension_ai_constraints',    descKey: 'tool_card_prd_dimension_ai_constraints_desc' },
  { name: 'test_design',         labelKey: 'tool_card_prd_dimension_test_design',       descKey: 'tool_card_prd_dimension_test_design_desc' },
]

// ── PRD scoring progress panel (shown while tool is running) ──────────────────────
const ScoringProgress: React.FC = () => {
  const { t } = useTranslation()
  const [step, setStep] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setStep(prev => (prev < SCORING_STEP_KEYS.length - 1 ? prev + 1 : prev))
    }, 180)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const pct = Math.round((step + 1) / SCORING_STEP_KEYS.length * 100)

  return (
    <div style={{
      background: '#f0f5ff', border: '1px solid #d6e4ff',
      borderRadius: 8, padding: '12px 14px', marginTop: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <FileSearchOutlined style={{ color: '#1890ff', fontSize: 16 }} />
        <Typography.Text strong style={{ color: '#1890ff', fontSize: 13, flex: 1 }}>
          {t('tool_card_prd_scoring_title')}
        </Typography.Text>
        <LoadingOutlined style={{ color: '#1890ff' }} spin />
      </div>
      <Progress
        percent={pct}
        strokeColor={{ '0%': '#1890ff', '100%': '#52c41a' }}
        size="small"
        style={{ marginBottom: 10 }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {SCORING_STEP_KEYS.map((s, i) => {
          const done   = i < step
          const active = i === step
          return (
            <div key={s.name} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 8px', borderRadius: 5, fontSize: 11,
              background: done ? '#f6ffed' : active ? '#e6f7ff' : '#fafafa',
              border: `1px solid ${done ? '#b7eb8f' : active ? '#91d5ff' : '#f0f0f0'}`,
              color: done ? '#389e0d' : active ? '#1890ff' : '#bbb',
              fontWeight: active ? 600 : 400,
              transition: 'all 0.25s',
            }}>
              <span style={{ flexShrink: 0, width: 14, textAlign: 'center' }}>
                {done
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : active
                    ? <LoadingOutlined style={{ color: '#1890ff' }} spin />
                    : '○'
                }
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t(s.labelKey)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── PRD score result panel (shown after completion) ───────────────────────────
const PRDScoreResult: React.FC<{ result: any }> = ({ result }) => {
  const { t } = useTranslation()
  const dims: any[] = result.dimensions || []
  const total: number = result.total_score ?? result.overall_score ?? 0
  const verdict: string = result.verdict || ''
  const summary: string = result.summary || ''

  const scoreColor = (s: number) =>
    s >= 80 ? '#52c41a' : s >= 60 ? '#fa8c16' : '#ff4d4f'

  const verdictTag = verdict === 'passed'
    ? <Tag color="success">{t('tool_card_prd_verdict_passed')}</Tag>
    : verdict === 'rejected'
      ? <Tag color="error">{t('tool_card_prd_verdict_rejected')}</Tag>
      : <Tag color="warning">{t('tool_card_prd_verdict_needsimprovement')}</Tag>

  return (
    <div style={{ marginTop: 8 }}>
      {/* Total score header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px', background: '#fafafa',
        border: '1px solid #f0f0f0', borderRadius: 8, marginBottom: 10,
      }}>
        <span style={{ fontSize: 36, fontWeight: 700, lineHeight: 1, color: scoreColor(total) }}>
          {total.toFixed(1)}
        </span>
        <div>
          <div>{verdictTag}</div>
          {summary && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{summary}</Typography.Text>
          )}
        </div>
      </div>

      {/* Dimension bars */}
      {dims.map((d: any) => {
        const passed = (d.checklist || []).filter((c: any) => c.passed).length
        const total_c = (d.checklist || []).length
        return (
          <div key={d.name} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <Space size={4}>
                <Typography.Text strong style={{ fontSize: 12 }}>{d.label}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {Math.round(d.weight * 100)}%
                </Typography.Text>
                {total_c > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {passed}/{total_c}{t('tool_card_prd_items_passed')}
                  </Typography.Text>
                )}
              </Space>
              <Typography.Text strong style={{ fontSize: 12, color: scoreColor(d.score) }}>
                {d.score.toFixed(0)}分
              </Typography.Text>
            </div>
            <Progress percent={d.score} strokeColor={scoreColor(d.score)} showInfo={false} size="small" />
            {/* Failed checklist items */}
            {(d.checklist || []).filter((c: any) => !c.passed).map((c: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 5, fontSize: 11, padding: '2px 0', color: '#ff4d4f' }}>
                <span style={{ flexShrink: 0 }}>✗</span>
                <span>{c.item}{c.detail ? ` — ${c.detail}` : ''}</span>
              </div>
            ))}
          </div>
        )
      })}

      {/* Top improvements */}
      {result.top_improvements?.length > 0 && (
        <div style={{
          marginTop: 8, padding: '8px 12px',
          background: '#f0f5ff', border: '1px solid #d6e4ff', borderRadius: 6,
        }}>
          <Typography.Text strong style={{ fontSize: 12, color: '#1890ff', display: 'block', marginBottom: 4 }}>
            {t('tool_card_prd_top_improvements')}
          </Typography.Text>
          {result.top_improvements.map((imp: string, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 11, padding: '2px 0' }}>
              <span style={{ flexShrink: 0, color: '#1890ff' }}>{i + 1}.</span>
              <span style={{ color: '#333' }}>{imp}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main card ─────────────────────────────────────────────────────────────────
const ToolExecutionCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as ToolExecutionCardData
  const [showParams, setShowParams] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const isPRDScorer = data.tool_name === 'prd_scorer'
  const isRunning   = data.status === 'running'
  const hasPRDResult = isPRDScorer && data.status === 'completed' &&
    data.result?.dimensions?.length > 0

  const bgColor = data.status === 'completed' ? '#f6ffed'
    : data.status === 'failed' ? '#fff2f0' : undefined

  const handleCopy = () => {
    const text = typeof data.result === 'string'
      ? data.result
      : JSON.stringify(data.result, null, 2)
    navigator.clipboard.writeText(text || '').then(() => message.success(t('code_card_copy_success')))
  }

  const reExecuteAction = card.actions?.find(a => a.key === 're_execute' || a.key === 'reexecute')

  return (
    <Card size="small" style={{ margin: '8px 0', background: bgColor }}>
      {/* Header */}
      <div style={{ marginBottom: 8 }}>
        <Space>
          {statusIcon(data.status)}
          <Typography.Text code strong>{data.tool_name}</Typography.Text>
          {data.duration_ms != null && (
            <Typography.Text type="secondary">
              {(data.duration_ms / 1000).toFixed(1)}s
            </Typography.Text>
          )}
        </Space>
      </div>

      {/* Params toggle */}
      <div style={{ marginBottom: 4 }}>
        <Typography.Link onClick={() => setShowParams(!showParams)}>
          {showParams ? t('tool_card_hide_params') : t('tool_card_show_params')}
        </Typography.Link>
        {showParams && (
          <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 8, borderRadius: 4, maxHeight: 200, overflow: 'auto' }}>
            {JSON.stringify(data.parameters, null, 2)}
          </pre>
        )}
      </div>

      {/* PRD scorer: progress while running */}
      {isPRDScorer && isRunning && <ScoringProgress />}

      {/* PRD scorer: rich result */}
      {hasPRDResult && <PRDScoreResult result={data.result} />}

      {/* PRD scorer: raw JSON toggle */}
      {hasPRDResult && (
        <div style={{ marginTop: 4 }}>
          <Typography.Link onClick={() => setShowRaw(!showRaw)} style={{ fontSize: 11 }}>
            {showRaw ? t('tool_card_hide_raw_json') : t('tool_card_show_raw_json')}
          </Typography.Link>
          {showRaw && (
            <pre style={{ fontSize: 11, background: '#f5f5f5', padding: 8, borderRadius: 4, maxHeight: 300, overflow: 'auto' }}>
              {JSON.stringify(data.result, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Generic result (non-prd_scorer tools) */}
      {!isPRDScorer && data.result != null && (
        <div style={{ marginBottom: 4 }}>
          <Typography.Link onClick={() => setShowRaw(!showRaw)}>
            {showRaw ? t('tool_card_hide_result') : t('tool_card_show_result')}
          </Typography.Link>
          {showRaw && (
            <pre style={{ fontSize: 12, background: '#f5f5f5', padding: 8, borderRadius: 4, maxHeight: 200, overflow: 'auto' }}>
              {typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)}
            </pre>
          )}
        </div>
      )}

      {data.error && (
        <Typography.Text type="danger" style={{ display: 'block', marginBottom: 8 }}>
          {data.error}
        </Typography.Text>
      )}

      <Space style={{ marginTop: 8 }}>
        <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
          {t('tool_card_copy_result')}
        </Button>
        {reExecuteAction && (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => onAction(card.card_id, reExecuteAction.key, reExecuteAction.params)}
          >
            {t('tool_card_re_execute')}
          </Button>
        )}
      </Space>
    </Card>
  )
}

export default ToolExecutionCard
