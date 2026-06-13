import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import type {
  ChatAnswer,
  ChatCommand,
  ChatEvent,
  ChatItem,
  ChatPending,
  ChatQuestion,
  ChatSnapshot
} from '../shared/types'

/**
 * Structured Claude session per workspace. Instead of a PTY running the TUI,
 * we spawn `claude` in stream-json print mode and speak NDJSON over stdio:
 * every message is parsed and kept as a structured transcript that our own
 * chat UI renders. `--permission-prompt-tool stdio` makes the CLI emit
 * control_request/can_use_tool messages for tool permissions AND for the
 * AskUserQuestion tool — those become ChatPending entries the user answers
 * with buttons (options) or free text from the chat input.
 */

interface PendingInternal {
  pending: ChatPending
  /** Raw tool input, echoed back in the allow response. */
  rawInput: unknown
}

interface Entry {
  proc?: ChildProcess
  items: ChatItem[]
  /** Permission/question requests are answered in FIFO order; [0] is shown. */
  queue: PendingInternal[]
  busy: boolean
  seq: number
  sessionId?: string
  stdoutBuf: string
  stderrTail: string
  /** Assistant item currently receiving partial text deltas. */
  liveId?: string
  /** Spawn options remembered so the session can be restarted lazily. */
  opts?: StartOpts
  /** True while the current proc was started with --resume <sessionId>. */
  resuming?: boolean
  /** Set by killChat so an intentional kill doesn't log an exit notice. */
  killed?: boolean
  /** Debounce timer for persisting the transcript to disk. */
  saveTimer?: ReturnType<typeof setTimeout>
  /** Slash commands reported by the CLI (for the input's autocomplete). */
  commands?: ChatCommand[]
  /**
   * Command names last presented to the user, persisted so drift (a command
   * added or removed by a CLI upgrade) is detected across restarts. See
   * detectCommandDrift.
   */
  commandSnapshot?: string[]
  /** Request id of the initialize handshake sent at spawn. */
  initRequestId?: string
  /**
   * Whether the current turn already produced assistant text. When it didn't
   * (slash commands like /usage answer only via the result event), the result
   * text is rendered as the assistant's reply instead of being dropped.
   */
  turnHadText?: boolean
}

export interface StartOpts {
  id: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Extra user-configured CLI args (settings.claudeArgs), appended raw. */
  args?: string
  /** Session id to resume (persisted on the workspace across app restarts). */
  resume?: string
}

const MAX_ITEMS = 500
const STDERR_TAIL = 2000
const SAVE_DEBOUNCE_MS = 500
// The CLI rejects TUI-only commands in print mode with this exact sentence.
const UNAVAILABLE_RE = /^(\/\S+)\s+isn'?t available in this environment\.?$/i

const entries = new Map<string, Entry>()
let mainWC: WebContents | null = null
/** Persists the session id (or clears it on a failed resume). */
let sessionIdSink: (id: string, sessionId: string | undefined) => void = () => {}
/** Directory transcripts are persisted to; null (tests) = memory only. */
let storageDir: string | null = null

export function setChatWindow(wc: WebContents): void {
  mainWC = wc
}

export function onChatSessionId(cb: (id: string, sessionId: string | undefined) => void): void {
  sessionIdSink = cb
}

/**
 * Enable transcript persistence: each workspace's chat is saved (debounced) to
 * <dir>/<workspaceId>.json and loaded back on the first touch, so the visible
 * history survives app restarts and archive/restore. The conversation itself
 * is resumed separately via --resume with the persisted session id.
 */
export function setChatStorageDir(dir: string | null): void {
  storageDir = dir
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      storageDir = null
    }
  }
}

function chatFile(id: string): string | null {
  return storageDir ? join(storageDir, `${id}.json`) : null
}

interface Persisted {
  items: ChatItem[]
  commandSnapshot?: string[]
}

function loadPersisted(id: string): Persisted {
  const f = chatFile(id)
  if (!f || !existsSync(f)) return { items: [] }
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as Persisted
    const items = Array.isArray(parsed.items) ? parsed.items : []
    // A tool call killed mid-run (app quit / archive) can never complete now —
    // close it out as errored so the UI doesn't show an eternal spinner.
    return {
      items: items.map((it) =>
        it.role === 'tool' && !it.done ? { ...it, done: true, isError: true } : it
      ),
      commandSnapshot: Array.isArray(parsed.commandSnapshot)
        ? parsed.commandSnapshot.filter((n): n is string => typeof n === 'string')
        : undefined
    }
  } catch {
    return { items: [] }
  }
}

