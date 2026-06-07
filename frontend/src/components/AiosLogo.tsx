import React from 'react'

// logo.png natural dimensions: 2283 × 976
const LOGO_ASPECT = 2283 / 976  // ≈ 2.34

// Sidebar width is 220px. With 12px padding each side, available width = 196px.
const SIDEBAR_AVAILABLE_W = 196
const SIDEBAR_AVAILABLE_W_COLLAPSED = 56

interface AiosLogoProps {
  collapsed?: boolean
  size?: number
  inline?: boolean
  wide?: boolean
}

const AiosLogo: React.FC<AiosLogoProps> = ({ collapsed = false, size = 36, inline = false }) => {
  if (inline) {
    const h = size
    const w = Math.round(h * LOGO_ASPECT)
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: w, height: h }}>
        <img src="/logo.png" alt="AIOS" width={w} height={h} style={{ objectFit: 'contain' }} />
      </div>
    )
  }

  // Sidebar mode: always fit to available width so nothing is clipped
  const imgW = collapsed ? SIDEBAR_AVAILABLE_W_COLLAPSED : SIDEBAR_AVAILABLE_W
  const imgH = Math.round(imgW / LOGO_ASPECT)   // collapsed ≈ 24px, expanded ≈ 84px

  return (
    <div
      style={{
        height: collapsed ? 52 : 64,   // mirrors Header height (52px mobile / 64px desktop)
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: collapsed ? '0 8px' : '0 12px',
        background: 'rgba(255,255,255,0.06)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0,
      }}
    >
      <img
        src="/logo.png"
        alt="AIOS"
        width={imgW}
        height={imgH}
        style={{ objectFit: 'contain' }}
      />
    </div>
  )
}

export default AiosLogo
