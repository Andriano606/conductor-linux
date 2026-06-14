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
  /**
   * App-owned picker (e.g. /model, /effort): the answer is handled locally
   * instead of being written back to the CLI. See answerChat / openLocalPicker.
   */
  local?: (answer: ChatAnswer) => void
  /** Raw CLI tool name (vs the display name in `pending`) — used to detect ExitPlanMode. */
  rawToolName?: string
}

/** One model the CLI offers (from the initialize response's `models`). */
interface ModelInfo {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
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
  /** True between killing the old proc and respawning it (model/effort change). */
  restarting?: boolean
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
  /** Models the CLI offers (from initialize) — drives the /model, /effort pickers. */
  models?: ModelInfo[]
  /**
   * Names of the local commands currently merged into `commands` (i.e. not
   * shadowed by a CLI command of the same name). dispatchLocalCommand only
   * handles a typed /command when its name is here — otherwise the CLI owns it.
   */
  localCommandNames?: Set<string>
  /**
   * Whether the current turn already produced assistant text. When it didn't
   * (slash commands like /usage answer only via the result event), the result
   * text is rendered as the assistant's reply instead of being dropped.
   */
  turnHadText?: boolean
  /**
   * MCP servers reported by the CLI's init event (re-captured on every respawn) —
   * drives the local /mcp command's status picker. tools = the server's tool names
   * derived from the init `tools` list (mcp__<server>__<tool>).
   */
  mcpServers?: { name: string; status: string; tools: string[] }[]
  /** Last CLI command list passed to setCommands, so it can be re-merged when mcpServers changes. */
  cliCommands?: ChatCommand[]
}

export interface StartOpts {
  id: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Extra user-configured CLI args (settings.claudeArgs), appended raw. */
  args?: string
  /** Session id to resume (persisted on the workspace across app restarts). */
  resume?: string
  /** Runtime overrides (local /model, /effort, /plan), passed as CLI flags. */
  model?: string
  effort?: string
  permissionMode?: string
  /** CLAUDE_CONFIG_DIR for this session (a named profile); unset ⇒ default. */
  configDir?: string
  /**
   * Inline `--mcp-config` JSON (`{"mcpServers":{…}}`) so the project's local-scoped
   * MCP servers load in the worktree session; unset ⇒ none. See projectMcpConfig.
   */
  mcpConfig?: string
}

/** Patch persisted by the local /model, /effort, /plan commands. */
interface ParamsPatch {
  model?: string
  effort?: string
  permissionMode?: string
}

/** The action a local auth command (/login, /logout, /status) requests. */
type AuthAction = 'login' | 'logout' | 'status'

const MAX_ITEMS = 500
const STDERR_TAIL = 2000
const SAVE_DEBOUNCE_MS = 500
// The CLI rejects TUI-only commands in print mode with this exact sentence.
const UNAVAILABLE_RE = /^(\/\S+)\s+isn'?t available in this environment\.?$/i

const entries = new Map<string, Entry>()
let mainWC: WebContents | null = null
/** Persists the session id (or clears it on a failed resume). */
let sessionIdSink: (id: string, sessionId: string | undefined) => void = () => {}
/** Persists a runtime choice (local /model, /effort, /plan commands). */
let paramsSink: (id: string, patch: ParamsPatch) => void = () => {}
/** Handles the auth local commands (/login, /logout, /status) — wired in main. */
let authSink: (sessionId: string, action: AuthAction, useConsole?: boolean) => void = () => {}
/** Handles /mcp authentication (opens the Terminal for the OAuth flow) — wired in main. */
let mcpAuthSink: (sessionId: string, serverName: string) => void = () => {}
/** Handles /mcp → ➕ Add (opens the Terminal preconfigured for `claude mcp add`) — wired in main. */
let mcpAddSink: (sessionId: string) => void = () => {}
/** Directory transcripts are persisted to; null (tests) = memory only. */
let storageDir: string | null = null