function saveNow(id: string, e: Entry): void {
  if (e.saveTimer) {
    clearTimeout(e.saveTimer)
    e.saveTimer = undefined
  }
  const f = chatFile(id)
  // A stale entry (replaced or already deleted) must not resurrect the file —
  // e.g. the killed proc's exit handler firing after deleteChatHistory.
  if (!f || entries.get(id) !== e) return
  try {
    const data: Persisted = { items: e.items, commandSnapshot: e.commandSnapshot }
    writeFileSync(f, JSON.stringify(data), 'utf8')
  } catch {
    /* best effort */
  }
}

function scheduleSave(id: string, e: Entry): void {
  if (!storageDir || e.saveTimer || entries.get(id) !== e) return
  e.saveTimer = setTimeout(() => {
    e.saveTimer = undefined
    saveNow(id, e)
  }, SAVE_DEBOUNCE_MS)
}

/** Remove the persisted transcript (workspace/project permanently deleted). */
export function deleteChatHistory(id: string): void {
  const f = chatFile(id)
  if (!f) return
  try {
    rmSync(f, { force: true })
  } catch {
    /* best effort */
  }
}

function ensure(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    const persisted = loadPersisted(id)
    e = {
      items: persisted.items,
      commandSnapshot: persisted.commandSnapshot,
      queue: [],
      busy: false,
      seq: 0,
      stdoutBuf: '',
      stderrTail: ''
    }
    entries.set(id, e)
  }
  return e
}

function send(channel: string, payload: unknown): void {
  if (mainWC && !mainWC.isDestroyed()) mainWC.send(channel, payload)
}

function emit(id: string, e: Entry, ev: ChatEvent): void {
  e.seq++
  send('chat:event', { id, seq: e.seq, ev })
  // Every transcript mutation flows through here — persist it (debounced).
  scheduleSave(id, e)
}

function pushItem(id: string, e: Entry, item: ChatItem): void {
  e.items.push(item)
  if (e.items.length > MAX_ITEMS) e.items.splice(0, e.items.length - MAX_ITEMS)
  emit(id, e, { type: 'item', item })
}

function info(id: string, e: Entry, text: string): void {
  pushItem(id, e, { id: randomUUID(), role: 'info', text, ts: Date.now() })
}

function setBusy(id: string, e: Entry, busy: boolean): void {
  if (e.busy === busy) return
  e.busy = busy
  emit(id, e, { type: 'busy', busy })
  // Same channel the PTY-based detection used — keeps the sidebar/toolbar
  // working-indicator wiring untouched.
  send('claude:busy', { id, busy })
}

function emitPending(id: string, e: Entry): void {
  emit(id, e, { type: 'pending', pending: e.queue[0]?.pending ?? null })
}

/** One-line human summary of a tool call, for permission prompts and the log. */
export function summarizeToolUse(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = i[k]
      if (typeof v === 'string' && v) return v
    }
    return ''
  }
  let s = ''
  switch (name) {
    case 'Bash':
      s = pick('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      s = pick('file_path', 'notebook_path')
      break
    case 'Glob':
    case 'Grep':
      s = pick('pattern')
      break
    case 'WebFetch':
    case 'WebSearch':
      s = pick('url', 'query')
      break
    case 'Task':
      s = pick('description', 'prompt')
      break
    case 'Skill':
      s = pick('skill')
      break
    default:
      try {
        s = JSON.stringify(input) ?? ''
      } catch {
        s = ''
      }
  }
  if (s.length > 300) s = s.slice(0, 299) + '…'
  return s
}

/** Shell-quote the fixed argv part; user args are appended raw (trusted). */
function buildCommand(opts: StartOpts): string {
  const fixed = [
    'claude',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool',
    'stdio'
  ]
  if (opts.resume) fixed.push('--resume', opts.resume)
  const quoted = fixed.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a)))
  const extra = opts.args?.trim()
  return `exec ${quoted.join(' ')}${extra ? ` ${extra}` : ''}`
}

