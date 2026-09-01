import React from 'react'
import { theme } from 'antd'

// logo.png natural dimensions: 2283 × 976
const LOGO_ASPECT = 2283 / 976  // ≈ 2.34

// Sidebar is 220px wide; the bar insets 8px on the left, leaving 212px.
const SIDEBAR_AVAILABLE_W = 212
const SIDEBAR_AVAILABLE_W_COLLAPSED = 56

// Rendered logo height, shared with the chat top bar (ChatLayout: size={56}).
const LOGO_RENDER_H = 56

interface AiosLogoProps {
  collapsed?: boolean
  size?: number
  inline?: boolean
  wide?: boolean
}

const AiosLogo: React.FC<AiosLogoProps> = ({ collapsed = false, size = 36, inline = false }) => {
  const { token: { colorBorderSecondary } } = theme.useToken()
  if (inline) {
    const h = size
    const w = Math.round(h * LOGO_ASPECT)
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: w, height: h }}>
        <img src="/logo.png" alt="AIOS" width={w} height={h} style={{ objectFit: 'contain' }} />
      </div>
    )
  }

  // Sidebar mode: fit by HEIGHT so the whole logo is visible — sizing by width
  // made the image 84px tall inside a 64px bar, clipping the top and bottom.
  // Width is then clamped to the rail so the collapsed rail can't overflow.
  const barH = collapsed ? 52 : 72
  const availW = collapsed ? SIDEBAR_AVAILABLE_W_COLLAPSED : SIDEBAR_AVAILABLE_W
  // Render at the same height the chat top bar uses (ChatLayout passes size={56}),
  // so the mark reads as one consistent size wherever it appears.
  let imgH = collapsed ? barH : LOGO_RENDER_H
  let imgW = Math.round(imgH * LOGO_ASPECT)
  if (imgW > availW) {
    imgW = availW
    imgH = Math.round(imgW / LOGO_ASPECT)
  }

  return (
    <div
      style={{
        // Must equal the Header height next to it (Layout.tsx: 52px mobile /
        // 72px desktop) — any mismatch shows up as the white bar and the top
        // bar ending at different heights.
        height: barH,
        display: 'flex',
        alignItems: 'center',
        // Left-aligned with the same 8px inset the chat top bar uses
        // (ChatLayout: padding '0 16px 0 8px'), so the mark sits in the same
        // spot whichever shell is rendering it.
        justifyContent: 'flex-start',
        paddingLeft: collapsed ? 0 : 8,
        // The artwork carries an opaque white background, so the bar is white too:
        // any leftover space beside the logo blends into it instead of showing the
        // dark sider through side padding.
        background: '#fff',
        // Same hairline the Header carries, so row y=barH-1 is the identical
        // colour across the whole window instead of the white block ending one
        // pixel lower over the sidebar than over the content area.
        borderBottom: `1px solid ${colorBorderSecondary}`,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <img
        src={'/logo.png'}
        alt="AIOS"
        width={imgW}
        height={imgH}
        style={{ objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}

export default AiosLogo
