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
  /** Claude only: true while Claude's TUI shows its "working" status line. */
  busy?: boolean
  /** Debounce timer that flips `busy` back off after the marker stops refreshing. */
  busyTimer?: ReturnType<typeof setTimeout>
  /** Claude only: last few stripped chars, to catch a marker split across chunks. */
  claudeCarry?: string
}

const MAX_BUFFER = 500_000
// Detecting whether Claude is "working" off raw output alone is wrong — the TUI
// also redraws on startup, cursor blink and idle prompt. We use two signals from
// the status line, which only appears while Claude is actively running:
//
//  1. The hint "esc to interrupt" — shown the moment Claude starts working. We
//     use it to TURN the indicator ON. It never appears in the startup banner or
//     idle prompt, so opening a window can't trigger a false spin. Its word gaps
//     are cursor-move escapes ("esc\x1b[7Gto\x1b[10G…"), not spaces, so after
//     ANSI-stripping the words collapse ("esctointerrupt"); match loosely across
//     any non-letter separators to hit both that and a literal-spaces form.
//  2. The animated spinner glyph (star frames ✶✻✽… and braille dots) — refreshes
//     several times a second the WHOLE time Claude works, including while a tool
//     or shell command blocks, when the "esc to interrupt" line stops repainting
//     for a few seconds. We use it only to KEEP the indicator alive once on, so a
//     lone spinner glyph (e.g. the "✻ Welcome" banner) can't turn it on by itself.
const CLAUDE_WORKING_MARKER = /esc[^a-z]*to[^a-z]*interrupt/i
// Star dingbats (U+2720–274F, incl. ✶✷✸✻✽) and braille (U+2800–28FF) cover both
// spinner styles; neither occurs in normal code/prose, so keep-alive is safe.
const CLAUDE_SPINNER = /[✠-❏⠀-⣿]/
// Once neither signal refreshes for this long, treat Claude as idle. Must be
// comfortably longer than the spinner refresh interval (sub-second).
const CLAUDE_IDLE_MS = 2000
// Carry length: shorter than the collapsed marker ("esctointerrupt") so a stale
// marker can't fully linger in the carry (which would wedge busy on), while a
// marker split across two PTY reads is still rejoined and caught.
const CLAUDE_CARRY = 'esctointerrupt'.length - 1
// Strips ANSI escape sequences so the marker matches even when colorized.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
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

function send(channel: string, payload: unknown): void {
  if (mainWC && !mainWC.isDestroyed()) mainWC.send(channel, payload)
}

/** Flip Claude's "working" state and notify the renderer only on a change. */
function setClaudeBusy(id: string, e: Entry, busy: boolean): void {
  if (e.busy === busy) return
  e.busy = busy
  send('claude:busy', { id, busy })
}

function wire(id: string, kind: PtyKind, e: Entry, proc: pty.IPty): void {
  proc.onData((d) => {
    e.buffer += d
    if (e.buffer.length > MAX_BUFFER) e.buffer = e.buffer.slice(-MAX_BUFFER)
    if (e.streaming && mainWC && !mainWC.isDestroyed()) {
      mainWC.send('pty:data', { id, kind, data: d })
    }
    // Claude is "working" only while its TUI status line is live. The interrupt
    // marker turns it ON (never present in the banner/idle prompt); the spinner
    // glyph keeps it alive while a blocking tool stops the marker repainting.
    // Raw output alone (startup redraw, cursor blink, idle prompt) does not count.
    if (kind === 'claude') {
      const stripped = d.replace(ANSI, '')
      const hay = (e.claudeCarry ?? '') + stripped
      e.claudeCarry = hay.slice(-CLAUDE_CARRY)
      // Prepend a short carry so a marker split across two reads is still caught.
      const startsWork = CLAUDE_WORKING_MARKER.test(hay)
      const sustainsWork = e.busy === true && CLAUDE_SPINNER.test(stripped)
      if (startsWork || sustainsWork) {
        setClaudeBusy(id, e, true)
        if (e.busyTimer) clearTimeout(e.busyTimer)
        e.busyTimer = setTimeout(() => setClaudeBusy(id, e, false), CLAUDE_IDLE_MS)
      }
    }
  })
  proc.onExit(({ exitCode }) => {
    // A newer proc may have replaced this one (e.g. run restarted); only the
    // current proc should clear state and emit lifecycle events.
    const superseded = e.proc !== proc
    if (!superseded) e.proc = undefined
    if (kind === 'claude' && !superseded) {
      if (e.busyTimer) clearTimeout(e.busyTimer)
      setClaudeBusy(id, e, false)
    }
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
  args?: string
}): void {
  const e = ensure(opts.id, 'claude')
  if (e.proc) return
  const args = opts.args?.trim()
  const proc = pty.spawn('/bin/bash', ['-lc', args ? `exec claude ${args}` : 'exec claude'], {
    name: 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols || 80,
    rows: opts.rows || 24
  })
  e.proc = proc
  wire(opts.id, 'claude', e, proc)
}

/** Start a free interactive shell in the workspace directory (idempotent). */
export function startShell(opts: {
  id: string
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}): void {
  const e = ensure(opts.id, 'shell')
  if (e.proc) return
  const shell = opts.env.SHELL || process.env.SHELL || '/bin/bash'
  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols || 80,
    rows: opts.rows || 24
  })
  e.proc = proc
  wire(opts.id, 'shell', e, proc)
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
  if (!e?.proc) return
  // Emit running:false synchronously rather than relying on the proc's onExit:
  // when stopping ahead of archive, finishArchive replaces e.proc with the
  // archive script before this proc exits, so onExit treats it as superseded and
  // never clears the Run/Stop state — leaving the button stuck at "Stop".
  if (e.tracked) {
    e.tracked = false
    if (mainWC && !mainWC.isDestroyed()) {
      mainWC.send('task:running', { id, running: false })
    }
  }
  killProc(e.proc)
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
  for (const kind of ['claude', 'task', 'shell'] as PtyKind[]) {
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