/** Start the chat session for a workspace (idempotent while the proc lives). */
export function startChat(opts: StartOpts): void {
  const e = ensure(opts.id)
  e.opts = opts
  if (e.proc) return
  spawnProc(opts.id, e, opts)
}

/** Restart the session lazily (after a crash or a manual process kill). */
export function ensureChat(id: string): void {
  const e = entries.get(id)
  if (!e || e.proc || !e.opts) return
  spawnProc(id, e, { ...e.opts, resume: e.sessionId ?? e.opts.resume })
}

function spawnProc(id: string, e: Entry, opts: StartOpts): void {
  e.killed = false
  e.stdoutBuf = ''
  e.stderrTail = ''
  e.liveId = undefined
  e.resuming = !!opts.resume
  // Login shell so `claude` resolves from the user's PATH (e.g. ~/.local/bin);
  // detached gives it its own process group so killing -pid takes the whole
  // tree (claude's own bash tools etc.) down with it.
  const proc = spawn('/bin/bash', ['-lc', buildCommand(opts)], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  e.proc = proc

  proc.stdout?.on('data', (d: Buffer) => {
    e.stdoutBuf += d.toString()
    let i: number
    while ((i = e.stdoutBuf.indexOf('\n')) >= 0) {
      const line = e.stdoutBuf.slice(0, i)
      e.stdoutBuf = e.stdoutBuf.slice(i + 1)
      if (line.trim()) handleLine(id, e, line)
    }
  })
  proc.stderr?.on('data', (d: Buffer) => {
    e.stderrTail = (e.stderrTail + d.toString()).slice(-STDERR_TAIL)
  })
  // SDK-style handshake: the response carries the command list (with
  // descriptions) — so the autocomplete is populated right at session start,
  // before any message is sent.
  e.initRequestId = randomUUID()
  writeLine(e, {
    type: 'control_request',
    request_id: e.initRequestId,
    request: { subtype: 'initialize' }
  })
  proc.on('exit', (code) => {
    if (e.proc !== proc) return
    e.proc = undefined
    setBusy(id, e, false)
    if (e.queue.length) {
      e.queue = []
      emitPending(id, e)
    }
    saveNow(id, e)
    if (e.killed) return
    // A failed --resume (e.g. the session transcript was cleaned) exits
    // immediately with an error: drop the stale id and retry fresh once.
    if (code !== 0 && e.resuming) {
      e.sessionId = undefined
      sessionIdSink(id, undefined)
      info(id, e, 'Не вдалося відновити попередню сесію Claude — почато нову розмову.')
      if (e.opts) spawnProc(id, e, { ...e.opts, resume: undefined })
      return
    }
    if (code !== 0) {
      const err = e.stderrTail.trim()
      info(id, e, `Сесія Claude завершилась (код ${code})${err ? `\n${err}` : ''}`)
    }
  })
}

function writeLine(e: Entry, obj: unknown): void {
  e.proc?.stdin?.write(JSON.stringify(obj) + '\n')
}

/** Send a user message; (re)starts the session if it is not running. */
export function sendChatMessage(id: string, text: string): void {
  const e = ensure(id)
  if (!e.proc) ensureChat(id)
  pushItem(id, e, { id: randomUUID(), role: 'user', text, ts: Date.now() })
  setBusy(id, e, true)
  e.turnHadText = false
  writeLine(e, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

/**
 * Dispatch a typed `/command` to its local handler when the chat owns it.
 * The text falls through to the CLI (returns false) unless a registered local
 * command matches, its capability is present, AND the CLI hasn't started
 * providing it natively (native wins — see drift detection). With an argument
 * the command applies directly; without one it opens its option picker.
 */
/** Answer the currently pending question/permission request. */
export function answerChat(id: string, answer: ChatAnswer): void {
  const e = entries.get(id)
  if (!e) return
  const idx = e.queue.findIndex((p) => p.pending.requestId === answer.requestId)
  if (idx === -1) return
  const [{ pending, rawInput }] = e.queue.splice(idx, 1)

  if (answer.kind === 'question' && pending.kind === 'question') {
    const input = (rawInput ?? {}) as { questions?: ChatQuestion[] }
    respond(e, answer.requestId, {
      behavior: 'allow',
      updatedInput: { questions: input.questions ?? [], answers: answer.answers }
    })
    const summary = pending.questions
      .map((q) => {
        const a = answer.answers[q.question]
        return `${q.header || q.question}: ${a ?? '—'}`
      })
      .join('\n')
    pushItem(id, e, { id: randomUUID(), role: 'user', text: summary, answer: true, ts: Date.now() })
  } else if (answer.kind === 'permission' && pending.kind === 'permission') {
    if (answer.allow) {
      respond(e, answer.requestId, { behavior: 'allow', updatedInput: rawInput })
      info(id, e, `Дозволено: ${pending.toolName}`)
    } else {
      respond(e, answer.requestId, {
        behavior: 'deny',
        message: answer.message?.trim() || 'Користувач відхилив цю дію.'
      })
      info(
        id,
        e,
        `Відхилено: ${pending.toolName}${answer.message?.trim() ? ` — ${answer.message.trim()}` : ''}`
      )
    }
  }
  emitPending(id, e)
}

function respond(e: Entry, requestId: string, response: unknown): void {
  writeLine(e, {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response }
  })
}

/** Interrupt the current turn (the chat's Stop button). */
export function interruptChat(id: string): void {
  const e = entries.get(id)
  if (!e?.proc) return
  writeLine(e, {
    type: 'control_request',
    request_id: randomUUID(),
    request: { subtype: 'interrupt' }
  })
}

/**
 * Snapshot for the renderer. Restarting a dead session is the caller's job
 * (the chat:attach IPC handler goes through workspaces.ensureClaudeChat).
 */
export function attachChat(id: string): ChatSnapshot {
  const e = ensure(id)
  return {
    items: e.items,
    pending: e.queue[0]?.pending ?? null,
    busy: e.busy,
    seq: e.seq,
    commands: e.commands ?? []
  }
}

function killProcGroup(proc: ChildProcess): void {
  if (typeof proc.pid !== 'number') return
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

/**
 * Kill the session and drop its in-memory state (workspace archived/deleted).
 * The persisted transcript file is kept — it reloads on restore; permanent
 * deletion goes through deleteChatHistory.
 */
export function killChat(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.killed = true
  saveNow(id, e)
  if (e.proc) killProcGroup(e.proc)
  entries.delete(id)
}

/** Kill the session's process but keep the transcript (force-clean action). */
export function stopChatProc(id: string): void {
  const e = entries.get(id)
  if (!e?.proc) return
  e.killed = true
  saveNow(id, e)
  killProcGroup(e.proc)
}

export function killAllChats(): void {
  for (const [id, e] of entries) {
    e.killed = true
    saveNow(id, e)
    if (e.proc) killProcGroup(e.proc)
  }
  entries.clear()
}

// ── stream-json message handling ────────────────────────────────────────────

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
}

function handleLine(id: string, e: Entry, line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line) as Record<string, unknown>
  } catch {
    return // not NDJSON (stray CLI output) — ignore
  }
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        // A changed session id mid-session means the CLI reset the
        // conversation (/clear does this) — drop the transcript to match.
        if (e.sessionId && msg.session_id !== e.sessionId) {
          e.items = []
          e.liveId = undefined
          emit(id, e, { type: 'clear' })
          info(id, e, 'Розпочато нову розмову — контекст очищено.')
          saveNow(id, e)
        }
        // The session came up — a later non-zero exit is a crash, not a
        // failed --resume, so it must not silently discard the session id.
        e.resuming = false
        e.sessionId = msg.session_id
        sessionIdSink(id, msg.session_id)
        // Bare fallback for the command list — initialize (with descriptions)
        // normally beats this; don't let names-only overwrite it.
        if (!e.commands && Array.isArray(msg.slash_commands)) {
          e.commands = (msg.slash_commands as unknown[])
            .filter((c): c is string => typeof c === 'string')
            .map((name) => ({ name }))
          emit(id, e, { type: 'commands', commands: e.commands })
        }
      } else if (msg.subtype === 'status') {
        // Slash-command feedback (e.g. /compact): surface failures so the
        // command doesn't look silently swallowed.
        if (typeof msg.compact_error === 'string' && msg.compact_error) {
          info(id, e, `Компакт не вдався: ${msg.compact_error}`)
        }
      }
      break
    case 'stream_event':
      handleStreamEvent(id, e, (msg.event ?? {}) as Record<string, unknown>)
      break
    case 'assistant':
      handleAssistant(id, e, msg)
      break
    case 'user':
      handleToolResults(id, e, msg)
      break
    case 'control_request':
      handleControlRequest(id, e, msg)
      break
    case 'control_response': {
      const resp = (msg.response ?? {}) as {
        subtype?: string
        request_id?: string
        error?: string
        response?: Record<string, unknown>
      }
      if (resp.request_id && resp.request_id === e.initRequestId) {
        e.initRequestId = undefined
        if (resp.subtype === 'success') handleInitialize(id, e, resp.response ?? {})
        // An old CLI without `initialize` falls back to init's slash_commands.
      } else if (resp.subtype === 'error' && typeof resp.error === 'string' && resp.error) {
        // Reply to another of OUR control requests (e.g. interrupt) — surface
        // failures instead of swallowing them.
        info(id, e, `Помилка: ${resp.error}`)
      }
      break
    }
    case 'control_cancel_request':
      cancelPending(id, e, msg)
      break
    case 'result': {
      e.liveId = undefined
      setBusy(id, e, false)
      if (msg.is_error && typeof msg.result === 'string' && msg.result) {
        info(id, e, msg.result)
      } else if (!e.turnHadText && typeof msg.result === 'string' && msg.result.trim()) {
        const sentinel = msg.result.trim().match(UNAVAILABLE_RE)
        if (sentinel) {
          // The CLI rejected a TUI-only command — say so plainly (this is the
          // runtime "command unavailable/changed" feedback) instead of echoing
          // its bare sentence as if Claude had replied.
          info(
            id,
            e,
            `Команда ${sentinel[1]} недоступна в цьому режимі — вона працює лише в інтерактивному терміналі Claude.`
          )
        } else {
          // Some slash commands (/usage, /context, …) answer only through the
          // result event — render that text as the reply so the command's
          // output is visible instead of silently dropped.
          pushItem(id, e, { id: randomUUID(), role: 'assistant', text: msg.result, ts: Date.now() })
        }
      }
      e.turnHadText = true
      // A finished turn is a natural checkpoint — flush the debounced save.
      saveNow(id, e)
      break
    }
  }
}