export function setChatWindow(wc: WebContents): void {
  mainWC = wc
}

export function onChatSessionId(cb: (id: string, sessionId: string | undefined) => void): void {
  sessionIdSink = cb
}

export function onChatParams(cb: (id: string, patch: ParamsPatch) => void): void {
  paramsSink = cb
}

export function onChatAuth(
  cb: (sessionId: string, action: AuthAction, useConsole?: boolean) => void
): void {
  authSink = cb
}

export function onChatMcpAuth(cb: (sessionId: string, serverName: string) => void): void {
  mcpAuthSink = cb
}

export function onChatMcpAdd(cb: (sessionId: string) => void): void {
  mcpAddSink = cb
}

/** Push an info line into a session's transcript (used by the auth handler). */
export function chatInfo(id: string, text: string): void {
  const e = entries.get(id)
  if (e) info(id, e, text)
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
  // Inject the project's MCP servers (they're keyed to the repo path, not the
  // worktree cwd, so they wouldn't load otherwise). --mcp-config MERGES with the
  // CLI's own sources, so user-scoped servers keep loading; a user can still pass
  // --strict-mcp-config via claudeArgs to override.
  if (opts.mcpConfig) fixed.push('--mcp-config', opts.mcpConfig)
  // Runtime overrides last so a /model or /effort choice wins over any --model
  // the user put in settings.claudeArgs.
  const tail: string[] = []
  if (opts.model) tail.push('--model', opts.model)
  if (opts.effort) tail.push('--effort', opts.effort)
  if (opts.permissionMode) tail.push('--permission-mode', opts.permissionMode)
  const quote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))
  const extra = opts.args?.trim()
  return [
    'exec',
    fixed.map(quote).join(' '),
    extra ?? '',
    tail.map(quote).join(' ')
  ]
    .filter(Boolean)
    .join(' ')
}

// ---- Local (app-owned) slash commands ------------------------------------
//
// The headless CLI doesn't expose interactive TUI commands like /model and
// /effort, so we implement them in-app: they show in the autocomplete (merged
// by setCommands), and a typed `/name [value]` is intercepted here instead of
// being sent to the CLI. To add another, push an entry below — `choices`
// returns the selectable values (empty ⇒ the command is hidden), and `apply`
// performs the effect. A choice value can be passed inline (`/model sonnet`)
// or picked from the option menu that opens when no value is given.

interface LocalChoice {
  value: string
  label: string
  description?: string
  /** Marks the value currently in effect, surfaced in the picker. */
  current?: boolean
}

interface LocalCommand {
  name: string
  description: string
  argumentHint: string
  choices: (e: Entry) => LocalChoice[]
  /** Apply a value chosen from the picker (a deliberate set). */
  apply: (id: string, e: Entry, value: string) => void
  /**
   * Apply a value passed inline (`/cmd value`). Defaults to `apply`; /plan
   * overrides it so re-issuing the same command toggles the mode.
   */
  applyArg?: (id: string, e: Entry, value: string) => void
  /** True when applying restarts the session, so it is refused mid-turn. */
  requiresIdle?: boolean
  /**
   * Action-style command: runs a side effect instead of opening a value picker.
   * When set, the command is offered even with no `choices`, and a bare or
   * argument invocation calls this directly. Used by /login, /logout, /status.
   */
  run?: (id: string, e: Entry, arg?: string) => void
}

const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

function parseModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
    .filter((m) => typeof m.value === 'string' && typeof m.displayName === 'string')
    .map((m) => ({
      value: m.value as string,
      displayName: m.displayName as string,
      description: typeof m.description === 'string' ? m.description : undefined,
      supportsEffort: m.supportsEffort === true,
      supportedEffortLevels: Array.isArray(m.supportedEffortLevels)
        ? (m.supportedEffortLevels as unknown[]).filter((l): l is string => typeof l === 'string')
        : undefined
    }))
}

