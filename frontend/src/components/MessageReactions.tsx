/**
 * MessageReactions
 * ─────────────────────────────────────────────────────────────────────────────
 * Custom-image reaction picker for assistant chat messages — GOKU theme.
 *
 * Reactions (custom PNG, GOKU / Sun Wukong artwork):
 *  dianzan         点赞          — 悟空点赞（拇指朝上）
 *  kandebuxiaqu    看不下去…     — 捂眼猴（不忍直视）
 *  xianshangpantao 献上蟠桃！    — 蟠桃礼赞（天界最高荣誉）
 *  xiaodaoerming   笑到耳鸣      — 捂耳猴（笑死了）
 *  wodetian        我的天！      — 捂嘴猴（震惊）
 *  fengshen        封神！        — 金星大赞（最高评价）
 */

import React, { useEffect, useRef, useState } from 'react'
import { Tooltip } from 'antd'
import { api } from '../api/index'

// ── Reaction definitions ──────────────────────────────────────────────────────

interface ReactionDef {
  id: string
  src: string
  label: string
}

const REACTIONS: ReactionDef[] = [
  { id: 'dianzan',         src: '/icons/reactions/dianzan.png',         label: '点赞！' },
  { id: 'kandebuxiaqu',    src: '/icons/reactions/kandebuxiaqu.png',    label: '看不下去…' },
  { id: 'xianshangpantao', src: '/icons/reactions/xianshangpantao.png', label: '献上蟠桃！' },
  { id: 'xiaodaoerming',   src: '/icons/reactions/xiaodaoerming.png',   label: '笑到耳鸣' },
  { id: 'wodetian',        src: '/icons/reactions/wodetian.png',        label: '我的天！' },
  { id: 'fengshen',        src: '/icons/reactions/fengshen.png',        label: '封神！' },
]

