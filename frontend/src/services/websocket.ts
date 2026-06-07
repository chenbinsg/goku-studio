/**
 * WebSocket client manager with auto-reconnect and SSE fallback.
 */

type EventCallback = (data: any) => void

function buildWsProtocols(token: string): string[] {
  return ['aios.v1', `bearer.${token}`]
}

class WSManager {
  private ws: WebSocket | null = null
  private listeners = new Map<string, Set<EventCallback>>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private token: string = ''

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(token: string) {
    this.token = token
    this.reconnectAttempts = 0
    this._connect()
  }

  private _connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws`, buildWsProtocols(this.token))

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        const channel = data.channel || 'global'
        this.listeners.get(channel)?.forEach((fn) => fn(data))
        // Also notify global listeners
        this.listeners.get('*')?.forEach((fn) => fn(data))
      } catch {
        // ignore parse errors
      }
    }

    this.ws.onclose = () => {
      this._scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.ws?.close()
    }
  }

  private _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return
    if (this.reconnectTimer) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect()
    }, delay)
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempts = this.maxReconnectAttempts // prevent reconnect
    this.ws?.close()
    this.ws = null
    this.listeners.clear()
  }

  subscribe(channel: string, cb: EventCallback) {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set())
    }
    this.listeners.get(channel)!.add(cb)
  }

  unsubscribe(channel: string, cb: EventCallback) {
    this.listeners.get(channel)?.delete(cb)
  }

  send(data: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  subscribeTask(taskId: string) {
    this.send({ action: 'subscribe_task', task_id: taskId })
  }

  unsubscribeTask(taskId: string) {
    this.send({ action: 'unsubscribe_task', task_id: taskId })
  }

  sendTyping(taskId: string, typing: boolean) {
    this.send({ action: 'typing', task_id: taskId, typing })
  }
}

export const wsManager = new WSManager()
