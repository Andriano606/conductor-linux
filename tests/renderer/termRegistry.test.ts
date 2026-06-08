// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake xterm — no canvas/webgl. Records constructor opts and instances.
const xt = vi.hoisted(() => {
  const instances: FakeTerminal[] = []
  class FakeTerminal {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    scrollToBottom = vi.fn()
    buffer = { active: { viewportY: 0, baseY: 0 } }
    loadAddon = vi.fn((addon: FakeFitAddon) => {
      addon.term = this
    })
    open = vi.fn()
    onData = vi.fn()
    onSelectionChange = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    constructor(opts: Record<string, unknown>) {
      this.options = opts
      instances.push(this)
    }
  }
  class FakeFitAddon {
    term?: FakeTerminal
    // A real fit() measures the host and resizes the terminal; emulate that by
    // bumping the terminal to a new size so the dims-changed guard fires.
    fit = vi.fn(() => {
      if (this.term) {
        this.term.cols = 120
        this.term.rows = 40
      }
    })
  }
  return { instances, FakeTerminal, FakeFitAddon }
})
vi.mock('@xterm/xterm', () => ({ Terminal: xt.FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: xt.FakeFitAddon }))

import {
  disposeWorkspace,
  fitAndResize,
  mount,
  writeData
} from '../../src/renderer/src/termRegistry'
import { setupRenderer, Api } from './helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  xt.instances.length = 0
  // Each test uses a fresh workspace id so the module-level registry doesn't
  // carry terminals across tests.
})

let counter = 0
const freshId = (): string => `ws-${counter++}`

// Streaming writes are coalesced and flushed one frame later (after the attach
// snapshot resolves), so tests await a frame before asserting on writes.
const nextFrame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()))

