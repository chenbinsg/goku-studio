import React, { useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Tag, Tooltip } from 'antd'
import {
  SoundOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import type { CardMessage, VoiceResultCardData } from '../../types/card'

interface Props {
  card: CardMessage
  onAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
}

const VOICE_LABELS: Record<string, string> = {
  alloy: 'Alloy', echo: 'Echo', fable: 'Fable',
  onyx: 'Onyx', nova: 'Nova', shimmer: 'Shimmer', mock: 'Mock',
}

const VoicePlayerCard: React.FC<Props> = ({ card, onAction }) => {
  const { t } = useTranslation()
  const data = card.data as VoiceResultCardData
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying]         = useState(false)
  const [loading, setLoading]         = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [totalDur, setTotalDur]       = useState(data?.duration_s ?? 0)
  const [expanded, setExpanded]       = useState(false)

  // Auto-play once audio is ready
  useEffect(() => {
    if (card.status === 'ready' && data?.auto_play && audioRef.current) {
      setLoading(true)
      audioRef.current.play().catch(() => setLoading(false))
    }
  }, [card.status, data?.auto_play])

  if (card.status === 'loading') {
    return (
      <div style={containerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LoadingOutlined style={{ fontSize: 20, color: '#34d399' }} />
          <span style={{ fontSize: 14, color: '#d1fae5' }}>{t('card_voice_synthesizing')}</span>
        </div>
      </div>
    )
  }

  if (card.status === 'error') {
    return (
      <Alert
        type="warning"
        showIcon
        icon={<SoundOutlined />}
        message={t('card_voice_failed')}
        description={data?.error ?? t('card_unknown_error')}
        style={{ borderRadius: 8 }}
      />
    )
  }

  const audioUrl = data?.audio_url ?? ''
  const text     = data?.text ?? ''
  const voice    = data?.voice ?? 'alloy'
  const provider = data?.provider ?? ''
  const genTime  = data?.generation_time_s ?? 0
  const isMock   = provider === 'mock' || voice === 'mock'

  const progressPct = totalDur > 0 ? Math.min((currentTime / totalDur) * 100, 100) : 0

  const togglePlay = () => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
    } else {
      setLoading(true)
      audioRef.current.play().catch(() => setLoading(false))
    }
  }

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !totalDur) return
    const rect = e.currentTarget.getBoundingClientRect()
    audioRef.current.currentTime = ((e.clientX - rect.left) / rect.width) * totalDur
  }

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const PREVIEW_LEN = 80
  const textShort   = text.length > PREVIEW_LEN ? text.slice(0, PREVIEW_LEN) + '…' : text
  const needExpand  = text.length > PREVIEW_LEN

  return (
    <div style={containerStyle}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        {/* Icon */}
        <div style={{
          width: 44, height: 44, borderRadius: 10, flexShrink: 0,
          background: 'linear-gradient(135deg, #059669, #10b981)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <SoundOutlined style={{ fontSize: 20, color: '#fff' }} />
        </div>

        {/* Text preview */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13, color: '#d1fae5', lineHeight: 1.5,
            wordBreak: 'break-all',
          }}>
            {expanded ? text : textShort}
            {needExpand && (
              <span
                onClick={() => setExpanded(p => !p)}
                style={{ color: '#34d399', cursor: 'pointer', marginLeft: 4, fontSize: 12 }}
              >
                {expanded ? t('card_collapse') : t('card_expand')}
              </span>
            )}
          </div>

          {/* Tags */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <Tag color={isMock ? 'default' : 'green'} style={{ fontSize: 11 }}>
              {VOICE_LABELS[voice] ?? voice}
            </Tag>
            {isMock && (
              <Tag color="orange" style={{ fontSize: 11 }}>{t('card_mock_mode')}</Tag>
            )}
            <Tag color="cyan" style={{ fontSize: 11 }}>
              ~{totalDur.toFixed(1)}s
            </Tag>
          </div>
        </div>
      </div>

      {/* Hidden audio */}
      <audio
        ref={audioRef}
        src={audioUrl}
        onPlay={() => { setPlaying(true); setLoading(false) }}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setCurrentTime(0) }}
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => {
          if (audioRef.current) setTotalDur(audioRef.current.duration)
          setLoading(false)
        }}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        preload="auto"
      />

      {/* Progress bar */}
      <div
        onClick={handleSeek}
        style={{
          height: 5, borderRadius: 3, cursor: 'pointer',
          background: 'rgba(255,255,255,0.12)', position: 'relative',
          overflow: 'hidden', marginBottom: 5,
        }}
      >
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${progressPct}%`,
          background: 'linear-gradient(90deg, #059669, #34d399)',
          borderRadius: 3, transition: 'width 0.2s linear',
        }} />
      </div>

      {/* Time labels */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 12,
      }}>
        <span>{fmt(currentTime)}</span>
        <span>{fmt(totalDur)}</span>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
            background: 'linear-gradient(135deg, #059669, #10b981)',
            border: 'none', width: 42, height: 42,
          }}
        />

        <div style={{ flex: 1 }} />

        <Tooltip title={t('card_download_audio')}>
          <Button
            icon={<DownloadOutlined />}
            size="small"
            ghost
            onClick={() => {
              const a = document.createElement('a')
              a.href = audioUrl
              a.download = data?.filename || 'voice.mp3'
              a.click()
              onAction(card.card_id, 'download', { filename: data?.filename })
            }}
            style={{ color: 'rgba(255,255,255,0.65)', borderColor: 'rgba(255,255,255,0.25)' }}
          />
        </Tooltip>
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.28)',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>TTS · {provider || 'openai'}</span>
        {genTime > 0 && <span>{t('card_gen_time', { n: genTime })}</span>}
      </div>
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #064e3b 0%, #065f46 50%, #047857 100%)',
  borderRadius: 12,
  padding: '18px 20px',
  color: '#fff',
  minWidth: 300,
  maxWidth: 480,
  boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
}

export default VoicePlayerCard