/**
 * MCP servers from the init event (`mcp_servers: [{name, status}]`), enriched
 * with each server's tool names derived from the init `tools` list — every entry
 * named `mcp__<server>__<tool>` belongs to `<server>`.
 */
function parseMcpServers(
  raw: unknown,
  tools: unknown
): { name: string; status: string; tools: string[] }[] {
  if (!Array.isArray(raw)) return []
  const toolNames = Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : []
  return raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .filter((s) => typeof s.name === 'string' && typeof s.status === 'string')
    .map((s) => {
      const name = s.name as string
      const prefix = `mcp__${name}__`
      return {
        name,
        status: s.status as string,
        tools: toolNames.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))
      }
    })
}

/** The model currently in effect for this session ('default' when unset). */
function currentModel(e: Entry): ModelInfo | undefined {
  const value = e.opts?.model ?? 'default'
  return (e.models ?? []).find((m) => m.value === value) ?? (e.models ?? [])[0]
}

/**
 * Effort levels the current model supports. Empty when models are unknown or
 * the model doesn't support effort — so /effort is offered only when it applies.
 */
function effortLevels(e: Entry): string[] {
  const model = currentModel(e)
  if (!model?.supportsEffort) return []
  return model.supportedEffortLevels?.length ? model.supportedEffortLevels : DEFAULT_EFFORT_LEVELS
}

const LOCAL_COMMANDS: LocalCommand[] = [
  {
    name: 'model',
    description: 'Змінити модель для цієї сесії',
    argumentHint: '[model]',
    requiresIdle: true,
    choices: (e) =>
      (e.models ?? []).map((m) => ({
        value: m.value,
        label: m.displayName,
        description: m.description,
        current: (e.opts?.model ?? 'default') === m.value
      })),
    apply: (id, e, value) => applyParam(id, e, 'model', value)
  },
  {
    name: 'effort',
    description: 'Змінити рівень зусиль (thinking) для цієї сесії',
    argumentHint: '[low|medium|high|xhigh|max]',
    requiresIdle: true,
    choices: (e) =>
      effortLevels(e).map((l) => ({ value: l, label: l, current: e.opts?.effort === l })),
    apply: (id, e, value) => applyParam(id, e, 'effort', value)
  },
  {
    name: 'plan',
    description: 'Режим планування (Claude лише планує, не змінює файли)',
    argumentHint: '[plan|default]',
    // No restart: the mode is switched live via a control request, so it is
    // safe to change mid-turn too. A bare /plan opens a context-aware picker
    // that leads with the actionable (non-current) option: "Увімкнути план мод"
    // in default, "Вимкнути план мод" while planning.
    choices: (e) => {
      const inPlan = (e.opts?.permissionMode ?? 'default') === 'plan'
      const planOpt: LocalChoice = {
        value: 'plan',
        label: inPlan ? '🧭 Режим планування (поточний)' : '🧭 Увімкнути план мод',
        current: inPlan
      }
      const offOpt: LocalChoice = {
        value: 'default',
        label: inPlan ? '✅ Вимкнути план мод' : '✅ Звичайний режим (поточний)',
        current: !inPlan
      }
      // Actionable option first.
      return inPlan ? [offOpt, planOpt] : [planOpt, offOpt]
    },
    apply: (id, e, value) => applyPermissionMode(id, e, value),
    // Inline `/plan plan` / `/plan default`: re-issuing the command that matches
    // the current mode toggles to the other (so entering it twice flips back).
    applyArg: (id, e, value) => {
      const cur = e.opts?.permissionMode ?? 'default'
      const target = value === cur ? (cur === 'plan' ? 'default' : 'plan') : value
      applyPermissionMode(id, e, target)
    }
  },
  {
    // Interactive OAuth — runs in the workspace's Terminal tab (the handler in
    // workspaces.ts opens the shell and switches the UI to it). `/login console`
    // logs into the Anthropic Console (API billing) instead of a subscription.
    name: 'login',
    description: 'Увійти в акаунт Claude (відкриє браузер у вкладці «Термінал»)',
    argumentHint: '[console]',
    choices: () => [],
    run: (id, _e, arg) => authSink(id, 'login', arg?.toLowerCase() === 'console')
  },
  {
    name: 'logout',
    description: 'Вийти з акаунта Claude',
    argumentHint: '',
    choices: () => [],
    run: (id) => authSink(id, 'logout')
  },
  {
    name: 'status',
    description: 'Показати статус автентифікації Claude',
    argumentHint: '',
    choices: () => [],
    run: (id) => authSink(id, 'status')
  },
  {
    // MCP servers reported by the CLI's init event, plus a synthetic "➕ Add"
    // entry that is ALWAYS present — so the command is never hidden (the headless
    // CLI doesn't own /mcp, which would otherwise reject it as TUI-only). Bootstrap
    // matters because each custom CLAUDE_CONFIG_DIR profile starts with no servers.
    // Picking Add opens the Terminal for `claude mcp add`; picking a connected
    // server shows its tools; a needs-auth/failed one opens the Terminal for auth.
    name: 'mcp',
    description: 'MCP-сервери: додати / показати статус / автентифікувати',
    argumentHint: '[add|server]',
    choices: (e) => [
      { value: MCP_ADD, label: '➕ Додати сервер', description: 'Відкрити «Термінал» для claude mcp add' },
      ...(e.mcpServers ?? []).map((s) => ({
        value: s.name,
        label: `${mcpIcon(s.status)} ${s.name}`,
        description: `${mcpStatusText(s.status)} · ${s.tools.length} інстр.`
      }))
    ],
    apply: (id, e, name) => mcpAction(id, e, name)
  }
]

