// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fake xterm — no canvas/webgl. Records constructor opts and instances.
const xt = vi.hoisted(() => {
  type FakeLine = { isWrapped: boolean; translateToString: (trim?: boolean) => string }
  const instances: FakeTerminal[] = []
  class FakeTerminal {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    scrollToBottom = vi.fn()
    scrollToTop = vi.fn()
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 0,
        getLine: (_y: number): FakeLine | undefined => undefined
      }
    }
    loadAddon = vi.fn((addon: FakeFitAddon) => {
      addon.term = this
    })
    open = vi.fn()
    onData = vi.fn()
    onWriteParsed = vi.fn()
    onSelectionChange = vi.fn()
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    /** Make the live screen render the given rows (one string per row). */
    setScreen(rows: string[]): void {
      this.rows = rows.length
      this.buffer.active.getLine = (y: number) =>
        y < rows.length ? { isWrapped: false, translateToString: () => rows[y] } : undefined
    }
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
  requestMenuScan,
  setMenuListener,
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

  it('makes the task and claude terminals read-only and the shell interactive', () => {
    const id = freshId()
    writeData(id, 'task', 'x')
    expect(xt.instances[0].options.disableStdin).toBe(true)
    // Claude is output-only too: all input goes through the composer.
    writeData(id, 'claude', 'y')
    expect(xt.instances[1].options.disableStdin).toBe(true)
    expect(xt.instances[1].onData).not.toHaveBeenCalled()
    // Only the shell wires keystrokes to the PTY.
    writeData(id, 'shell', 'z')
    expect(xt.instances[2].options.disableStdin).toBe(false)
    expect(xt.instances[2].onData).toHaveBeenCalled()
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
    writeData(id, 'shell', '')
    fitAndResize(id, 'shell')
    expect(api.resizePty).not.toHaveBeenCalled()
    // Background resize does not steal focus.
    expect(xt.instances[0].focus).not.toHaveBeenCalled()

    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'shell')
    expect(host.querySelector('.term-mount')).not.toBeNull()

    // mount defers fit + focus to the next frame.
    await nextFrame()
    expect(xt.instances[0].focus).toHaveBeenCalled()
    // fit() changed the dims (80→120) so the new size is pushed to the PTY.
    expect(api.resizePty).toHaveBeenCalledWith(id, 'shell', 120, 40)
    // The view was at the bottom, so it stays pinned after the reflow.
    expect(xt.instances[0].scrollToBottom).toHaveBeenCalled()
  })

  it('mount never focuses the claude terminal (the composer owns focus)', async () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    await nextFrame()
    expect(xt.instances[0].focus).not.toHaveBeenCalled()
    // Everything else about activation still happens.
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

  it('bounces off the top on activation so a grown buffer re-pins to the bottom', async () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const term = xt.instances.at(-1) as FakeTerminal
    // Buffer grew past the viewport while hidden; ydisp is already at the base so
    // a bare scrollToBottom() would no-op. mount must bounce off the top to force
    // xterm to recompute its scroll area and land on the true bottom.
    term.buffer.active.length = 1000
    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    await nextFrame() // fit + initial scrollToBottom + focus
    await nextFrame() // deferred re-pin
    expect(term.scrollToTop).toHaveBeenCalled()
    expect(term.scrollToBottom).toHaveBeenCalled()
  })

  it('does not bounce when the buffer fits in the viewport', async () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const term = xt.instances.at(-1) as FakeTerminal
    // No scrollback (length <= rows) → nothing to re-pin, so skip the top bounce.
    term.buffer.active.length = 10
    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    await nextFrame()
    await nextFrame()
    expect(term.scrollToTop).not.toHaveBeenCalled()
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

  it('Ctrl+C copies the selection in every terminal', () => {
    for (const kind of ['claude', 'shell', 'task'] as const) {
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

  it('Ctrl+C in the shell falls through to a normal interrupt', () => {
    const id = freshId()
    writeData(id, 'shell', '')
    const term = xt.instances.at(-1) as FakeTerminal
    // No selection → let xterm emit its own \x03 (return true), no direct send,
    // so the shell behaves like a real terminal.
    expect(handlerOf(term)(ctrlC)).toBe(true)
    expect(api.sendInput).not.toHaveBeenCalled()
  })

  it('swallows every key in the read-only claude terminal', () => {
    const id = freshId()
    writeData(id, 'claude', '')
    const term = xt.instances.at(-1) as FakeTerminal
    const plain = { type: 'keydown', ctrlKey: false, key: 'a' } as unknown as KeyboardEvent
    // Nothing reaches the PTY: input happens in the composer, not the terminal.
    expect(handlerOf(term)(plain)).toBe(false)
    expect(api.sendInput).not.toHaveBeenCalled()
  })

  it('does not intercept shell keys other than Ctrl+C', () => {
    const id = freshId()
    writeData(id, 'shell', '')
    const term = xt.instances.at(-1) as FakeTerminal
    const plain = { type: 'keydown', ctrlKey: false, key: 'a' } as unknown as KeyboardEvent
    expect(handlerOf(term)(plain)).toBe(true)
  })

  describe('claude menu scanning', () => {
    const SCREEN = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '']

    afterEach(() => {
      setMenuListener(null)
      vi.useRealTimers()
    })

    const fireWriteParsed = (term: FakeTerminal): void => {
      for (const call of term.onWriteParsed.mock.calls) (call[0] as () => void)()
    }

    it('reports a menu to the listener once writes settle', () => {
      const id = freshId()
      writeData(id, 'claude', '')
      const term = xt.instances.at(-1) as FakeTerminal
      term.setScreen(SCREEN)
      const cb = vi.fn()
      setMenuListener(cb)
      vi.useFakeTimers()
      // Several rapid writes debounce into a single scan.
      fireWriteParsed(term)
      fireWriteParsed(term)
      expect(cb).not.toHaveBeenCalled()
      vi.advanceTimersByTime(200)
      expect(cb).toHaveBeenCalledTimes(1)
      const [reportedId, menu] = cb.mock.calls[0]
      expect(reportedId).toBe(id)
      expect(menu.options.map((o: { label: string }) => o.label)).toEqual(['Yes', 'No'])
      expect(menu.selectedIndex).toBe(0)
    })

    it('reports null when the screen has no menu', () => {
      const id = freshId()
      writeData(id, 'claude', '')
      const term = xt.instances.at(-1) as FakeTerminal
      term.setScreen(['just some output', ''])
      const cb = vi.fn()
      setMenuListener(cb)
      vi.useFakeTimers()
      fireWriteParsed(term)
      vi.advanceTimersByTime(200)
      expect(cb).toHaveBeenCalledWith(id, null)
    })

    it('requestMenuScan scans immediately and reports null for unknown ids', () => {
      const cb = vi.fn()
      setMenuListener(cb)
      requestMenuScan('nope')
      expect(cb).toHaveBeenCalledWith('nope', null)

      const id = freshId()
      writeData(id, 'claude', '')
      const term = xt.instances.at(-1) as FakeTerminal
      term.setScreen(SCREEN)
      requestMenuScan(id)
      expect(cb).toHaveBeenLastCalledWith(id, expect.objectContaining({ selectedIndex: 0 }))
    })

    it('only claude terminals are scanned', () => {
      const id = freshId()
      writeData(id, 'shell', '')
      const term = xt.instances.at(-1) as FakeTerminal
      expect(term.onWriteParsed).not.toHaveBeenCalled()
    })
  })
})

type FakeTerminal = InstanceType<typeof xt.FakeTerminal>