/**
 * The initialize handshake response: the command list, with descriptions and
 * argument hints. Only the CLI's own commands are shown — nothing is added or
 * emulated locally. detectCommandDrift then reports anything that changed.
 */
function handleInitialize(id: string, e: Entry, r: Record<string, unknown>): void {
  const cliCommands: ChatCommand[] = Array.isArray(r.commands)
    ? (r.commands as Record<string, unknown>[])
        .filter((c) => typeof c.name === 'string' && c.name)
        .map((c) => ({
          name: c.name as string,
          description: typeof c.description === 'string' ? c.description : undefined,
          argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : undefined
        }))
    : []
  detectCommandDrift(id, e, cliCommands)
  if (cliCommands.length) {
    e.commands = cliCommands
    emit(id, e, { type: 'commands', commands: cliCommands })
  }
}

/**
 * Compare the command names now reported by the CLI against the set persisted
 * from the previous session and report what changed, so a CLI upgrade that
 * adds or removes a command never passes silently. The first run has no
 * baseline, so it only records the snapshot.
 */
function detectCommandDrift(id: string, e: Entry, commands: ChatCommand[]): void {
  const next = commands.map((c) => c.name)
  const prev = e.commandSnapshot
  e.commandSnapshot = next
  if (!prev) return

  const fmt = (names: string[]): string => names.map((n) => `/${n}`).join(', ')
  const removed = prev.filter((n) => !next.includes(n))
  const added = next.filter((n) => !prev.includes(n))
  if (removed.length) info(id, e, `Команди більше недоступні: ${fmt(removed)}`)
  if (added.length) info(id, e, `Нові команди: ${fmt(added)}`)
}