const STORAGE_KEY = 'aios_msg_reactions_v2'

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadAll(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveAll(data: Record<string, string[]>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

function loadFor(msgId: string): string[] {
  return loadAll()[msgId] || []
}

function toggleReaction(msgId: string, id: string): string[] {
  const all = loadAll()
  const current = all[msgId] || []
  const updated = current.includes(id)
    ? current.filter(e => e !== id)
    : [...current, id]
  all[msgId] = updated
  saveAll(all)
  return updated
}

// ── Reaction image helper ─────────────────────────────────────────────────────

const ReactionImg: React.FC<{ src: string; size: number; style?: React.CSSProperties }> = ({ src, size, style }) => (
  <img
    src={src}
    width={size}
    height={size}
    draggable={false}
    style={{ display: 'inline-block', verticalAlign: 'middle', userSelect: 'none', objectFit: 'contain', ...style }}
  />
)

// ── Component ─────────────────────────────────────────────────────────────────

export interface MessageReactionsProps {
  msgId: string
  taskId?: string
  parentHovered: boolean
}

const MessageReactions: React.FC<MessageReactionsProps> = ({ msgId, taskId, parentHovered }) => {
  const [selected, setSelected] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // On mount: try to load reactions from API, fall back to localStorage
  useEffect(() => {
    let cancelled = false
    api.get<Array<{ emoji_id: string; count: number; reacted_by_me: boolean }>>(
      `/messages/${msgId}/reactions`
    ).then(reactions => {
      if (cancelled) return
      const fromApi = (reactions || [])
        .filter(r => r.reacted_by_me)
        .map(r => r.emoji_id)
      if (fromApi.length > 0) {
        // Sync API state to localStorage
        const all = loadAll()
        all[msgId] = fromApi
        saveAll(all)
        setSelected(fromApi)
      } else {
        setSelected(loadFor(msgId))
      }
    }).catch(() => {
      if (!cancelled) setSelected(loadFor(msgId))
    })
    return () => { cancelled = true }
  }, [msgId])

  useEffect(() => {
    if (!pickerOpen) return
    function onClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [pickerOpen])

  function handleToggle(id: string) {
    const next = toggleReaction(msgId, id)
    setSelected(next)
    const isAdding = next.includes(id)
    if (isAdding) {
      api.post(`/messages/${msgId}/reactions`, { emoji_id: id, task_id: taskId ?? null })
        .catch(() => { /* ignore — localStorage already updated */ })
    } else {
      api.delete(`/messages/${msgId}/reactions/${id}`)
        .catch(() => { /* ignore */ })
    }
  }

  const hasReactions = selected.length > 0
  const showTrigger = parentHovered || pickerOpen

  return (
    <div style={{ position: 'relative', minHeight: hasReactions ? undefined : 0 }}>

      {/* ── Active reaction pills ── */}
      {hasReactions && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, paddingLeft: 2 }}>
          {REACTIONS.filter(r => selected.includes(r.id)).map(r => (
            <Tooltip key={r.id} title={`取消：${r.label}`} mouseEnterDelay={0.6}>
              <span
                role="button"
                tabIndex={0}
                onClick={() => handleToggle(r.id)}
                onKeyDown={e => e.key === 'Enter' && handleToggle(r.id)}
                style={{
                  cursor: 'pointer',
                  lineHeight: '26px',
                  padding: '0 6px',
                  borderRadius: 14,
                  background: 'rgba(24,144,255,0.08)',
                  border: '1px solid rgba(24,144,255,0.3)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  transition: 'background 0.15s',
                  userSelect: 'none',
                }}
              >
                <ReactionImg src={r.src} size={20} />
              </span>
            </Tooltip>
          ))}

          {showTrigger && (
            <TriggerButton onClick={() => setPickerOpen(v => !v)} active={pickerOpen} />
          )}
        </div>
      )}

      {/* ── Floating trigger (no pills yet) ── */}
      {!hasReactions && showTrigger && (
        <div style={{ marginTop: 6, paddingLeft: 2 }}>
          <TriggerButton onClick={() => setPickerOpen(v => !v)} active={pickerOpen} />
        </div>
      )}

      {/* ── Emoji picker popup ── */}
      {pickerOpen && (
        <div
          ref={pickerRef}
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            background: '#fff',
            border: '1px solid #e8e8e8',
            borderRadius: 20,
            padding: '6px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            boxShadow: '0 6px 24px rgba(0,0,0,0.13)',
            zIndex: 100,
            whiteSpace: 'nowrap',
          }}
        >
          {REACTIONS.map(r => {
            const isActive = selected.includes(r.id)
            return (
              <Tooltip key={r.id} title={r.label} mouseEnterDelay={0.3}>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => handleToggle(r.id)}
                  onKeyDown={e => e.key === 'Enter' && handleToggle(r.id)}
                  style={{
                    cursor: 'pointer',
                    padding: '3px 5px',
                    borderRadius: 10,
                    background: isActive ? 'rgba(24,144,255,0.12)' : 'transparent',
                    border: isActive ? '1px solid rgba(24,144,255,0.35)' : '1px solid transparent',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s, transform 0.12s',
                    userSelect: 'none',
                    transform: isActive ? 'scale(1.15)' : 'scale(1)',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLSpanElement).style.transform = 'scale(1.25)'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLSpanElement).style.transform = isActive ? 'scale(1.15)' : 'scale(1)'
                  }}
                >
                  <ReactionImg src={r.src} size={32} />
                </span>
              </Tooltip>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── TriggerButton ─────────────────────────────────────────────────────────────

const TriggerButton: React.FC<{ onClick: () => void; active: boolean }> = ({ onClick, active }) => (
  <Tooltip title="送上心意" mouseEnterDelay={0.6}>
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      style={{
        cursor: 'pointer',
        lineHeight: '26px',
        padding: '0 6px',
        borderRadius: 14,
        background: active ? 'rgba(24,144,255,0.1)' : 'rgba(0,0,0,0.05)',
        border: `1px solid ${active ? 'rgba(24,144,255,0.3)' : 'rgba(0,0,0,0.1)'}`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        transition: 'all 0.15s',
        userSelect: 'none',
      }}
    >
      <ReactionImg src="/icons/reactions/dianzan.png" size={18} />
      <span style={{ fontSize: 11, color: '#888', lineHeight: 1 }}>+</span>
    </span>
  </Tooltip>
)

export default MessageReactions
