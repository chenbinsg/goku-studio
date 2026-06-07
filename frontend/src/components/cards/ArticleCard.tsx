import React, { useState } from 'react'
import { Card, Tag, Space, Button, Typography, Divider, message, Tooltip } from 'antd'
import {
  FileTextOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  EditOutlined,
  ClockCircleOutlined,
  ReadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, ArticleCardData } from '../../types/card'

const { Text } = Typography

const ARTICLE_TYPE_COLORS: Record<string, string> = {
  blog:     'blue',
  report:   'purple',
  email:    'green',
  proposal: 'orange',
  summary:  'cyan',
  doc:      'geekblue',
  news:     'volcano',
  other:    'default',
}

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const ArticleCard: React.FC<Props> = ({ card }) => {
  const { t } = useTranslation()
  const data = card.data as ArticleCardData
  const [preview, setPreview] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(data.content).then(() => {
      message.success(t('article_card_copy_success'))
    })
  }

  const handleDownload = () => {
    const blob = new Blob([data.content], { type: 'text/markdown;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `${data.topic.slice(0, 40).replace(/[/\\:*?"<>|]/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
    message.success(t('article_card_download_success'))
  }

  const tagColor = ARTICLE_TYPE_COLORS[data.article_type] || 'default'

  return (
    <Card
      size="small"
      style={{ margin: '8px 0', border: '1px solid #e8e8e8', borderRadius: 8 }}
      bodyStyle={{ padding: 0 }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'linear-gradient(90deg, #f0f5ff 0%, #f9f0ff 100%)',
        borderBottom: '1px solid #e8e8e8',
        borderRadius: '8px 8px 0 0',
      }}>
        <Space size={8}>
          <FileTextOutlined style={{ color: '#6366f1', fontSize: 16 }} />
          <Text strong style={{ fontSize: 14, maxWidth: 280 }} ellipsis={{ tooltip: data.topic }}>
            {data.topic}
          </Text>
        </Space>
        <Space size={4}>
          <Tooltip title={t('article_card_copy_tooltip')}>
            <Button
              size="small" type="text"
              icon={preview ? <EditOutlined /> : <EyeOutlined />}
              onClick={() => setPreview(v => !v)}
            >
              {preview ? t('article_card_source_label') : t('article_card_preview_label')}
            </Button>
          </Tooltip>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={handleCopy}>{t('article_card_copy_button')}</Button>
          <Button size="small" type="text" icon={<DownloadOutlined />} onClick={handleDownload}>{t('article_card_download_button')}</Button>
        </Space>
      </div>

      {/* Meta info bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 14px',
        background: '#fafafa',
        borderBottom: '1px solid #f0f0f0',
        flexWrap: 'wrap',
      }}>
        <Tag color={tagColor} style={{ margin: 0 }}>{data.type_name}</Tag>
        <Space size={4}>
          <ReadOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>{data.word_count.toLocaleString()} {t('article_card_word_count')}</Text>
        </Space>
        <Space size={4}>
          <ClockCircleOutlined style={{ color: '#8c8c8c', fontSize: 12 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>约 {data.read_minutes} {t('article_card_read_time')}</Text>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>{t('article_card_duration')} {data.duration_s}s</Text>
        {data.language !== '中文' && (
          <Tag style={{ margin: 0 }}>{data.language}</Tag>
        )}
      </div>

      {/* Content area */}
      <div style={{ padding: '12px 14px', maxHeight: 400, overflow: 'auto' }}>
        {preview ? (
          // Simple Markdown-ish rendering using dangerouslySetInnerHTML would need a lib
          // Using pre-wrap for now; real impl would use react-markdown
          <div
            style={{
              fontSize: 14,
              lineHeight: 1.8,
              color: '#262626',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {data.content}
          </div>
        ) : (
          <pre style={{
            margin: 0,
            fontSize: 13,
            fontFamily: "'Consolas', 'Monaco', monospace",
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: '#595959',
            lineHeight: 1.7,
          }}>
            {data.content}
          </pre>
        )}
      </div>

      {/* Footer divider */}
      <Divider style={{ margin: 0 }} />
      <div style={{ padding: '6px 14px', textAlign: 'right' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {t('article_card_footer')}
        </Text>
      </div>
    </Card>
  )
}

export default ArticleCard
