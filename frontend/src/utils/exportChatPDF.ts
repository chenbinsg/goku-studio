/**
 * exportChatPDF — opens a print-ready window with the full conversation history.
 *
 * Uses the browser's native print-to-PDF so Chinese text, markdown, and code
 * blocks all render perfectly without any extra dependencies.
 */

import type { ChatMessage, ToolCall } from '../types/card'

export interface ExportOptions {
  title: string          // Conversation title shown at the top
  agentName?: string     // Optional agent name shown in the header
  messages: ChatMessage[]
}

// ── Lightweight markdown → HTML (good enough for print) ──────────────────────
function mdToHtml(md: string): string {
  if (!md) return ''

  // Fenced code blocks (``` ... ```)
  let html = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escHtml(code.trimEnd())
    const label = lang ? ` data-lang="${escHtml(lang)}"` : ''
    return `<pre${label}><code>${escaped}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${escHtml(code)}</code>`)

  // Headings
  html = html.replace(/^#{6} (.+)$/gm, '<h6>$1</h6>')
  html = html.replace(/^#{5} (.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^#{4} (.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')
  html = html.replace(/_([^_\n]+?)_/g, '<em>$1</em>')

  // Blockquote
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')

  // Horizontal rule
  html = html.replace(/^(---|\*\*\*|___)\s*$/gm, '<hr/>')

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Unordered list — collect consecutive items into one <ul>
  html = html.replace(/((?:^[-*+] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*+] /, '')}</li>`).join('')
    return `<ul>${items}</ul>`
  })

  // Ordered list
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('')
    return `<ol>${items}</ol>`
  })

  // Paragraphs — wrap double-newline-separated blocks not already wrapped in a block element
  const blockTags = /^<(h[1-6]|ul|ol|pre|blockquote|hr)/
  const lines = html.split(/\n\n+/)
  html = lines.map((block) => {
    if (!block.trim()) return ''
    if (blockTags.test(block.trim())) return block
    // Single-newline breaks inside a paragraph
    return `<p>${block.replace(/\n/g, '<br/>')}</p>`
  }).join('\n')

  return html
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatTimestamp(ts: string): string {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function toolCallsHtml(calls: ToolCall[]): string {
  if (!calls?.length) return ''
  const rows = calls.map((tc) => {
    const status = tc.success === false ? '❌' : tc.success === true ? '✅' : '🔧'
    const duration = tc.duration_ms != null ? ` ${tc.duration_ms}ms` : ''
    const params = Object.keys(tc.parameters ?? {}).length
      ? `<div class="tool-params">${escHtml(JSON.stringify(tc.parameters, null, 2))}</div>`
      : ''
    let result = ''
    if (tc.result != null) {
      const r = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)
      result = `<div class="tool-result">${escHtml(r.slice(0, 800))}${r.length > 800 ? '\n…' : ''}</div>`
    }
    return `<div class="tool-call">
      <div class="tool-name">${status} <strong>${escHtml(tc.tool)}</strong>${duration ? `<span class="tool-dur">${escHtml(duration)}</span>` : ''}</div>
      ${params}${result}
    </div>`
  }).join('')
  return `<div class="tool-calls">${rows}</div>`
}

function buildHtml(opts: ExportOptions): string {
  const { title, agentName, messages } = opts
  const exportTime = new Date().toLocaleString()

  const msgBlocks = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const isUser = m.role === 'user'
      const roleLabel = isUser ? '👤 User' : `🤖 ${agentName || 'Assistant'}`
      const ts = formatTimestamp(m.timestamp || m.created_at || '')
      const contentHtml = m.content ? mdToHtml(m.content) : ''
      const toolsHtml = m.tool_calls?.length ? toolCallsHtml(m.tool_calls) : ''
      const tokenBadge = m.token_count != null
        ? `<span class="token-badge">${m.token_count} tokens</span>`
        : ''
      return `
      <div class="message ${isUser ? 'message-user' : 'message-assistant'}">
        <div class="message-header">
          <span class="role-label">${roleLabel}</span>
          ${tokenBadge}
          ${ts ? `<span class="msg-time">${escHtml(ts)}</span>` : ''}
        </div>
        ${contentHtml ? `<div class="message-body">${contentHtml}</div>` : ''}
        ${toolsHtml}
      </div>`
    }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "PingFang SC", "Helvetica Neue", Arial, "Noto Sans CJK SC", sans-serif;
      font-size: 13px; line-height: 1.7; color: #1a1a1a;
      padding: 28px 40px; max-width: 860px; margin: 0 auto;
    }
    .cover {
      border-bottom: 2px solid #1890ff; padding-bottom: 16px; margin-bottom: 24px;
    }
    .cover h1 { font-size: 20px; font-weight: 700; color: #1890ff; margin-bottom: 4px; }
    .cover .meta { font-size: 12px; color: #666; }
    .cover .meta span { margin-right: 16px; }

    .message { margin-bottom: 18px; padding: 12px 14px; border-radius: 6px; page-break-inside: avoid; }
    .message-user    { background: #f0f7ff; border-left: 3px solid #1890ff; }
    .message-assistant { background: #fafafa; border-left: 3px solid #52c41a; }

    .message-header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 8px; font-size: 12px; color: #666;
    }
    .role-label { font-weight: 600; font-size: 13px; color: #333; }
    .msg-time { margin-left: auto; color: #999; }
    .token-badge {
      background: #f0f0f0; border-radius: 10px; padding: 1px 7px;
      font-size: 11px; color: #666;
    }

    .message-body p { margin: 6px 0; }
    .message-body h1,.message-body h2,.message-body h3 {
      font-size: 14px; font-weight: 700; margin: 10px 0 4px;
    }
    .message-body ul,.message-body ol { padding-left: 20px; margin: 6px 0; }
    .message-body li { margin: 2px 0; }
    .message-body code {
      background: #f4f4f4; border: 1px solid #e0e0e0;
      padding: 1px 5px; border-radius: 3px; font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
    }
    .message-body pre {
      background: #282c34; color: #abb2bf;
      padding: 12px 14px; border-radius: 5px; overflow-x: auto;
      margin: 8px 0; font-size: 12px;
      page-break-inside: avoid;
    }
    .message-body pre code { background: none; border: none; padding: 0; color: inherit; }
    .message-body blockquote {
      border-left: 3px solid #d0d0d0; padding-left: 10px;
      color: #666; margin: 8px 0;
    }
    .message-body a { color: #1890ff; }
    .message-body hr { border: none; border-top: 1px solid #e0e0e0; margin: 8px 0; }
    .message-body table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    .message-body th, .message-body td {
      border: 1px solid #e0e0e0; padding: 6px 10px; font-size: 12px;
    }
    .message-body th { background: #f5f5f5; font-weight: 600; }

    .tool-calls { margin-top: 8px; }
    .tool-call {
      background: #fff8f0; border: 1px solid #ffe7ba;
      border-radius: 4px; padding: 8px 10px; margin-bottom: 6px;
      font-size: 12px; page-break-inside: avoid;
    }
    .tool-name { margin-bottom: 4px; }
    .tool-dur { color: #888; margin-left: 6px; font-size: 11px; }
    .tool-params, .tool-result {
      background: #f5f5f5; border-radius: 3px; padding: 6px 8px;
      margin-top: 4px; white-space: pre-wrap; word-break: break-all;
      font-family: monospace; font-size: 11px; color: #444;
      max-height: 200px; overflow: hidden;
    }
    .tool-result { border-left: 2px solid #52c41a; background: #f6ffed; }

    .footer {
      margin-top: 30px; padding-top: 12px; border-top: 1px solid #e0e0e0;
      font-size: 11px; color: #aaa; text-align: center;
    }

    @media print {
      body { padding: 0; max-width: 100%; }
      .message { page-break-inside: avoid; }
      a { color: #1890ff !important; }
    }
  </style>
</head>
<body>
  <div class="cover">
    <h1>${escHtml(title || 'Conversation')}</h1>
    <div class="meta">
      ${agentName ? `<span>🤖 ${escHtml(agentName)}</span>` : ''}
      <span>📄 ${messages.filter(m => m.role !== 'system').length} messages</span>
      <span>🕐 Exported ${escHtml(exportTime)}</span>
    </div>
  </div>

  ${msgBlocks}

  <div class="footer">Goku AIOS · ${escHtml(exportTime)}</div>
  <script>window.onload = () => { window.print() }<\/script>
</body>
</html>`
}

export function exportChatToPDF(opts: ExportOptions): void {
  if (!opts.messages.filter(m => m.role !== 'system').length) return

  const html = buildHtml(opts)
  const win = window.open('', '_blank', 'width=900,height=700')
  if (!win) {
    // Popup blocked — fallback: download as .html
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(opts.title || 'conversation').replace(/[/\\:*?"<>|]/g, '_')}.html`
    a.click()
    URL.revokeObjectURL(url)
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
}
