import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakePty, makePtyState } from '../helpers/fakePty'

// node-pty is a native module; replace spawn with our test double. The factory
// runs before imports, so it delegates to a holder the test populates per-run.
const holder = vi.hoisted(() => ({ spawn: (..._args: unknown[]): unknown => undefined }))
vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => holder.spawn(...args) }))

import {
  attach,
  killAll,
  killWorkspace,
  resize,
  runTask,
  setMainWindow,
  startClaude,
  startShell,
  stopTask,
  write
} from '../../src/main/ptyManager'

const ptyState = makePtyState()
let send: ReturnType<typeof vi.fn>
let killSpy: ReturnType<typeof vi.spyOn>

const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv
const baseOpts = { cwd: '/wt', env, cols: 80, rows: 24 }

beforeEach(() => {
  holder.spawn = ptyState.spawn as never
  // process.kill must be stubbed BEFORE any killProc runs (incl. the cleanup below).
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)
  killAll() // clear entries left by the previous test
  ptyState.reset()
  killSpy.mockClear()
  send = vi.fn()
  setMainWindow({ send, isDestroyed: () => false } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const last = (): FakePty => ptyState.spawned[ptyState.spawned.length - 1]

describe('attach + streaming', () => {
  it('buffers output, then attach returns the snapshot and flips streaming on', () => {
    startClaude({ id: 'w1', ...baseOpts })
    last().emitData('hello')
    // Not streaming yet → nothing forwarded.
    expect(send).not.toHaveBeenCalledWith('pty:data', expect.anything())

    const snapshot = attach('w1', 'claude')
    expect(snapshot).toBe('hello')

    last().emitData(' world')
    expect(send).toHaveBeenCalledWith('pty:data', { id: 'w1', kind: 'claude', data: ' world' })
  })

  it('does not forward data to a destroyed renderer', () => {
    setMainWindow({ send, isDestroyed: () => true } as never)
    startClaude({ id: 'w1', ...baseOpts })
    attach('w1', 'claude')
    last().emitData('x')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('buffer cap', () => {
  it('keeps only the last MAX_BUFFER (500k) chars', () => {
    startClaude({ id: 'w1', ...baseOpts })
    last().emitData('a'.repeat(300_000))
    last().emitData('b'.repeat(300_000))
    const snapshot = attach('w1', 'claude')
    expect(snapshot.length).toBe(500_000)
    expect(snapshot.endsWith('b')).toBe(true)
    expect(snapshot.startsWith('a')).toBe(true)
  })
})

describe('startClaude', () => {
  it('spawns an interactive claude session once (idempotent)', () => {
    startClaude({ id: 'w1', ...baseOpts })
    startClaude({ id: 'w1', ...baseOpts })
    expect(ptyState.spawn).toHaveBeenCalledTimes(1)
    expect(ptyState.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'exec claude'],
      expect.objectContaining({ cwd: '/wt', name: 'xterm-256color' })
    )
  })

  it('appends configured args to the claude command', () => {
    startClaude({ id: 'w1', ...baseOpts, args: '--dangerously-skip-permissions' })
    expect(ptyState.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', 'exec claude --dangerously-skip-permissions'],
      expect.anything()
    )
  })

  it('ignores blank/whitespace-only args', () => {
    startClaude({ id: 'w1', ...baseOpts, args: '   ' })
    expect(ptyState.spawn).toHaveBeenCalledWith('/bin/bash', ['-lc', 'exec claude'], expect.anything())
  })
})

describe('startShell', () => {
  it('uses env.SHELL when set and is idempotent', () => {
    startShell({ id: 'w1', ...baseOpts, env: { ...env, SHELL: '/usr/bin/zsh' } })
    startShell({ id: 'w1', ...baseOpts, env: { ...env, SHELL: '/usr/bin/zsh' } })
    expect(ptyState.spawn).toHaveBeenCalledTimes(1)
    expect(ptyState.spawn).toHaveBeenCalledWith('/usr/bin/zsh', ['-l'], expect.anything())
  })
})

describe('killProc (process-group semantics)', () => {
  it('signals the whole process group with the negative pid', () => {
    startShell({ id: 'w1', ...baseOpts })
    const proc = last()
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts })
    const taskProc = last()
    stopTask('w1')
    expect(killSpy).toHaveBeenCalledWith(-taskProc.pid, 'SIGTERM')
    expect(proc).toBeDefined()
  })

  it('falls back to proc.kill() when the group kill throws', () => {
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts })
    const taskProc = last()
    killSpy.mockImplementation(() => {
      throw new Error('ESRCH')
    })
    stopTask('w1')
    expect(taskProc.kill).toHaveBeenCalled()
  })
})

describe('runTask', () => {
  it('builds a labeled bash command containing the script path', () => {
    void runTask({ id: 'w1', scriptPath: '/path/to/setup.sh', label: 'setup', ...baseOpts })
    const [, args] = ptyState.spawn.mock.calls[0]
    const cmd = (args as string[])[1]
    expect((args as string[])[0]).toBe('-lc')
    expect(cmd).toContain('/path/to/setup.sh')
    expect(cmd).toContain('setup')
  })

  it('resolves with the exit code', async () => {
    const p = runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts })
    last().emitExit(3)
    await expect(p).resolves.toBe(3)
  })

  it('emits task:running true when tracked and false on exit', () => {
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts, track: true })
    expect(send).toHaveBeenCalledWith('task:running', { id: 'w1', running: true })
    send.mockClear()
    last().emitExit(0)
    expect(send).toHaveBeenCalledWith('pty:exit', { id: 'w1', kind: 'task', exitCode: 0 })
    expect(send).toHaveBeenCalledWith('task:running', { id: 'w1', running: false })
  })

  it('does not emit task:running true when not tracked', () => {
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'setup', ...baseOpts })
    expect(send).not.toHaveBeenCalledWith('task:running', expect.anything())
  })

  it('kills the previous task proc before starting a new one', () => {
    void runTask({ id: 'w1', scriptPath: '/a.sh', label: 'a', ...baseOpts })
    const first = last()
    killSpy.mockClear()
    void runTask({ id: 'w1', scriptPath: '/b.sh', label: 'b', ...baseOpts })
    expect(killSpy).toHaveBeenCalledWith(-first.pid, 'SIGTERM')
    expect(ptyState.spawn).toHaveBeenCalledTimes(2)
  })

  it('a superseded proc exiting does not emit the tracked running:false', () => {
    void runTask({ id: 'w1', scriptPath: '/a.sh', label: 'a', ...baseOpts, track: true })
    const first = last()
    void runTask({ id: 'w1', scriptPath: '/b.sh', label: 'b', ...baseOpts, track: true })
    send.mockClear()
    first.emitExit(0) // the replaced proc exits late
    expect(send).toHaveBeenCalledWith('pty:exit', { id: 'w1', kind: 'task', exitCode: 0 })
    expect(send).not.toHaveBeenCalledWith('task:running', { id: 'w1', running: false })
  })
})