/** Sentinel value of the synthetic "➕ Add server" choice (also typeable as `/mcp add`). */
const MCP_ADD = 'add'

/** Status glyph for an MCP server, matching the TUI's connected/needs-auth/failed states. */
function mcpIcon(status: string): string {
  switch (status) {
    case 'connected':
      return '✓'
    case 'needs-auth':
      return '!'
    case 'failed':
      return '✗'
    default:
      return '⏸' // pending / connecting / unknown
  }
}

/** Human-readable (Ukrainian) status for an MCP server. */
function mcpStatusText(status: string): string {
  switch (status) {
    case 'connected':
      return 'підключено'
    case 'needs-auth':
      return 'потрібна автентифікація'
    case 'failed':
      return 'помилка підключення'
    case 'pending':
    case 'connecting':
      return 'підключення…'
    default:
      return status
  }
}

/**
 * /mcp picked a server: a connected one lists its tools in the transcript; an
 * unauthenticated/failed one delegates to the auth sink (opens the Terminal for
 * the browser OAuth flow — there is no non-interactive `claude mcp auth`).
 */
function mcpAction(id: string, e: Entry, name: string): void {
  if (name === MCP_ADD) {
    mcpAddSink(id)
    return
  }
  const server = (e.mcpServers ?? []).find((s) => s.name === name)
  if (!server) return
  if (server.status === 'connected') {
    const tools = server.tools.length
      ? server.tools.map((t) => `• ${t}`).join('\n')
      : 'інструментів немає'
    info(id, e, `MCP «${name}» (✓ підключено):\n${tools}`)
    return
  }
  mcpAuthSink(id, name)
}

/** Apply a model/effort choice: persist it and restart the session, resuming. */
function applyParam(id: string, e: Entry, key: 'model' | 'effort', value: string): void {
  if (!e.opts) return
  // Picking the value already in effect is a no-op — no needless restart.
  const cur = key === 'model' ? (e.opts.model ?? 'default') : e.opts.effort
  if (cur === value) return
  e.opts = { ...e.opts, [key]: value }
  paramsSink(id, { [key]: value })
  const label =
    key === 'model'
      ? ((e.models ?? []).find((m) => m.value === value)?.displayName ?? value)
      : value
  info(
    id,
    e,
    `${key === 'model' ? 'Модель' : 'Зусилля'}: ${label}. Перезапускаю сесію — розмова збережеться.`
  )
  restartSession(id, e)
}

