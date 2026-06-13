import { create } from 'zustand'
import type { ChatCommand, ChatEventPayload, ChatItem, ChatPending } from '@shared/types'

/**
 * Per-workspace mirror of the main-side chat transcript. Main is the source of
 * truth: chat:attach returns a snapshot (items + pending + busy + seq) and
 * chat:event streams increments. Sequence numbers guard against duplicates and
 * gaps — a stale event is dropped, a gap triggers a fresh attach.
 */

export interface ChatState {
  items: ChatItem[]
  pending: ChatPending | null
  busy: boolean
  seq: number
  /** Slash commands available for input autocomplete (from the CLI). */
  commands: ChatCommand[]
}

/** Mirrors the main-side transcript cap so trimming stays in lockstep. */
const MAX_ITEMS = 500

/** Fold one event into a chat state (pure — exported for tests). */
export function reduceChat(state: ChatState, payload: ChatEventPayload): ChatState {
  const { seq, ev } = payload
  const next: ChatState = { ...state, seq }
  switch (ev.type) {
    case 'item':
      next.items = [...state.items, ev.item].slice(-MAX_ITEMS)
      break
    case 'append':
      next.items = state.items.map((it) =>
        it.id === ev.itemId ? { ...it, text: it.text + ev.text } : it
      )
      break
    case 'update':
      next.items = state.items.map((it) => (it.id === ev.item.id ? ev.item : it))
      break
    case 'pending':
      next.pending = ev.pending
      break
    case 'busy':
      next.busy = ev.busy
      break
    case 'commands':
      next.commands = ev.commands
      break
    case 'clear':
      next.items = []
      next.pending = null
      break
  }
  return next
}

interface ChatStore {
  byId: Record<string, ChatState>
  /** Load the snapshot for a workspace (also restarts a dead session). */
  attach: (id: string) => Promise<void>
  applyEvent: (payload: ChatEventPayload) => void
  dispose: (id: string) => void
}

// Events that race with an in-flight attach are buffered and replayed on top
// of the snapshot, so nothing is lost and nothing duplicates.
const attaching = new Map<string, ChatEventPayload[]>()

export const useChatStore = create<ChatStore>((set, get) => ({
  byId: {},

  attach: async (id) => {
    if (attaching.has(id)) return
    attaching.set(id, [])
    try {
      const snap = await window.api.attachChat(id)
      let state: ChatState = {
        items: snap.items,
        pending: snap.pending,
        busy: snap.busy,
        seq: snap.seq,
        commands: snap.commands ?? []
      }
      for (const p of attaching.get(id) ?? []) {
        if (p.seq > state.seq) state = reduceChat(state, p)
      }
      set((s) => ({ byId: { ...s.byId, [id]: state } }))
    } finally {
      attaching.delete(id)
    }
  },

  applyEvent: (payload) => {
    const buf = attaching.get(payload.id)
    if (buf) {
      buf.push(payload)
      return
    }
    const cur = get().byId[payload.id]
    if (!cur) return // tab never attached — the future snapshot covers it
    if (payload.seq <= cur.seq) return // duplicate/out-of-date
    if (payload.seq > cur.seq + 1) {
      // Missed events — resync from the authoritative main-side state.
      void get().attach(payload.id)
      return
    }
    set((s) => ({ byId: { ...s.byId, [payload.id]: reduceChat(cur, payload) } }))
  },

  dispose: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const byId = { ...s.byId }
      delete byId[id]
      return { byId }
    })
}))
