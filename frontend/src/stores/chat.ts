import { create } from 'zustand'
import type { ChatMessage, CardMessage, Conversation } from '../types/card'
import api from '../api/request'

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  messages: ChatMessage[]
  cardRegistry: Record<string, CardMessage>
  sending: boolean
  streamingText: string
  thinkingText: string

  setConversations: (convs: Conversation[]) => void
  setActiveConversationId: (id: string | null) => void
  startNewConversation: () => void
  setMessages: (msgs: ChatMessage[]) => void
  addMessage: (msg: ChatMessage) => void
  setSending: (val: boolean) => void
  setStreamingText: (val: string) => void
  appendStreamingText: (delta: string) => void
  setThinkingText: (val: string) => void
  appendThinkingText: (delta: string) => void
  updateCard: (cardId: string, patch: Partial<CardMessage>) => void
  registerCards: (cards: CardMessage[]) => void
  handleCardAction: (cardId: string, actionKey: string, params?: Record<string, any>) => void
  fetchConversations: () => Promise<void>
  fetchMessages: (convId: string) => Promise<void>
  createConversation: (title: string, agentId?: string) => Promise<string | null>
  deleteConversation: (convId: string) => Promise<void>
  clearStreaming: () => void
}

export const useChatStore = create<ChatState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  cardRegistry: {},
  sending: false,
  streamingText: '',
  thinkingText: '',

  setConversations: (convs) => set({ conversations: convs }),
  setActiveConversationId: (id) => set({ activeConversationId: id }),
  startNewConversation: () => set({ activeConversationId: null, messages: [], streamingText: '', thinkingText: '' }),
  setMessages: (msgs) => {
    const registry: Record<string, CardMessage> = {}
    for (const msg of msgs) {
      if (msg.cards) {
        for (const card of msg.cards) {
          registry[card.card_id] = card
        }
      }
    }
    set({ messages: msgs, cardRegistry: { ...get().cardRegistry, ...registry } })
  },
  addMessage: (msg) => {
    const registry = { ...get().cardRegistry }
    if (msg.cards) {
      for (const card of msg.cards) {
        registry[card.card_id] = card
      }
    }
    set({ messages: [...get().messages, msg], cardRegistry: registry })
  },
  setSending: (val) => set({ sending: val }),
  setStreamingText: (val) => set({ streamingText: val }),
  appendStreamingText: (delta) => set({ streamingText: get().streamingText + delta }),
  setThinkingText: (val) => set({ thinkingText: val }),
  appendThinkingText: (delta) => set({ thinkingText: get().thinkingText + delta }),

  updateCard: (cardId, patch) => {
    const registry = { ...get().cardRegistry }
    const existing = registry[cardId]
    if (existing) {
      registry[cardId] = {
        ...existing,
        ...patch,
        data: { ...existing.data, ...(patch.data || {}) },
      }
    }
    const messages = get().messages.map((msg) => {
      if (!msg.cards) return msg
      const updatedCards = msg.cards.map((c) =>
        c.card_id === cardId ? registry[cardId] : c
      )
      return { ...msg, cards: updatedCards }
    })
    set({ cardRegistry: registry, messages })
  },

  registerCards: (cards) => {
    const registry = { ...get().cardRegistry }
    for (const card of cards) {
      registry[card.card_id] = card
    }
    set({ cardRegistry: registry })
  },

  handleCardAction: (cardId, actionKey, params) => {
    const card = get().cardRegistry[cardId]
    if (!card) return
    const actionMsg: ChatMessage = {
      id: `action-${Date.now()}`,
      role: 'user',
      content: '',
      timestamp: new Date().toISOString(),
      action: { card_id: cardId, action_key: actionKey, params },
    }
    get().addMessage(actionMsg)
  },

  fetchConversations: async () => {
    try {
      const res = await api.get('/api/v1/conversations', { params: { size: 50 } })
      set({ conversations: res.data.items || [] })
    } catch {
      // ignore
    }
  },

  fetchMessages: async (convId) => {
    const res = await api.get(`/api/v1/conversations/${convId}/messages`)
    // Guard against race: only apply if the user is still viewing this conversation
    if (get().activeConversationId === convId) {
      const serverMsgs = res.data.messages || []
      // Safety net: if the server returns an empty list but there are optimistic
      // temp messages in the store (handleSend just called addMessage() but
      // api.post hasn't saved to the DB yet), don't wipe them.  This prevents a
      // premature fetchMessages call from erasing the user's in-flight message.
      if (serverMsgs.length === 0 && get().messages.some((m) => m.id.startsWith('temp-'))) {
        return
      }
      get().setMessages(serverMsgs)
    }
  },

  createConversation: async (title, agentId) => {
    try {
      const body: Record<string, any> = { title }
      if (agentId) body.agent_id = agentId
      const res = await api.post('/api/v1/conversations', body)
      const newConv = res.data
      set({ conversations: [newConv, ...get().conversations], activeConversationId: newConv.id })
      return newConv.id
    } catch {
      return null
    }
  },

  deleteConversation: async (convId) => {
    try {
      await api.delete(`/api/v1/conversations/${convId}`)
      set({
        conversations: get().conversations.filter((c) => c.id !== convId),
        ...(get().activeConversationId === convId ? { activeConversationId: null, messages: [] } : {}),
      })
    } catch {
      // ignore
    }
  },

  clearStreaming: () => set({ streamingText: '', thinkingText: '', sending: false }),

  // Called on logout — resets all chat state so no data leaks between users
  resetAll: () => set({
    conversations: [],
    activeConversationId: null,
    messages: [],
    cardRegistry: {},
    sending: false,
    streamingText: '',
    thinkingText: '',
  }),
}))