/**
 * Switch the permission mode live via a set_permission_mode control request —
 * no restart, so the conversation is uninterrupted. The choice is persisted and
 * reapplied as --permission-mode on the next spawn. Shared by /plan and the
 * ExitPlanMode auto-sync; silent so each caller logs its own message.
 */
function setPermissionMode(id: string, e: Entry, mode: string): void {
  if (!e.opts) return
  e.opts = { ...e.opts, permissionMode: mode }
  paramsSink(id, { permissionMode: mode })
  if (e.proc) {
    writeLine(e, {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_permission_mode', mode }
    })
  }
}

/** /plan: switch the permission mode and announce on/off in plain terms. */
function applyPermissionMode(id: string, e: Entry, mode: string): void {
  // Re-selecting the mode already in effect does nothing (and won't spam the
  // transcript if the picker is answered repeatedly).
  if ((e.opts?.permissionMode ?? 'default') === mode) return
  setPermissionMode(id, e, mode)
  info(
    id,
    e,
    mode === 'plan'
      ? '🧭 Увімкнено режим планування — Claude лише планує, без змін.'
      : '✅ Вимкнено режим планування — звичайний режим.'
  )
}

/**
 * Restart the running session with the current opts (e.g. after a model/effort
 * change), resuming the same conversation. The old proc's normal exit handler
 * no-ops because e.proc is cleared first; the respawn happens once it is gone,
 * so the resume never races a still-dying instance holding the session.
 */
function restartSession(id: string, e: Entry): void {
  if (!e.opts) return
  const opts: StartOpts = { ...e.opts, resume: e.sessionId ?? e.opts.resume }
  const old = e.proc
  e.proc = undefined
  const respawn = (): void => {
    e.restarting = false
    spawnProc(id, e, opts)
  }
  if (old) {
    // `restarting` blocks a stray ensureChat() from spawning a second proc in
    // the gap before the old one actually exits.
    e.restarting = true
    old.once('exit', respawn)
    killProcGroup(old)
  } else {
    respawn()
  }
}

/**
 * Apply a config profile (CLAUDE_CONFIG_DIR) to a running session: the var only
 * takes effect at process start, so restart resuming the conversation. Persistence
 * of the chosen profile id is done by the caller (setSessionProfile in workspaces).
 * No-op for an idle/unstarted session — its next spawn picks the dir up from opts.
 */
export function setChatConfigDir(id: string, configDir: string | undefined, label?: string): void {
  const e = entries.get(id)
  if (!e || !e.opts || e.opts.configDir === configDir) return
  e.opts = { ...e.opts, configDir }
  const name = label ?? (configDir ? configDir : 'стандартний ~/.claude')
  info(id, e, `Профіль Claude: ${name}. Перезапускаю сесію — розмова збережеться.`)
  restartSession(id, e)
}

/**
 * Intercept a typed `/command` that the app owns (in e.localCommandNames).
 * Returns true when handled (so it is NOT forwarded to the CLI). With a value
 * it applies directly; without one it opens the option picker. A CLI command of
 * the same name is never in localCommandNames, so it falls through to the CLI.
 */