describe('termRegistry', () => {
  it('creates one terminal per (id, kind) and reuses it', () => {
    const id = freshId()
    writeData(id, 'claude', 'a')
    writeData(id, 'claude', 'b')
    expect(xt.instances).toHaveLength(1)
    writeData(id, 'shell', 'c')
    expect(xt.instances).toHaveLength(2)
  })

  it('makes the task terminal read-only and others interactive', () => {
    const id = freshId()
    writeData(id, 'task', 'x')
    expect(xt.instances[0].options.disableStdin).toBe(true)
    writeData(id, 'claude', 'y')
    expect(xt.instances[1].options.disableStdin).toBe(false)
    // Interactive terminals wire keystrokes to the PTY.
    expect(xt.instances[1].onData).toHaveBeenCalled()
  })

  it('routes data to the matching terminal (batched per frame)', async () => {
    const id = freshId()
    writeData(id, 'claude', 'hel')
    writeData(id, 'claude', 'lo')
    await nextFrame()
    // Both chunks coalesce into a single write once the snapshot has landed.
    expect(xt.instances[0].write).toHaveBeenCalledWith('hello')
  })

  it('writes the attached buffer snapshot on creation', async () => {
    api.attachPty.mockResolvedValue('history-buffer')
    const id = freshId()
    writeData(id, 'claude', '')
    expect(api.attachPty).toHaveBeenCalledWith(id, 'claude')
    await Promise.resolve()
    expect(xt.instances[0].write).toHaveBeenCalledWith('history-buffer')
  })

  it('mount places the wrapper in the host and focuses/resizes on activation', async () => {
    const id = freshId()
    // Created but not mounted → wrapper not connected → fitAndResize is a no-op.
    writeData(id, 'claude', '')
    fitAndResize(id, 'claude')
    expect(api.resizePty).not.toHaveBeenCalled()
    // Background resize does not steal focus.
    expect(xt.instances[0].focus).not.toHaveBeenCalled()

    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    expect(host.querySelector('.term-mount')).not.toBeNull()

    // mount defers fit + focus to the next frame.
    await nextFrame()
    expect(xt.instances[0].focus).toHaveBeenCalled()
    // fit() changed the dims (80→120) so the new size is pushed to the PTY.
    expect(api.resizePty).toHaveBeenCalledWith(id, 'claude', 120, 40)
    // The view was at the bottom, so it stays pinned after the reflow.
    expect(xt.instances[0].scrollToBottom).toHaveBeenCalled()
  })

  it('snaps to the bottom on activation even when previously scrolled up', async () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    await nextFrame()
    const term = xt.instances[0]
    // User scrolled up, then re-activates this tab: viewport not at the bottom,
    // so fitAndResize's pin-to-bottom path won't fire — mount must still snap.
    term.buffer.active.baseY = 500
    term.buffer.active.viewportY = 100
    term.scrollToBottom.mockClear()
    mount(host, id, 'claude')
    await nextFrame()
    expect(term.scrollToBottom).toHaveBeenCalled()
  })

  it('does not yank the view to the bottom when scrolled up', async () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    await nextFrame()
    // Simulate the user scrolling up: viewport no longer at the bottom.
    const term = xt.instances[0]
    term.buffer.active.baseY = 500
    term.buffer.active.viewportY = 100
    term.scrollToBottom.mockClear()
    fitAndResize(id, 'claude')
    expect(term.scrollToBottom).not.toHaveBeenCalled()
  })

  it('disposeWorkspace tears down all three kinds', () => {
    const id = freshId()
    writeData(id, 'claude', '')
    writeData(id, 'task', '')
    writeData(id, 'shell', '')
    const created = xt.instances.slice()
    disposeWorkspace(id)
    for (const t of created) expect(t.dispose).toHaveBeenCalled()
    // Registry was cleared → writing again builds a new instance.
    writeData(id, 'claude', '')
    expect(xt.instances).toHaveLength(4)
  })

  // The custom key handler installed for the interactive terminals.
  const ctrlC = { type: 'keydown', ctrlKey: true, key: 'c' } as unknown as KeyboardEvent
  const handlerOf = (term: FakeTerminal): ((e: KeyboardEvent) => boolean) =>
    term.attachCustomKeyEventHandler.mock.calls[0][0]

  it('Ctrl+C copies the selection in every interactive terminal', () => {
    for (const kind of ['claude', 'shell'] as const) {
      const id = freshId()
      writeData(id, kind, '')
      const term = xt.instances.at(-1) as FakeTerminal
      term.getSelection.mockReturnValue('picked')
      // Selection present → copy and swallow; never send an interrupt.
      expect(handlerOf(term)(ctrlC)).toBe(false)
      expect(api.copyText).toHaveBeenCalledWith('picked')
      expect(api.sendInput).not.toHaveBeenCalledWith(id, kind, '\x03')
    }
  })

  it('Ctrl+C interrupts Claude but throttles rapid taps so it cannot exit', () => {
    const now = vi.spyOn(performance, 'now')
    const id = freshId()
    writeData(id, 'claude', '')
    const term = xt.instances.at(-1) as FakeTerminal
    const handle = handlerOf(term)

    // First press → a single \x03 (interrupt), always swallowed. (performance.now
    // is always well past 1s by the time a key is pressed, so the first ever tap
    // is never throttled.)
    now.mockReturnValue(5000)
    expect(handle(ctrlC)).toBe(false)
    expect(api.sendInput).toHaveBeenCalledWith(id, 'claude', '\x03')
    expect(api.sendInput).toHaveBeenCalledTimes(1)

    // A second press inside the 1s window — the CLI's double-tap exit — is dropped.
    now.mockReturnValue(5500)
    expect(handle(ctrlC)).toBe(false)
    expect(api.sendInput).toHaveBeenCalledTimes(1)

    // Past the window, Ctrl+C interrupts again.
    now.mockReturnValue(6000)
    expect(handle(ctrlC)).toBe(false)
    expect(api.sendInput).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })

  it('Ctrl+C in the shell falls through to a normal interrupt', () => {
    const id = freshId()
    writeData(id, 'shell', '')
    const term = xt.instances.at(-1) as FakeTerminal
    // No selection → let xterm emit its own \x03 (return true), no throttle and
    // no direct send, so the shell behaves like a real terminal.
    expect(handlerOf(term)(ctrlC)).toBe(true)
    expect(api.sendInput).not.toHaveBeenCalled()
  })

  it('does not intercept keys other than Ctrl+C', () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const term = xt.instances.at(-1) as FakeTerminal
    const plain = { type: 'keydown', ctrlKey: false, key: 'a' } as unknown as KeyboardEvent
    expect(handlerOf(term)(plain)).toBe(true)
  })
})

type FakeTerminal = InstanceType<typeof xt.FakeTerminal>
