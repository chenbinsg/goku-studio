import React, { useLayoutEffect, useRef, useState } from 'react'
import { Button, Typography } from 'antd'
import { DownOutlined, UpOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

/**
 * Folds anything taller than `maxHeight` away behind a 显示全部 / 收起 toggle.
 *
 * A card in a conversation competes with the conversation: a 130-row table or a
 * 6,000-character skill body pushes everything said before it off the screen.
 * Height is the right measure rather than a row or line count — what costs the
 * reader is pixels, and how tall content renders depends on wrapping and the
 * viewer's width.
 *
 * Shared rather than reimplemented per card so the fold behaves the same
 * wherever it appears, and so the measuring below exists once.
 */
interface Props {
  children: React.ReactNode
  /** Height at which the fold kicks in. */
  maxHeight?: number
  /** Extra room allowed before folding, so a card that only just overflows
   *  is shown whole instead of hiding two lines behind a button. */
  tolerance?: number
}

const CollapsibleBody: React.FC<Props> = ({
  children,
  maxHeight = 260,
  tolerance = 24,
}) => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  // Measured, not inferred from the content's size: a card that fits should
  // not carry a 显示全部 control that does nothing when pressed.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflows(el.scrollHeight > maxHeight + tolerance)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children, maxHeight, tolerance])

  const folded = overflows && !expanded
  // Fades the cut edge instead of slicing a row or a line in half, so it reads
  // as "there is more" rather than as a rendering fault.
  const fade = 'linear-gradient(to bottom, #000 78%, transparent 100%)'

  return (
    <>
      <div
        ref={ref}
        style={{
          maxHeight: folded ? maxHeight : undefined,
          overflow: folded ? 'hidden' : undefined,
          maskImage: folded ? fade : undefined,
          WebkitMaskImage: folded ? fade : undefined,
        }}
      >
        {children}
      </div>
      {overflows && (
        <div style={{ padding: '4px 12px' }}>
          <Button
            size="small"
            type="link"
            icon={expanded ? <UpOutlined /> : <DownOutlined />}
            onClick={() => setExpanded(!expanded)}
            style={{ padding: 0 }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              {expanded
                ? t('table_card_collapse', '收起')
                : t('table_card_expand', '显示全部')}
            </Text>
          </Button>
        </div>
      )}
    </>
  )
}

export default CollapsibleBody
