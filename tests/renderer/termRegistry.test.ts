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
    loadAddon = vi.fn()
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
    fit = vi.fn()
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

  it('routes data to the matching terminal', () => {
    const id = freshId()
    writeData(id, 'claude', 'hello')
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

  it('mount places the wrapper in the host; fitAndResize no-ops when detached', () => {
    const id = freshId()
    // Created but not mounted → wrapper not connected → fitAndResize is a no-op.
    writeData(id, 'claude', '')
    fitAndResize(id, 'claude')
    expect(api.resizePty).not.toHaveBeenCalled()

    const host = document.createElement('div')
    document.body.appendChild(host)
    mount(host, id, 'claude')
    expect(host.querySelector('.term-mount')).not.toBeNull()

    fitAndResize(id, 'claude')
    expect(xt.instances[0].focus).toHaveBeenCalled()
    expect(api.resizePty).toHaveBeenCalledWith(id, 'claude', 80, 24)
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
})

type FakeTerminal = InstanceType<typeof xt.FakeTerminal>