function dispatchLocalCommand(id: string, e: Entry, text: string): boolean {
  const m = text.match(/^\/([\w-]+)(?:\s+([\s\S]+))?$/)
  if (!m) return false
  const cmd = LOCAL_COMMANDS.find((c) => c.name === m[1])
  if (!cmd || !e.localCommandNames?.has(cmd.name)) return false
  // Only restart-based commands need an idle session; live ones (/plan) don't.
  if (cmd.requiresIdle && e.busy) {
    info(id, e, 'Зачекай, доки Claude завершить поточну відповідь, перш ніж змінювати налаштування.')
    return true
  }
  // Action-style command (/login, /logout, /status): run the side effect.
  if (cmd.run) {
    cmd.run(id, e, m[2]?.trim())
    return true
  }
  const choices = cmd.choices(e)
  const arg = m[2]?.trim()
  if (arg) {
    const choice = choices.find((c) => c.value.toLowerCase() === arg.toLowerCase())
    if (!choice) {
      info(id, e, `Невідоме значення «${arg}». Доступні: ${choices.map((c) => c.value).join(', ')}`)
      return true
    }
    ;(cmd.applyArg ?? cmd.apply)(id, e, choice.value)
  } else {
    openLocalPicker(id, e, cmd, choices)
  }
  return true
}

