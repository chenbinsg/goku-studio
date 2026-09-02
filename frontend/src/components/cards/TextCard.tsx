import React from 'react'
import { Card, Typography, Button, Space, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, TextCardData } from '../../types/card'
import CollapsibleBody from './CollapsibleBody'

const { Text } = Typography

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

/**
 * A long piece of text, shown in the conversation rather than summarised into
 * it — a skill body, a rendered document, anything the reader wants verbatim.
 *
 * Deliberately not the code card: that one offers to execute what it shows,
 * which is wrong for prose, and deliberately not the article card, whose shape
 * demands word counts and reading times a document may not have.
 */
const TextCard: React.FC<Props> = ({ card }) => {
  const { t } = useTranslation()
  const data = card.data as TextCardData

  const handleCopy = () => {
    navigator.clipboard.writeText(data.body).then(
      () => message.success(t('text_card_copied', '已复制')),
      () => message.error(t('text_card_copy_failed', '复制失败,请手动选中复制')),
    )
  }

  return (
    <Card
      size="small"
      style={{ margin: '8px 0' }}
      bodyStyle={{ padding: 0 }}
      title={
        <Space size={8} align="baseline">
          <Text strong style={{ fontSize: 13 }}>{data.title}</Text>
          {data.subtitle && (
            <Text type="secondary" style={{ fontSize: 12 }}>{data.subtitle}</Text>
          )}
        </Space>
      }
      extra={
        <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
          {t('text_card_copy', '复制')}
        </Button>
      }
    >
      <CollapsibleBody maxHeight={data.max_height || 320}>
        <pre
          style={{
            margin: 0,
            padding: '12px 16px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: "'SFMono-Regular', Consolas, Menlo, monospace",
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          {data.body}
        </pre>
      </CollapsibleBody>
    </Card>
  )
}

export default TextCard