/** Partial text deltas: stream assistant text into a live item as it arrives. */
function handleStreamEvent(id: string, e: Entry, ev: Record<string, unknown>): void {
  if (ev.type === 'content_block_start') {
    const block = (ev.content_block ?? {}) as ContentBlock
    if (block.type !== 'text') return
    if (e.liveId) {
      appendLive(id, e, '\n\n')
      return
    }
    const item: ChatItem = { id: randomUUID(), role: 'assistant', text: '', ts: Date.now() }
    e.liveId = item.id
    pushItem(id, e, item)
  } else if (ev.type === 'content_block_delta') {
    const delta = (ev.delta ?? {}) as { type?: string; text?: string }
    if (delta.type === 'text_delta' && delta.text && e.liveId) appendLive(id, e, delta.text)
  }
}

function appendLive(id: string, e: Entry, text: string): void {
  const item = e.items.find((it) => it.id === e.liveId)
  if (!item) return
  item.text += text
  e.turnHadText = true
  emit(id, e, { type: 'append', itemId: item.id, text })
}

/**
 * A complete assistant message. Text was already streamed via deltas (when
 * partial messages are on) — the joined text here is authoritative, so the
 * live item is finalized with it. Tool calls become running tool items.
 */
function handleAssistant(id: string, e: Entry, msg: Record<string, unknown>): void {
  const message = (msg.message ?? {}) as { content?: ContentBlock[] }
  const blocks = Array.isArray(message.content) ? message.content : []
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n\n')
  if (text) {
    const live = e.liveId ? e.items.find((it) => it.id === e.liveId) : undefined
    if (live) {
      live.text = text
      emit(id, e, { type: 'update', item: live })
    } else {
      pushItem(id, e, { id: randomUUID(), role: 'assistant', text, ts: Date.now() })
    }
    e.liveId = undefined
    e.turnHadText = true
  }
  for (const b of blocks) {
    // AskUserQuestion is not logged as a tool — it surfaces as the pending
    // question UI instead.
    if (b.type !== 'tool_use' || !b.id || b.name === 'AskUserQuestion') continue
    pushItem(id, e, {
      id: b.id,
      role: 'tool',
      toolName: b.name ?? 'tool',
      text: summarizeToolUse(b.name ?? '', b.input),
      done: false,
      ts: Date.now()
    })
  }
}

