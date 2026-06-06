import { vi } from 'vitest'

type DataCb = (data: string) => void
type ExitCb = (e: { exitCode: number; signal?: number }) => void

/** A node-pty IPty test double whose data/exit callbacks can be driven manually. */
export class FakePty {
  pid: number
  cols = 80
  rows = 24
  private dataCbs: DataCb[] = []
  private exitCbs: ExitCb[] = []

  write = vi.fn()
  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols
    this.rows = rows
  })
  kill = vi.fn()

  constructor(pid: number) {
    this.pid = pid
  }

  onData(cb: DataCb): { dispose(): void } {
    this.dataCbs.push(cb)
    return { dispose: () => {} }
  }

  onExit(cb: ExitCb): { dispose(): void } {
    this.exitCbs.push(cb)
    return { dispose: () => {} }
  }

  /** Simulate the process emitting output. */
  emitData(data: string): void {
    for (const cb of this.dataCbs) cb(data)
  }

  /** Simulate the process exiting. */
  emitExit(exitCode = 0): void {
    for (const cb of this.exitCbs) cb({ exitCode })
  }
}

/**
 * Install a `node-pty` mock whose `spawn` returns FakePty instances with
 * incrementing pids. Returns helpers to inspect the spawned procs.
 *
 * Call inside a `vi.mock('node-pty', …)` factory is not possible (hoisting), so
 * tests use `vi.mock('node-pty')` + this to wire the implementation in a
 * `beforeEach`. See ptyManager.test.ts.
 */
export function makePtyState(): {
  spawned: FakePty[]
  spawn: ReturnType<typeof vi.fn>
  reset: () => void
} {
  const spawned: FakePty[] = []
  let nextPid = 1000
  const spawn = vi.fn(() => {
    const p = new FakePty(nextPid++)
    spawned.push(p)
    return p
  })
  return {
    spawned,
    spawn,
    reset: () => {
      spawned.length = 0
      nextPid = 1000
      spawn.mockClear()
    }
  }
}
