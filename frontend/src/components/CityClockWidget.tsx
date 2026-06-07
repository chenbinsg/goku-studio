import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

interface CityClockWidgetProps {
  isDark?: boolean
}

const CityClockWidget: React.FC<CityClockWidgetProps> = ({ isDark = false }) => {
  const { i18n } = useTranslation()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const locale = i18n.language === 'zh' ? 'zh-CN' : i18n.language === 'ja' ? 'ja-JP' : 'en-GB'

  const timeStr = useMemo(() => now.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }), [now, locale])

  const dateStr = useMemo(() => now.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }), [now, locale])

  const muted = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.38)'
  const strong = isDark ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.75)'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1.2 }}>
      <span style={{ fontSize: 14, color: strong, fontVariantNumeric: 'tabular-nums', fontWeight: 600, letterSpacing: '0.5px' }}>{timeStr}</span>
      <span style={{ fontSize: 11, color: muted }}>{dateStr}</span>
    </div>
  )
}

export default CityClockWidget
