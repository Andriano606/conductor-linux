import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { PtyKind } from '../shared/types'

interface Entry {
  buffer: string
  /** When true, live output is forwarded to the renderer. Flips on attach. */
  streaming: boolean
  proc?: pty.IPty
  /** Current task proc is a tracked "run" (drives the Run/Stop button). */
  tracked?: boolean
}

const MAX_BUFFER = 500_000
const entries = new Map<string, Entry>()
let mainWC: WebContents | null = null

export function setMainWindow(wc: WebContents): void {
  mainWC = wc
}

function key(id: string, kind: PtyKind): string {
  return `${id}:${kind}`
}

function ensure(id: string, kind: PtyKind): Entry {
  const k = key(id, kind)
  let e = entries.get(k)
  if (!e) {
    e = { buffer: '', streaming: false }
    entries.set(k, e)
  }
  return e
}

/**
 * Kill a proc together with its whole child process group, so a server the run
 * script started (e.g. `npm run dev`) dies too — node-pty's own kill only
 * signals the shell, leaving grandchildren (and the bound port) alive. node-pty
 * spawns each proc as a session leader, so its pid is the group id (-pid).
 */
function killProc(proc: pty.IPty): void {
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }
}

function wire(id: string, kind: PtyKind, e: Entry, proc: pty.IPty): void {
  proc.onData((d) => {
    e.buffer += d
    if (e.buffer.length > MAX_BUFFER) e.buffer = e.buffer.slice(-MAX_BUFFER)
    if (e.streaming && mainWC && !mainWC.isDestroyed()) {
      mainWC.send('pty:data', { id, kind, data: d })
    }
  })
  proc.onExit(({ exitCode }) => {
    // A newer proc may have replaced this one (e.g. run restarted); only the
    // current proc should clear state and emit lifecycle events.
    const superseded = e.proc !== proc
    if (!superseded) e.proc = undefined
    if (mainWC && !mainWC.isDestroyed()) {
      mainWC.send('pty:exit', { id, kind, exitCode })
      if (kind === 'task' && !superseded && e.tracked) {
        e.tracked = false
        mainWC.send('task:running', { id, running: false })
      }
    }
  })
}

/** Start the interactive Claude session for a workspace (idempotent). */
export function startClaude(opts: {
  id: string
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}): void {
  const e = ensure(opts.id, 'claude')
  if (e.proc) return
  const proc = pty.spawn('/bin/bash', ['-lc', 'exec claude'], {
    name: 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols || 80,
    rows: opts.rows || 24
  })
  e.proc = proc
  wire(opts.id, 'claude', e, proc)
}

/**
 * Run a script file in the workspace's "task" terminal. Output accumulates in
 * the task buffer (preserved across setup/run/archive). Returns the exit code.
 */
export function runTask(opts: {
  id: string
  scriptPath: string
  label: string
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
  /** When true, this is the long-running "run" — drives the Run/Stop button. */
  track?: boolean
}): Promise<number> {
  const e = ensure(opts.id, 'task')
  if (e.proc) killProc(e.proc)
  const q = JSON.stringify
  const cmd = `printf '\\n\\033[1;36m▶ %s\\033[0m\\n' ${q(opts.label)}; bash ${q(opts.scriptPath)}; code=$?; printf '\\033[1;36m[%s exited %s]\\033[0m\\n' ${q(opts.label)} "$code"; exit $code`
  const proc = pty.spawn('/bin/bash', ['-lc', cmd], {
    name: 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols || 80,
    rows: opts.rows || 24
  })
  e.proc = proc
  e.tracked = !!opts.track
  wire(opts.id, 'task', e, proc)
  if (opts.track && mainWC && !mainWC.isDestroyed()) {
    mainWC.send('task:running', { id: opts.id, running: true })
  }
  return new Promise((resolve) => {
    proc.onExit(({ exitCode }) => resolve(exitCode))
  })
}

/** Stop the running task proc (the run server) for a workspace. */
export function stopTask(id: string): void {
  const e = entries.get(key(id, 'task'))
  if (e?.proc) killProc(e.proc)
}

export function write(id: string, kind: PtyKind, data: string): void {
  entries.get(key(id, kind))?.proc?.write(data)
}

export function resize(id: string, kind: PtyKind, cols: number, rows: number): void {
  const proc = entries.get(key(id, kind))?.proc
  if (!proc) return
  try {
    proc.resize(Math.max(1, cols), Math.max(1, rows))
  } catch {
    /* terminal may have exited */
  }
}

/** Mark a terminal as live and return its current buffer for replay. Atomic. */
export function attach(id: string, kind: PtyKind): string {
  const e = ensure(id, kind)
  e.streaming = true
  return e.buffer
}

export function killWorkspace(id: string): void {
  for (const kind of ['claude', 'task'] as PtyKind[]) {
    const k = key(id, kind)
    const e = entries.get(k)
    if (e?.proc) killProc(e.proc)
    entries.delete(k)
  }
}

export function killAll(): void {
  for (const [, e] of entries) {
    if (e.proc) killProc(e.proc)
  }
  entries.clear()
}
