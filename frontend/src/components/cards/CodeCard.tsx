import React, { useState } from 'react'
import { Card, Typography, Space, Button, message } from 'antd'
import { CopyOutlined, PlayCircleOutlined, CheckCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, CodeCardData } from '../../types/card'

const { Text } = Typography

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const CodeCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as CodeCardData
  const [executing, setExecuting] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(data.code).then(() => {
      message.success(t('code_card_copy_success'))
    })
  }

  const handleExecute = () => {
    setExecuting(true)
    onAction(card.card_id, 'execute', { language: data.language, code: data.code })
    setTimeout(() => setExecuting(false), 10000)
  }

  return (
    <Card size="small" style={{ margin: '8px 0' }} bodyStyle={{ padding: 0 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 12px',
        background: '#f5f5f5',
        borderBottom: '1px solid #e8e8e8',
      }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{data.language}</Text>
        <Space size={4}>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={handleCopy}>{t('code_card_copy_button')}</Button>
          <Button
            size="small"
            type="text"
            icon={executing ? <LoadingOutlined /> : <PlayCircleOutlined />}
            onClick={handleExecute}
            disabled={executing}
          >
            {t('code_card_execute_button')}
          </Button>
        </Space>
      </div>

      <pre style={{
        margin: 0,
        padding: 12,
        background: '#282c34',
        color: '#abb2bf',
        fontSize: 13,
        fontFamily: "'Consolas', 'Monaco', monospace",
        overflow: 'auto',
        maxHeight: 300,
      }}>
        {data.code}
      </pre>

      {data.execution_result && (
        <div style={{
          padding: 8,
          background: data.execution_result.exit_code === 0 ? '#f6ffed' : '#fff2f0',
          borderTop: '1px solid #e8e8e8',
        }}>
          <Space size={4} style={{ marginBottom: 4 }}>
            {data.execution_result.exit_code === 0
              ? <CheckCircleFilled style={{ color: '#52c41a' }} />
              : <Text type="danger">Exit: {data.execution_result.exit_code}</Text>
            }
            <Text type="secondary" style={{ fontSize: 11 }}>
              {(data.execution_result.duration_ms / 1000).toFixed(1)}s
            </Text>
          </Space>
          <pre style={{
            margin: 0,
            fontSize: 12,
            fontFamily: "'Consolas', 'Monaco', monospace",
            whiteSpace: 'pre-wrap',
            maxHeight: 200,
            overflow: 'auto',
          }}>
            {data.execution_result.output}
          </pre>
        </div>
      )}
    </Card>
  )
}

export default CodeCard
