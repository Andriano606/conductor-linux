// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEventPayload, ChatItem, ChatSnapshot } from '../../src/shared/types'
import { reduceChat, useChatStore, type ChatState } from '../../src/renderer/src/chatStore'
import { setupRenderer, type Api } from './helpers'

const item = (over: Partial<ChatItem> = {}): ChatItem => ({
  id: 'i1',
  role: 'assistant',
  text: 'hi',
  ts: 0,
  ...over
})

const state = (over: Partial<ChatState> = {}): ChatState => ({
  items: [],
  pending: null,
  busy: false,
  seq: 0,
  commands: [],
  ...over
})

const ev = (seq: number, e: ChatEventPayload['ev']): ChatEventPayload => ({ id: 'w1', seq, ev: e })

describe('reduceChat', () => {
  it('appends items, capping the transcript', () => {
    let s = state()
    s = reduceChat(s, ev(1, { type: 'item', item: item() }))
    expect(s.items).toHaveLength(1)
    expect(s.seq).toBe(1)
  })

  it('folds append deltas into the right item', () => {
    let s = state({ items: [item({ id: 'a', text: 'При' }), item({ id: 'b' })], seq: 1 })
    s = reduceChat(s, ev(2, { type: 'append', itemId: 'a', text: 'віт' }))
    expect(s.items[0].text).toBe('Привіт')
    expect(s.items[1].text).toBe('hi')
  })

  it('replaces an item on update and tracks pending/busy', () => {
    let s = state({ items: [item({ id: 'a', done: false, role: 'tool' })] })
    s = reduceChat(s, ev(1, { type: 'update', item: item({ id: 'a', role: 'tool', done: true }) }))
    expect(s.items[0].done).toBe(true)
    s = reduceChat(s, ev(2, { type: 'busy', busy: true }))
    expect(s.busy).toBe(true)
    s = reduceChat(
      s,
      ev(3, {
        type: 'pending',
        pending: { kind: 'permission', requestId: 'r', toolName: 'Bash', summary: 'ls' }
      })
    )
    expect(s.pending).toMatchObject({ kind: 'permission' })
    s = reduceChat(s, ev(4, { type: 'commands', commands: [{ name: 'compact' }, { name: 'clear' }] }))
    expect(s.commands).toEqual([{ name: 'compact' }, { name: 'clear' }])
    s = reduceChat(s, ev(5, { type: 'clear' }))
    expect(s.items).toEqual([])
    expect(s.pending).toBeNull()
  })
})

describe('useChatStore', () => {
  let api: Api
  beforeEach(() => {
    api = setupRenderer()
  })

  it('attach loads the snapshot from main', async () => {
    const snap: ChatSnapshot = { items: [item()], pending: null, busy: true, seq: 5 }
    api.attachChat.mockResolvedValue(snap)
    await useChatStore.getState().attach('w1')
    expect(useChatStore.getState().byId.w1).toMatchObject({ busy: true, seq: 5 })
  })

  it('drops duplicate events and applies sequential ones', async () => {
    api.attachChat.mockResolvedValue({ items: [], pending: null, busy: false, seq: 2 })
    await useChatStore.getState().attach('w1')
    const apply = useChatStore.getState().applyEvent
    apply(ev(2, { type: 'busy', busy: true })) // stale — already in snapshot
    expect(useChatStore.getState().byId.w1.busy).toBe(false)
    apply(ev(3, { type: 'busy', busy: true }))
    expect(useChatStore.getState().byId.w1.busy).toBe(true)
  })

  it('re-attaches when a sequence gap is detected', async () => {
    api.attachChat.mockResolvedValue({ items: [], pending: null, busy: false, seq: 2 })
    await useChatStore.getState().attach('w1')
    api.attachChat.mockClear()
    api.attachChat.mockResolvedValue({ items: [item()], pending: null, busy: false, seq: 7 })
    useChatStore.getState().applyEvent(ev(7, { type: 'busy', busy: true }))
    await vi.waitFor(() => expect(api.attachChat).toHaveBeenCalledWith('w1'))
    await vi.waitFor(() => expect(useChatStore.getState().byId.w1.seq).toBe(7))
  })

  it('buffers events that race with an in-flight attach', async () => {
    let resolve: (s: ChatSnapshot) => void = () => {}
    api.attachChat.mockReturnValue(
      new Promise<ChatSnapshot>((res) => {
        resolve = res
      })
    )
    const attaching = useChatStore.getState().attach('w1')
    // Arrives while the snapshot is still loading — must not be lost.
    useChatStore.getState().applyEvent(ev(4, { type: 'busy', busy: true }))
    resolve({ items: [], pending: null, busy: false, seq: 3 })
    await attaching
    expect(useChatStore.getState().byId.w1.busy).toBe(true)
    expect(useChatStore.getState().byId.w1.seq).toBe(4)
  })

  it('dispose removes the workspace state', async () => {
    api.attachChat.mockResolvedValue({ items: [], pending: null, busy: false, seq: 0 })
    await useChatStore.getState().attach('w1')
    useChatStore.getState().dispose('w1')
    expect(useChatStore.getState().byId.w1).toBeUndefined()
  })
})
