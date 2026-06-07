import React, { useState } from 'react'
import { Card, Space, Button, Typography, Tag, Tooltip, Modal, message, Spin } from 'antd'
import {
  PictureOutlined,
  DownloadOutlined,
  ReloadOutlined,
  ZoomInOutlined,
  TranslationOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage, ImageGalleryCardData, ImageItem } from '../../types/card'
import { normalizeWorkspaceImageUrl } from '../../utils/workspaceMedia'

const { Text } = Typography

const STYLE_LABEL_KEYS: Record<string, string> = {
  vivid:      'image_card_style_vivid',
  natural:    'image_card_style_natural',
  anime:      'image_card_style_anime',
  realistic:  'image_card_style_realistic',
  sketch:     'image_card_style_sketch',
  watercolor: 'image_card_style_watercolor',
  oil:        'image_card_style_oil',
}

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const ImageGalleryCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as ImageGalleryCardData
  const isLoading = card.status === 'loading'
  const [preview, setPreview] = useState<ImageItem | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)

  const images: ImageItem[] = (data.images || []).map((img) => ({
    ...img,
    url: normalizeWorkspaceImageUrl(img.url) || '',
  })).filter((img) => !!img.url)
  const current = images[selectedIdx]

  const handleDownload = (img: ImageItem) => {
    if (!img.url) return
    const a      = document.createElement('a')
    a.href       = img.url
    a.download   = img.filename || `image_${img.index}.png`
    a.target     = '_blank'
    a.click()
    message.success(t('image_card_download_success'))
  }

  if (isLoading) {
    return (
      <Card size="small" style={{ margin: '8px 0', borderRadius: 8 }}>
        <Space style={{ padding: '16px 0', justifyContent: 'center', width: '100%' }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />} />
          <Text type="secondary">{t('image_card_loading')}</Text>
        </Space>
      </Card>
    )
  }

  return (
    <>
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
          background: 'linear-gradient(90deg, #fff7e6 0%, #fffbe6 100%)',
          borderBottom: '1px solid #e8e8e8',
          borderRadius: '8px 8px 0 0',
        }}>
          <Space size={8}>
            <PictureOutlined style={{ color: '#fa8c16', fontSize: 16 }} />
            <Text strong style={{ fontSize: 14 }}>{t('image_card_header_title')}</Text>
            <Tag color="orange">{images.length} {t('image_card_image_count')}</Tag>
          </Space>
          <Space size={4}>
            {current && (
              <Button
                size="small" type="text"
                icon={<DownloadOutlined />}
                onClick={() => handleDownload(current)}
              >
                {t('image_card_download_button')}
              </Button>
            )}
            <Button
              size="small" type="text"
              icon={<ReloadOutlined />}
              onClick={() => onAction(card.card_id, 'regenerate', { prompt: data.original_prompt })}
            >
              {t('image_card_regenerate_button')}
            </Button>
          </Space>
        </div>

        {/* Prompt info */}
        <div style={{
          padding: '6px 14px',
          background: '#fafafa',
          borderBottom: '1px solid #f0f0f0',
        }}>
          <Space size={8} wrap>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Prompt: <Text style={{ fontSize: 12 }} ellipsis>
                {data.original_prompt.slice(0, 80)}{data.original_prompt.length > 80 ? '...' : ''}
              </Text>
            </Text>
            {data.translated && (
              <Tooltip title={`${t('image_card_translated_tooltip')}：${data.final_prompt}`}>
                <Tag color="processing" icon={<TranslationOutlined />} style={{ cursor: 'pointer' }}>
                  {t('image_card_translated_label')}
                </Tag>
              </Tooltip>
            )}
            <Tag>{STYLE_LABEL_KEYS[data.style] ? t(STYLE_LABEL_KEYS[data.style]) : data.style}</Tag>
            <Tag>{data.size}</Tag>
            {data.quality === 'hd' && <Tag color="gold">HD</Tag>}
            <Text type="secondary" style={{ fontSize: 12 }}>{t('image_card_duration_label')} {data.duration_s}s</Text>
          </Space>
        </div>

        {/* Image display */}
        <div style={{ padding: 12 }}>
          {/* Main image */}
          {current && (
            <div style={{ position: 'relative', textAlign: 'center', marginBottom: 8 }}>
              <img
                src={current.url}
                alt={`${t('image_card_generated_image_alt')} ${current.index}`}
                style={{
                  maxWidth: '100%',
                  maxHeight: 360,
                  borderRadius: 6,
                  cursor: 'zoom-in',
                  objectFit: 'contain',
                  border: '1px solid #f0f0f0',
                }}
                onClick={() => setPreview(current)}
              />
              <Tooltip title={t('image_card_view_original_tooltip')}>
                <Button
                  size="small"
                  icon={<ZoomInOutlined />}
                  style={{
                    position: 'absolute',
                    bottom: 8,
                    right: 8,
                    background: 'rgba(0,0,0,0.45)',
                    color: '#fff',
                    border: 'none',
                  }}
                  onClick={() => setPreview(current)}
                />
              </Tooltip>
            </div>
          )}

          {/* Thumbnails for multiple images */}
          {images.length > 1 && (
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
              {images.map((img, idx) => (
                <img
                  key={img.index}
                  src={img.url}
                  alt={`${t('image_card_thumbnail_alt')} ${img.index}`}
                  style={{
                    width: 60,
                    height: 60,
                    objectFit: 'cover',
                    borderRadius: 4,
                    cursor: 'pointer',
                    border: `2px solid ${idx === selectedIdx ? '#1677ff' : '#f0f0f0'}`,
                    transition: 'border-color 0.2s',
                  }}
                  onClick={() => setSelectedIdx(idx)}
                />
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Full-size preview modal */}
      <Modal
        open={!!preview}
        footer={null}
        onCancel={() => setPreview(null)}
        width="80vw"
        style={{ maxWidth: 1000 }}
        centered
        title={
          <Space>
            <PictureOutlined />
            <Text>{data.original_prompt.slice(0, 50)}</Text>
          </Space>
        }
      >
        {preview && (
          <div style={{ textAlign: 'center' }}>
            <img
              src={preview.url}
              alt={t('image_card_original_image_alt')}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
            <div style={{ marginTop: 12 }}>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => handleDownload(preview)}
              >
                {t('image_card_download_original')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}

export default ImageGalleryCard