/** user events carry tool_result blocks — flip the matching tool item done. */
function handleToolResults(id: string, e: Entry, msg: Record<string, unknown>): void {
  const message = (msg.message ?? {}) as { content?: ContentBlock[] | string }
  if (!Array.isArray(message.content)) return
  for (const b of message.content) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue
    const item = e.items.find((it) => it.id === b.tool_use_id)
    if (!item || item.done) continue
    item.done = true
    item.isError = !!b.is_error
    emit(id, e, { type: 'update', item })
  }
}

function handleControlRequest(id: string, e: Entry, msg: Record<string, unknown>): void {
  const requestId = String(msg.request_id ?? '')
  const req = (msg.request ?? {}) as {
    subtype?: string
    tool_name?: string
    display_name?: string
    input?: unknown
  }
  if (req.subtype !== 'can_use_tool') {
    // Unknown control request (hooks, mcp, …) — acknowledge so the CLI never
    // deadlocks waiting on us.
    respond(e, requestId, {})
    return
  }
  let pending: ChatPending
  if (req.tool_name === 'AskUserQuestion') {
    const input = (req.input ?? {}) as { questions?: ChatQuestion[] }
    pending = { kind: 'question', requestId, questions: input.questions ?? [] }
  } else {
    pending = {
      kind: 'permission',
      requestId,
      toolName: req.display_name || req.tool_name || 'tool',
      summary: summarizeToolUse(req.tool_name ?? '', req.input)
    }
  }
  e.queue.push({ pending, rawInput: req.input })
  if (e.queue.length === 1) emitPending(id, e)
}

/** The CLI cancelled a pending request (e.g. the turn was interrupted). */
function cancelPending(id: string, e: Entry, msg: Record<string, unknown>): void {
  const requestId = String(msg.request_id ?? '')
  const idx = e.queue.findIndex((p) => p.pending.requestId === requestId)
  if (idx === -1) return
  e.queue.splice(idx, 1)
  emitPending(id, e)
}