/** Open an in-app option picker for a local command (reuses the question UI). */
function openLocalPicker(id: string, e: Entry, cmd: LocalCommand, choices: LocalChoice[]): void {
  const question: ChatQuestion = {
    question: cmd.description,
    header: `/${cmd.name}`,
    options: choices.map((c) => ({
      label: c.label,
      description: [c.description, c.current ? 'поточна' : null].filter(Boolean).join(' · ') || undefined
    })),
    multiSelect: false
  }
  const pending: ChatPending = { kind: 'question', requestId: randomUUID(), questions: [question] }
  e.queue.push({
    pending,
    rawInput: null,
    local: (answer) => {
      if (answer.kind !== 'question') return
      const label = answer.answers[question.question]
      const choice = choices.find((c) => c.label === label)
      if (choice) cmd.apply(id, e, choice.value)
    }
  })
  emitPending(id, e)
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
  if (!e || e.proc || e.restarting || !e.opts) return
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
  // A session attached to a config profile overrides CLAUDE_CONFIG_DIR so its
  // claude runs under that profile's settings/account; otherwise inherit.
  const env = opts.configDir ? { ...opts.env, CLAUDE_CONFIG_DIR: opts.configDir } : opts.env
  const proc = spawn('/bin/bash', ['-lc', buildCommand(opts)], {
    cwd: opts.cwd,
    env,
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
  // A registered local command (/model, /effort, …) is handled in-app and not
  // forwarded to the CLI; anything else is a normal user message.
  if (dispatchLocalCommand(id, e, text)) return
  pushItem(id, e, { id: randomUUID(), role: 'user', text, ts: Date.now() })
  setBusy(id, e, true)
  e.turnHadText = false
  writeLine(e, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  })
}

/** Answer the currently pending question/permission request. */
export function answerChat(id: string, answer: ChatAnswer): void {
  const e = entries.get(id)
  if (!e) return
  const idx = e.queue.findIndex((p) => p.pending.requestId === answer.requestId)
  if (idx === -1) return
  const [{ pending, rawInput, local, rawToolName }] = e.queue.splice(idx, 1)

  // App-owned picker (/model, /effort): apply the choice locally, nothing goes
  // back to the CLI.
  if (local) {
    local(answer)
    emitPending(id, e)
    return
  }

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
      // Approving the plan exits plan mode on the CLI side — keep our tracked
      // mode (picker "current" + the persisted respawn flag) in sync so we
      // don't re-enter plan on the next restart.
      if (rawToolName === 'ExitPlanMode' && (e.opts?.permissionMode ?? 'default') !== 'default') {
        setPermissionMode(id, e, 'default')
        info(id, e, 'Вихід із режиму планування — повернувся звичайний режим.')
      }
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
        // Capture models here too so the local /model, /effort pickers work even
        // on a CLI old enough to lack the initialize handshake.
        if (!e.models && Array.isArray(msg.models)) e.models = parseModels(msg.models)
        // MCP servers + their tool names — drives the local /mcp picker. Re-read on
        // every (re)spawn so status (e.g. needs-auth → connected after auth) stays fresh.
        if (Array.isArray(msg.mcp_servers)) {
          e.mcpServers = parseMcpServers(msg.mcp_servers, msg.tools)
          // Re-merge the command list so /mcp appears/updates even if this init
          // event arrived AFTER the command list was first built (or on a respawn).
          if (e.cliCommands) setCommands(id, e, e.cliCommands)
        }
        // Bare fallback for the command list — initialize (with descriptions)
        // normally beats this; don't let names-only overwrite it.
        if (!e.commands && Array.isArray(msg.slash_commands)) {
          const names = (msg.slash_commands as unknown[]).filter(
            (c): c is string => typeof c === 'string'
          )
          const cli = [...new Set(names)].map((name) => ({ name }))
          setCommands(id, e, cli)
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
 * The initialize handshake response: the CLI's command list (with descriptions
 * and argument hints) plus the available models. The CLI's own commands are
 * shown as-is; local commands (/model, /effort) are merged in by setCommands.
 * detectCommandDrift then reports anything that changed.
 */
function handleInitialize(id: string, e: Entry, r: Record<string, unknown>): void {
  if (Array.isArray(r.models)) e.models = parseModels(r.models)
  const parsed: ChatCommand[] = Array.isArray(r.commands)
    ? (r.commands as Record<string, unknown>[])
        .filter((c) => typeof c.name === 'string' && c.name)
        .map((c) => ({
          name: c.name as string,
          description: typeof c.description === 'string' ? c.description : undefined,
          argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : undefined
        }))
    : []
  // Collapse only EXACT duplicates (same name AND description AND hint). The CLI
  // can list the very same command twice when scopes overlap — but two distinct
  // commands that merely share a name (e.g. a project's two `/commit` variants)
  // are kept, so neither is hidden.
  const seen = new Set<string>()
  const cliCommands = parsed.filter((c) => {
    const key = `${c.name} ${c.description ?? ''} ${c.argumentHint ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  detectCommandDrift(id, e, cliCommands)
  if (cliCommands.length) setCommands(id, e, cliCommands)
  // Enforce the persisted permission mode now that the session is ready — a
  // --resume doesn't always honor the --permission-mode flag, so re-assert it
  // here to guarantee the CLI matches our tracked state across restart/restore.
  enforcePermissionMode(e)
}

/**
 * Re-assert the session's permission mode via a control request. Called after
 * the handshake on every (re)start so a persisted /plan choice survives app
 * restarts and archive/restore even if --permission-mode is ignored on resume.
 */
function enforcePermissionMode(e: Entry): void {
  const mode = e.opts?.permissionMode
  if (e.proc && mode) {
    writeLine(e, {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'set_permission_mode', mode }
    })
  }
}

/**
 * Publish the command list shown in the input autocomplete: the CLI's own
 * commands plus every local command whose name the CLI does NOT already provide
 * (native wins) and that currently has choices to offer. The set of locally
 * owned names is remembered so dispatchLocalCommand only intercepts those.
 */
function setCommands(id: string, e: Entry, cliCommands: ChatCommand[]): void {
  e.cliCommands = cliCommands
  const cliNames = new Set(cliCommands.map((c) => c.name))
  const locals = LOCAL_COMMANDS.filter(
    (lc) => !cliNames.has(lc.name) && (!!lc.run || lc.choices(e).length > 0)
  )
  e.localCommandNames = new Set(locals.map((lc) => lc.name))
  e.commands = [
    ...cliCommands,
    ...locals.map((lc) => ({
      name: lc.name,
      description: lc.description,
      argumentHint: lc.argumentHint
    }))
  ]
  emit(id, e, { type: 'commands', commands: e.commands })
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
  e.queue.push({ pending, rawInput: req.input, rawToolName: req.tool_name })
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
