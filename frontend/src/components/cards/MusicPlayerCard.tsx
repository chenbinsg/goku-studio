import React, { useRef, useState } from 'react'
import { Button, Progress, Alert, Tag, Tooltip } from 'antd'
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  SoundOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CardMessage } from '../../types/card'

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const STYLE_LABEL_KEYS: Record<string, string> = {
  auto: 'music_card_style_auto', orchestral: 'music_card_style_orchestral', piano: 'music_card_style_piano',
  electronic: 'music_card_style_electronic', acoustic: 'music_card_style_acoustic', jazz: 'music_card_style_jazz',
  pop: 'music_card_style_pop', ambient: 'music_card_style_ambient',
}

const TEMPO_LABEL_KEYS: Record<string, string> = {
  slow: 'music_card_tempo_slow', medium: 'music_card_tempo_medium', fast: 'music_card_tempo_fast',
}

const MusicPlayerCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as any
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [audioDuration, setAudioDuration] = useState(0)
  const [loading, setLoading] = useState(false)

  // Loading state
  if (card.status === 'loading') {
    return (
      <div style={{
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
        borderRadius: 12, padding: '20px 24px', color: '#fff', minWidth: 320,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <SoundOutlined style={{ fontSize: 24, color: '#a78bfa' }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>{t('music_card_loading_message')}</span>
        </div>
        <Progress
          percent={data?.progress ?? 0}
          strokeColor={{ '0%': '#a78bfa', '100%': '#60a5fa' }}
          trailColor='rgba(255,255,255,0.1)'
          showInfo={false}
        />
        <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
          {data?.message ?? t('music_card_loading_wait')}
        </div>
      </div>
    )
  }

  // Error state
  if (card.status === 'error') {
    return (
      <Alert
        type="warning"
        showIcon
        icon={<SoundOutlined />}
        message={t('music_card_generation_failed')}
        description={data?.error ?? '未知错误'}
        style={{ borderRadius: 8 }}
      />
    )
  }

  const audioUrl = data?.audio_url ?? ''
  const originalPrompt = data?.original_prompt ?? ''
  const style = data?.style ?? 'auto'
  const tempo = data?.tempo ?? 'medium'
  const duration = data?.duration ?? 0
  const genTime = data?.generation_time_s ?? 0
  const translated = data?.translated ?? false
  const finalPrompt = data?.final_prompt ?? ''

  const togglePlay = () => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
    } else {
      setLoading(true)
      audioRef.current.play().catch(() => setLoading(false))
    }
  }

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
  }

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setAudioDuration(audioRef.current.duration)
      setLoading(false)
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !audioDuration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = ratio * audioDuration
  }

  const formatTime = (s: number) => {
    if (!isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const progressPct = audioDuration > 0 ? (currentTime / audioDuration) * 100 : 0

  return (
    <div style={{
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      borderRadius: 12, padding: '20px 24px', color: '#fff',
      minWidth: 320, maxWidth: 520, boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 10,
          background: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <SoundOutlined style={{ fontSize: 22, color: '#fff' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {originalPrompt}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag color="purple" style={{ fontSize: 11 }}>{STYLE_LABEL_KEYS[style] ? t(STYLE_LABEL_KEYS[style]) : style}</Tag>
            <Tag color="blue" style={{ fontSize: 11 }}>{TEMPO_LABEL_KEYS[tempo] ? t(TEMPO_LABEL_KEYS[tempo]) : tempo}</Tag>
            <Tag color="geekblue" style={{ fontSize: 11 }}>{duration}{t('music_card_duration_suffix')}</Tag>
          </div>
        </div>
      </div>

      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={audioUrl}
        onPlay={() => { setPlaying(true); setLoading(false) }}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0) }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        preload="metadata"
      />

      {/* Waveform / progress bar */}
      <div
        onClick={handleSeek}
        style={{
          height: 6, borderRadius: 3, cursor: 'pointer', marginBottom: 6,
          background: 'rgba(255,255,255,0.15)', position: 'relative', overflow: 'hidden',
        }}
      >
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${progressPct}%`,
          background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
          borderRadius: 3, transition: 'width 0.2s linear',
        }} />
      </div>

      {/* Time labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between',
        fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 14 }}>
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(audioDuration || duration)}</span>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          type="primary"
          shape="circle"
          size="large"
          onClick={togglePlay}
          icon={loading
            ? <LoadingOutlined />
            : playing
              ? <PauseCircleOutlined />
              : <PlayCircleOutlined />}
          style={{
            background: 'linear-gradient(135deg, #a78bfa, #60a5fa)',
            border: 'none', width: 44, height: 44,
          }}
        />

        <div style={{ flex: 1 }} />

        <Tooltip title={t('music_card_regenerate_tooltip')}>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            ghost
            onClick={() => onAction(card.card_id, 'regenerate', { prompt: originalPrompt })}
            style={{ color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.3)' }}
          >
            {t('music_card_regenerate_button')}
          </Button>
        </Tooltip>

        <Tooltip title={t('music_card_download_tooltip')}>
          <Button
            icon={<DownloadOutlined />}
            size="small"
            ghost
            onClick={() => {
              const a = document.createElement('a')
              a.href = audioUrl
              a.download = data?.filename || 'music.mp3'
              a.click()
            }}
            style={{ color: 'rgba(255,255,255,0.7)', borderColor: 'rgba(255,255,255,0.3)' }}
          />
        </Tooltip>
      </div>

      {/* Prompt details */}
      {translated && finalPrompt && (
        <div style={{
          marginTop: 14, padding: '8px 12px',
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 8, fontSize: 11, color: 'rgba(255,255,255,0.45)',
        }}>
          🎵 {finalPrompt}
        </div>
      )}

      {/* Footer info */}
      <div style={{
        marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.3)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>MusicGen · {data?.provider ?? 'replicate'}</span>
        {genTime > 0 && <span>{t('music_card_generation_time_label')} {genTime}s</span>}
      </div>
    </div>
  )
}

export default MusicPlayerCard
