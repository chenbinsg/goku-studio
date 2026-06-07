import React, { useRef } from 'react'
import { Card, Space, Button, Typography, Tag, Progress, Alert, Spin } from 'antd'
import {
  VideoCameraOutlined,
  DownloadOutlined,
  ReloadOutlined,
  LoadingOutlined,
  TranslationOutlined,
  CheckCircleFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, VideoResultCardData } from '../../types/card'

const { Text } = Typography

const STYLE_LABEL_KEYS: Record<string, string> = {
  realistic:   'video_card_style_realistic',
  animation:   'video_card_style_animation',
  cinematic:   'video_card_style_cinematic',
  documentary: 'video_card_style_documentary',
}

const PROVIDER_LABEL_KEYS: Record<string, string> = {
  kling:   'video_card_provider_kling',
  runway:  'video_card_provider_runway',
  minimax: 'video_card_provider_minimax',
  mock:    'video_card_provider_mock',
}

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const VideoResultCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data      = card.data as VideoResultCardData
  const isLoading = card.status === 'loading'
  const isError   = card.status === 'error'
  const videoRef  = useRef<HTMLVideoElement>(null)

  const handleDownload = () => {
    if (data.video_url) {
      const a    = document.createElement('a')
      a.href     = data.video_url
      a.download = data.filename || 'video.mp4'
      a.target   = '_blank'
      a.click()
    }
  }

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
        background: 'linear-gradient(90deg, #fff1f0 0%, #f0f5ff 100%)',
        borderBottom: '1px solid #e8e8e8',
        borderRadius: '8px 8px 0 0',
      }}>
        <Space size={8}>
          <VideoCameraOutlined style={{ color: '#ff4d4f', fontSize: 16 }} />
          <Text strong style={{ fontSize: 14 }}>{t('video_card_header_title')}</Text>
          {isLoading && <Spin indicator={<LoadingOutlined style={{ fontSize: 14 }} spin />} />}
          {!isLoading && !isError && <CheckCircleFilled style={{ color: '#52c41a' }} />}
        </Space>
        {!isLoading && !isError && (
          <Space size={4}>
            <Button
              size="small" type="text"
              icon={<DownloadOutlined />}
              onClick={handleDownload}
            >
              {t('video_card_download_button')}
            </Button>
            <Button
              size="small" type="text"
              icon={<ReloadOutlined />}
              onClick={() => onAction(card.card_id, 'regenerate', { prompt: data.original_prompt })}
            >
              {t('video_card_regenerate_button')}
            </Button>
          </Space>
        )}
      </div>

      {/* Error state */}
      {isError && data.error && (
        <div style={{ padding: 12 }}>
          <Alert type="error" message={t('video_card_generation_failed')} description={data.error} showIcon />
        </div>
      )}

      {/* Loading / progress state */}
      {isLoading && (
        <div style={{ padding: '16px 20px' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {data.message || t('video_card_loading_message')}
            </Text>
            <Progress
              percent={data.progress || 0}
              strokeColor={{ '0%': '#ff4d4f', '100%': '#fa8c16' }}
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('video_card_loading_wait_message')}
            </Text>
          </Space>
        </div>
      )}

      {/* Ready state */}
      {!isLoading && !isError && data.video_url && (
        <>
          {/* Prompt info */}
          <div style={{
            padding: '6px 14px',
            background: '#fafafa',
            borderBottom: '1px solid #f0f0f0',
          }}>
            <Space size={8} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {data.original_prompt.slice(0, 70)}{data.original_prompt.length > 70 ? '...' : ''}
              </Text>
              {data.translated && (
                <Tag color="processing" icon={<TranslationOutlined />}>{t('video_card_translated_label')}</Tag>
              )}
              <Tag color="red">{STYLE_LABEL_KEYS[data.style] ? t(STYLE_LABEL_KEYS[data.style]) : data.style}</Tag>
              <Tag>{data.aspect_ratio}</Tag>
              <Tag>{data.duration}{t('video_card_duration_suffix')}</Tag>
              <Tag color="default">{PROVIDER_LABEL_KEYS[data.provider] ? t(PROVIDER_LABEL_KEYS[data.provider]) : data.provider}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('video_card_generation_time_label')} {data.generation_time_s}s
              </Text>
            </Space>
          </div>

          {/* Video player */}
          <div style={{ padding: 12, textAlign: 'center', background: '#000' }}>
            <video
              ref={videoRef}
              src={data.video_url}
              controls
              style={{
                maxWidth: '100%',
                maxHeight: 360,
                borderRadius: 4,
                display: 'block',
                margin: '0 auto',
              }}
            >
              {t('video_card_player_unsupported')}
            </video>
          </div>

          {/* Progress bar (completed) */}
          <div style={{ padding: '8px 14px' }}>
            <Progress
              percent={100}
              strokeColor="#52c41a"
              size="small"
              format={() => (
                <Text style={{ fontSize: 11, color: '#52c41a' }}>{t('video_card_progress_completed_label')}</Text>
              )}
            />
          </div>
        </>
      )}
    </Card>
  )
}

export default VideoResultCard