describe('stopTask', () => {
  it('is a no-op when there is no task proc', () => {
    expect(() => stopTask('nope')).not.toThrow()
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('emits running:false synchronously when stopping a tracked run', () => {
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts, track: true })
    send.mockClear()
    stopTask('w1')
    // Does not wait for the proc's onExit — emitted right away so the Run/Stop
    // button clears even if the proc is later superseded (e.g. by the archive script).
    expect(send).toHaveBeenCalledWith('task:running', { id: 'w1', running: false })
  })

  it('does not re-emit running:false if a superseded run proc exits later', () => {
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts, track: true })
    const runProc = last()
    stopTask('w1')
    // Archive script replaces the (killed) run proc before it exits.
    void runTask({ id: 'w1', scriptPath: '/archive.sh', label: 'archive', ...baseOpts })
    send.mockClear()
    runProc.emitExit(0)
    expect(send).not.toHaveBeenCalledWith('task:running', { id: 'w1', running: false })
  })

  it('does not emit running:false when stopping an untracked task', () => {
    void runTask({ id: 'w1', scriptPath: '/setup.sh', label: 'setup', ...baseOpts })
    send.mockClear()
    stopTask('w1')
    expect(send).not.toHaveBeenCalledWith('task:running', expect.anything())
  })
})

describe('write & resize', () => {
  it('routes input to the matching proc and no-ops for unknown', () => {
    startShell({ id: 'w1', ...baseOpts })
    write('w1', 'shell', 'ls\n')
    expect(last().write).toHaveBeenCalledWith('ls\n')
    expect(() => write('w1', 'claude', 'x')).not.toThrow()
  })

  it('clamps resize dimensions to >= 1 and swallows errors', () => {
    startShell({ id: 'w1', ...baseOpts })
    resize('w1', 'shell', 0, -5)
    expect(last().resize).toHaveBeenCalledWith(1, 1)
    last().resize.mockImplementation(() => {
      throw new Error('exited')
    })
    expect(() => resize('w1', 'shell', 80, 24)).not.toThrow()
    expect(() => resize('nope', 'shell', 80, 24)).not.toThrow()
  })
})

describe('killWorkspace & killAll', () => {
  it('killWorkspace kills all three kinds and clears their buffers', () => {
    startClaude({ id: 'w1', ...baseOpts })
    startShell({ id: 'w1', ...baseOpts })
    void runTask({ id: 'w1', scriptPath: '/s.sh', label: 'run', ...baseOpts })
    attach('w1', 'claude')
    last() // task proc
    killSpy.mockClear()
    killWorkspace('w1')
    expect(killSpy).toHaveBeenCalledTimes(3)
    // Entry was deleted → a fresh attach returns an empty buffer.
    expect(attach('w1', 'claude')).toBe('')
  })

  it('killAll kills every proc and clears the map', () => {
    startClaude({ id: 'w1', ...baseOpts })
    startClaude({ id: 'w2', ...baseOpts })
    killSpy.mockClear()
    killAll()
    expect(killSpy).toHaveBeenCalledTimes(2)
    expect(attach('w1', 'claude')).toBe('')
    expect(attach('w2', 'claude')).toBe('')
  })
})
