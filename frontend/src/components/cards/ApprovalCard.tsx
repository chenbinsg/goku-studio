import React, { useState } from 'react'
import { Card, Tag, Typography, Space, Button, Input, Popconfirm } from 'antd'
import { WarningOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, ApprovalCardData } from '../../types/card'

const { Text } = Typography

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const RISK_COLORS: Record<string, string> = {
  low: '#52c41a',
  medium: '#faad14',
  high: '#fa8c16',
  critical: '#f5222d',
}

const RISK_LABEL_KEYS: Record<string, string> = {
  low: 'approval_card_risk_low',
  medium: 'approval_card_risk_medium',
  high: 'approval_card_risk_high',
  critical: 'approval_card_risk_critical',
}

const ApprovalCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as ApprovalCardData
  const [comment, setComment] = useState('')
  const riskColor = RISK_COLORS[data.risk_level] || RISK_COLORS.medium
  const isPending = data.status === 'pending'

  return (
    <Card
      size="small"
      style={{
        margin: '8px 0',
        borderLeft: `3px solid ${riskColor}`,
        background: !isPending ? '#fafafa' : undefined,
        opacity: !isPending ? 0.8 : 1,
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <WarningOutlined style={{ color: riskColor }} />
            <Text strong>{t('approval_card_title')}</Text>
          </Space>
          <Tag color={riskColor} style={{ color: '#fff' }}>
            {RISK_LABEL_KEYS[data.risk_level] ? t(RISK_LABEL_KEYS[data.risk_level]) : data.risk_level}
          </Tag>
        </div>

        <div style={{ fontSize: 12 }}>
          <div><Text type="secondary">{t('approval_card_action_label')}:</Text> <Text code>{data.operation_type}</Text></div>
          {data.command && <div><Text type="secondary">{t('approval_card_command_label')}:</Text> <Text code>{data.command}</Text></div>}
          <div><Text type="secondary">{t('approval_card_description_label')}:</Text> {data.description}</div>
          <div><Text type="secondary">{t('approval_card_requester_label')}:</Text> {data.requester}</div>
        </div>

        {!isPending && (
          <Space>
            {data.status === 'approved'
              ? <><CheckCircleFilled style={{ color: '#52c41a' }} /><Text type="success">{t('approval_card_approved_status')}</Text></>
              : <><CloseCircleFilled style={{ color: '#ff4d4f' }} /><Text type="danger">{t('approval_card_rejected_status')}</Text></>
            }
            {data.comment && <Text type="secondary" style={{ fontSize: 11 }}>- {data.comment}</Text>}
          </Space>
        )}

        {isPending && (
          <>
            <Input.TextArea
              rows={1}
              placeholder={t('approval_card_comment_placeholder')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              style={{ fontSize: 12 }}
            />
            <Space>
              <Popconfirm
                title={t('approval_card_reject_confirm')}
                onConfirm={() => onAction(card.card_id, 'reject', { approval_id: data.approval_id, comment })}
              >
                <Button size="small" danger>{t('approval_card_reject_button')}</Button>
              </Popconfirm>
              <Popconfirm
                title={t('approval_card_approve_confirm')}
                onConfirm={() => onAction(card.card_id, 'approve', { approval_id: data.approval_id, comment })}
              >
                <Button size="small" type="primary">{t('approval_card_approve_button')}</Button>
              </Popconfirm>
            </Space>
          </>
        )}
      </Space>
    </Card>
  )
}

export default ApprovalCard
