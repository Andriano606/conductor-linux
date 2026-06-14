import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEventPayload, ChatItem, ChatPending } from '../../src/shared/types'

// child_process.spawn is replaced with a driveable fake (same hoisting pattern
// as the node-pty mock in ptyManager.test.ts).
const holder = vi.hoisted(() => ({ spawn: (..._args: unknown[]): unknown => undefined }))
vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => holder.spawn(...args) }))

import {
  answerChat,
  attachChat,
  deleteChatHistory,
  ensureChat,
  interruptChat,
  killAllChats,
  killChat,
  onChatMcpAdd,
  onChatMcpAuth,
  onChatParams,
  onChatSessionId,
  sendChatMessage,
  setChatStorageDir,
  setChatWindow,
  startChat,
  stopChatProc,
  summarizeToolUse
} from '../../src/main/claudeChat'

class FakeProc extends EventEmitter {
  pid: number
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { write: vi.fn() }
  kill = vi.fn()
  constructor(pid: number) {
    super()
    this.pid = pid
  }
  /** Emit one or more NDJSON lines on stdout. */
  line(...objs: unknown[]): void {
    this.stdout.emit('data', Buffer.from(objs.map((o) => JSON.stringify(o) + '\n').join('')))
  }
}

let spawned: FakeProc[] = []
let spawnArgs: unknown[][] = []
let send: ReturnType<typeof vi.fn>
let killSpy: ReturnType<typeof vi.spyOn>

const last = (): FakeProc => spawned[spawned.length - 1]
const baseOpts = { id: 'w1', cwd: '/wt', env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv }

/** All chat:event payloads sent to the renderer (most recent state wins). */
const chatEvents = (): ChatEventPayload[] =>
  send.mock.calls.filter((c) => c[0] === 'chat:event').map((c) => c[1] as ChatEventPayload)

const lastPending = (): ChatPending | null | undefined => {
  const evs = chatEvents().filter((p) => p.ev.type === 'pending')
  const ev = evs[evs.length - 1]?.ev
  return ev && ev.type === 'pending' ? ev.pending : undefined
}

/** Last line written to stdin, parsed. */
const lastWritten = (): Record<string, unknown> => {
  const calls = last().stdin.write.mock.calls
  return JSON.parse(calls[calls.length - 1][0] as string)
}

beforeEach(() => {
  let pid = 100
  spawned = []
  spawnArgs = []
  holder.spawn = (...args: unknown[]) => {
    spawnArgs.push(args)
    const p = new FakeProc(pid++)
    spawned.push(p)
    return p
  }
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)
  setChatStorageDir(null) // memory-only by default; persistence tests opt in
  killAllChats()
  send = vi.fn()
  setChatWindow({ send, isDestroyed: () => false } as never)
  onChatSessionId(() => {})
  onChatParams(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('startChat', () => {
  it('spawns claude in stream-json print mode with the stdio permission tool', () => {
    startChat({ ...baseOpts, args: '--dangerously-skip-permissions' })
    expect(spawnArgs).toHaveLength(1)
    const [cmd, argv, opts] = spawnArgs[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe('/bin/bash')
    expect(argv[0]).toBe('-lc')
    expect(argv[1]).toContain('exec claude -p')
    expect(argv[1]).toContain('--input-format stream-json')
    expect(argv[1]).toContain('--output-format stream-json')
    expect(argv[1]).toContain('--permission-prompt-tool stdio')
    expect(argv[1]).toContain('--include-partial-messages')
    expect(argv[1]).toContain('--dangerously-skip-permissions')
    expect(opts).toMatchObject({ cwd: '/wt', detached: true })
  })

  it('is idempotent while the process lives', () => {
    startChat(baseOpts)
    startChat(baseOpts)
    expect(spawned).toHaveLength(1)
  })

  it('passes --resume with the stored session id', () => {
    startChat({ ...baseOpts, resume: 'sess-1' })
    expect((spawnArgs[0] as [string, string[]])[1][1]).toContain('--resume sess-1')
  })

  it('exports CLAUDE_CONFIG_DIR into the spawn env only when a configDir is set', () => {
    startChat({ ...baseOpts, configDir: '/home/u/.claude-work' })
    const opts = (spawnArgs[0] as [string, string[], { env: NodeJS.ProcessEnv }])[2]
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-work')
    // Inherited vars are preserved alongside the override.
    expect(opts.env.PATH).toBe('/usr/bin')
  })

  it('does not set CLAUDE_CONFIG_DIR when no configDir is given', () => {
    startChat(baseOpts)
    const opts = (spawnArgs[0] as [string, string[], { env: NodeJS.ProcessEnv }])[2]
    expect(opts.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('sending messages', () => {
  it('writes an NDJSON user message, logs a user item and flips busy on', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'зроби тест')
    expect(lastWritten()).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'зроби тест' }] }
    })
    const snap = attachChat('w1')
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0]).toMatchObject({ role: 'user', text: 'зроби тест' })
    expect(snap.busy).toBe(true)
    // The legacy busy channel still fires for the sidebar/toolbar indicator.
    expect(send).toHaveBeenCalledWith('claude:busy', { id: 'w1', busy: true })
  })

  it('the result event flips busy back off', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'hi')
    last().line({ type: 'result', subtype: 'success', is_error: false })
    expect(attachChat('w1').busy).toBe(false)
    expect(send).toHaveBeenCalledWith('claude:busy', { id: 'w1', busy: false })
  })
})

describe('assistant output', () => {
  it('streams partial text deltas into one live item, finalized by the full message', () => {
    startChat(baseOpts)
    last().line(
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'При' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'віт' } } }
    )
    let items = attachChat('w1').items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'Привіт' })

    last().line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Привіт!' }] }
    })
    items = attachChat('w1').items
    expect(items).toHaveLength(1) // finalized in place, no duplicate
    expect(items[0].text).toBe('Привіт!')
  })

  it('renders assistant text even without partial deltas', () => {
    startChat(baseOpts)
    last().line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
    })
    expect(attachChat('w1').items[0]).toMatchObject({ role: 'assistant', text: 'OK' })
  })

  it('handles NDJSON split across stdout chunks', () => {
    startChat(baseOpts)
    const line =
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'chunked' }] }
      }) + '\n'
    last().stdout.emit('data', Buffer.from(line.slice(0, 25)))
    last().stdout.emit('data', Buffer.from(line.slice(25)))
    expect(attachChat('w1').items[0].text).toBe('chunked')
  })
})

describe('tool calls', () => {
  it('logs a running tool item and completes it when the tool_result arrives', () => {
    startChat(baseOpts)
    last().line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }]
      }
    })
    let item = attachChat('w1').items[0]
    expect(item).toMatchObject({ role: 'tool', toolName: 'Bash', text: 'npm test', done: false })

    last().line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }
    })
    item = attachChat('w1').items[0]
    expect(item).toMatchObject({ done: true, isError: false })
  })

  it('marks an errored tool_result', () => {
    startChat(baseOpts)
    last().line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'x' } }]
      }
    })
    last().line({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'boom', is_error: true }]
      }
    })
    expect(attachChat('w1').items[0]).toMatchObject({ done: true, isError: true })
  })

  it('does not log AskUserQuestion as a tool item', () => {
    startChat(baseOpts)
    last().line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [] } }]
      }
    })
    expect(attachChat('w1').items).toHaveLength(0)
  })
})

const QUESTION_REQUEST = {
  type: 'control_request',
  request_id: 'req-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'Який колір?',
          header: 'Колір',
          options: [
            { label: 'Червоний', description: 'червоний' },
            { label: 'Синій', description: 'синій' }
          ],
          multiSelect: false
        }
      ]
    }
  }
}

describe('AskUserQuestion flow', () => {
  it('surfaces the questions as a pending request with options', () => {
    startChat(baseOpts)
    last().line(QUESTION_REQUEST)
    const pending = attachChat('w1').pending
    expect(pending).toMatchObject({ kind: 'question', requestId: 'req-1' })
    if (pending?.kind !== 'question') throw new Error('expected question')
    expect(pending.questions[0].options.map((o) => o.label)).toEqual(['Червоний', 'Синій'])
    expect(lastPending()).toMatchObject({ kind: 'question' })
  })

  it('answers with the documented updatedInput shape (answers keyed by question text)', () => {
    startChat(baseOpts)
    last().line(QUESTION_REQUEST)
    answerChat('w1', { kind: 'question', requestId: 'req-1', answers: { 'Який колір?': 'Синій' } })
    expect(lastWritten()).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: {
            questions: (QUESTION_REQUEST.request.input as { questions: unknown[] }).questions,
            answers: { 'Який колір?': 'Синій' }
          }
        }
      }
    })
    // Pending is cleared and the choice is logged as a user item, flagged as
    // an option answer so it stays out of the input's arrow-key history.
    expect(attachChat('w1').pending).toBeNull()
    const items = attachChat('w1').items
    expect(items[items.length - 1]).toMatchObject({
      role: 'user',
      text: 'Колір: Синій',
      answer: true
    })
  })

  it('queues a second pending request until the first is answered', () => {
    startChat(baseOpts)
    last().line(QUESTION_REQUEST)
    last().line({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } }
    })
    expect(attachChat('w1').pending).toMatchObject({ requestId: 'req-1' })
    answerChat('w1', { kind: 'question', requestId: 'req-1', answers: { 'Який колір?': 'Червоний' } })
    expect(attachChat('w1').pending).toMatchObject({ kind: 'permission', requestId: 'req-2' })
  })

  it('drops a pending request the CLI cancels (interrupt)', () => {
    startChat(baseOpts)
    last().line(QUESTION_REQUEST)
    last().line({ type: 'control_cancel_request', request_id: 'req-1' })
    expect(attachChat('w1').pending).toBeNull()
  })
})

describe('permission flow', () => {
  const PERMISSION_REQUEST = {
    type: 'control_request',
    request_id: 'req-9',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      display_name: 'Bash',
      input: { command: 'rm -rf /tmp/x' }
    }
  }

  it('surfaces a permission pending with a command summary', () => {
    startChat(baseOpts)
    last().line(PERMISSION_REQUEST)
    expect(attachChat('w1').pending).toMatchObject({
      kind: 'permission',
      requestId: 'req-9',
      toolName: 'Bash',
      summary: 'rm -rf /tmp/x'
    })
  })

  it('allow passes the original input through', () => {
    startChat(baseOpts)
    last().line(PERMISSION_REQUEST)
    answerChat('w1', { kind: 'permission', requestId: 'req-9', allow: true })
    expect(lastWritten()).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-9',
        response: { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/x' } }
      }
    })
    expect(attachChat('w1').pending).toBeNull()
  })

  it('deny sends the user message (or a default) back to Claude', () => {
    startChat(baseOpts)
    last().line(PERMISSION_REQUEST)
    answerChat('w1', { kind: 'permission', requestId: 'req-9', allow: false, message: 'krashe arhivuy' })
    expect(lastWritten()).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-9',
        response: { behavior: 'deny', message: 'krashe arhivuy' }
      }
    })
  })

  it('acknowledges unknown control requests so the CLI never deadlocks', () => {
    startChat(baseOpts)
    last().line({ type: 'control_request', request_id: 'req-x', request: { subtype: 'whatever' } })
    expect(lastWritten()).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-x', response: {} }
    })
    expect(attachChat('w1').pending).toBeNull()
  })
})

describe('interrupt', () => {
  it('writes an interrupt control request', () => {
    startChat(baseOpts)
    interruptChat('w1')
    const written = lastWritten()
    expect(written.type).toBe('control_request')
    expect((written.request as { subtype: string }).subtype).toBe('interrupt')
  })
})

/** Parse the first line written to stdin (the initialize handshake). */
const initHandshake = (): Record<string, unknown> =>
  JSON.parse(last().stdin.write.mock.calls[0][0] as string)

/** Feed a successful initialize response with the given payload. */
const answerInitialize = (payload: Record<string, unknown>): void => {
  last().line({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: (initHandshake() as { request_id: string }).request_id,
      response: payload
    }
  })
}

/** App-owned commands merged into the list — filtered out when asserting CLI-only behavior. */
const LOCAL_NAMES = new Set(['model', 'effort', 'plan', 'login', 'logout', 'status', 'mcp'])
const cliOnly = (cmds?: { name: string }[]): { name: string }[] =>
  (cmds ?? []).filter((c) => !LOCAL_NAMES.has(c.name))

describe('slash commands', () => {
  it('sends the initialize handshake at spawn', () => {
    startChat(baseOpts)
    const req = initHandshake()
    expect(req.type).toBe('control_request')
    expect((req.request as { subtype: string }).subtype).toBe('initialize')
  })

  it('keeps the CLI commands (with descriptions) and appends local /model, /effort, /plan', () => {
    startChat(baseOpts)
    answerInitialize({
      commands: [
        { name: 'clear', description: 'Clear conversation history', argumentHint: '[name]' },
        { name: 'compact', description: 'Summarize the conversation' }
      ],
      models: [
        { value: 'default', displayName: 'Default', supportsEffort: true },
        { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true }
      ]
    })
    const cmds = attachChat('w1').commands ?? []
    // CLI commands first (descriptions intact), then the local ones.
    expect(cmds.map((c) => c.name)).toEqual([
      'clear',
      'compact',
      'model',
      'effort',
      'plan',
      'login',
      'logout',
      'status',
      'mcp' // always offered (carries the ➕ Add option even with no servers)
    ])
    expect(cmds[0]).toMatchObject({ description: 'Clear conversation history', argumentHint: '[name]' })
    expect(cmds[2]).toMatchObject({ name: 'model', argumentHint: '[model]' })
    expect(chatEvents().some((p) => p.ev.type === 'commands')).toBe(true)
  })

  it('hides /effort when no model supports it; /model needs models, /plan is always offered', () => {
    startChat(baseOpts)
    answerInitialize({
      commands: [{ name: 'clear' }],
      models: [{ value: 'haiku', displayName: 'Haiku' }] // no supportsEffort
    })
    // /effort hidden (no model supports it), /model shown (a model exists), /plan
    // and the auth action commands always offered.
    expect((attachChat('w1').commands ?? []).map((c) => c.name)).toEqual([
      'clear',
      'model',
      'plan',
      'login',
      'logout',
      'status',
      'mcp'
    ])
  })

  it('a CLI command of the same name shadows the local one (native wins)', () => {
    startChat(baseOpts)
    answerInitialize({
      commands: [{ name: 'model', description: 'native model command' }],
      models: [{ value: 'default', displayName: 'Default', supportsEffort: true }]
    })
    const cmds = attachChat('w1').commands ?? []
    // Only the CLI's /model (one entry), and a typed /model goes to the CLI.
    expect(cmds.filter((c) => c.name === 'model')).toHaveLength(1)
    expect(cmds[0].description).toBe('native model command')
    sendChatMessage('w1', '/model')
    expect(lastWritten()).toMatchObject({ type: 'user', message: { content: [{ text: '/model' }] } })
  })

  it('drops exact duplicates but keeps distinct commands that share a name', () => {
    startChat(baseOpts)
    answerInitialize({
      commands: [
        { name: 'compact', description: 'Summarize the conversation' },
        // Two genuinely different /commit variants (e.g. project + plugin) —
        // both must survive so neither is hidden.
        { name: 'commit', description: 'Follow project conventions' },
        { name: 'commit', description: 'Concise message' },
        // An exact repeat of the first — this one is the real duplicate.
        { name: 'compact', description: 'Summarize the conversation' }
      ],
      models: []
    })
    expect(cliOnly(attachChat('w1').commands)).toEqual([
      { name: 'compact', description: 'Summarize the conversation', argumentHint: undefined },
      { name: 'commit', description: 'Follow project conventions', argumentHint: undefined },
      { name: 'commit', description: 'Concise message', argumentHint: undefined }
    ])
  })

  it('falls back to the init event names when initialize is unsupported', () => {
    startChat(baseOpts)
    last().line({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      slash_commands: ['compact', 'clear', 'review']
    })
    expect(cliOnly(attachChat('w1').commands)).toEqual([
      { name: 'compact' },
      { name: 'clear' },
      { name: 'review' }
    ])
  })

  it('dedupes the init-event fallback names too', () => {
    startChat(baseOpts)
    last().line({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      slash_commands: ['compact', 'clear', 'compact', 'clear']
    })
    expect(cliOnly(attachChat('w1').commands)).toEqual([{ name: 'compact' }, { name: 'clear' }])
  })

  it('an init with a changed session id (e.g. /clear) drops the transcript', () => {
    startChat(baseOpts)
    last().line({ type: 'system', subtype: 'init', session_id: 's1' })
    sendChatMessage('w1', 'hi')
    expect(attachChat('w1').items.length).toBeGreaterThan(0)
    last().line({ type: 'system', subtype: 'init', session_id: 's2' })
    const items = attachChat('w1').items
    expect(items.filter((it) => it.role === 'user')).toHaveLength(0)
    expect(items[items.length - 1].role).toBe('info')
    expect(chatEvents().some((p) => p.ev.type === 'clear')).toBe(true)
  })

  it('renders a command answered only via the result event (e.g. /usage)', () => {
    startChat(baseOpts)
    sendChatMessage('w1', '/usage')
    last().line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Current session: 31% used'
    })
    const items = attachChat('w1').items
    expect(items[items.length - 1]).toMatchObject({
      role: 'assistant',
      text: 'Current session: 31% used'
    })
  })

  it('does not duplicate the reply when assistant text already streamed', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'hi')
    last().line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Привіт!' }] }
    })
    last().line({ type: 'result', subtype: 'success', is_error: false, result: 'Привіт!' })
    const items = attachChat('w1').items.filter((it) => it.role === 'assistant')
    expect(items).toHaveLength(1)
  })

  it('forwards a non-local /command to the CLI as a plain message', () => {
    startChat(baseOpts)
    answerInitialize({ commands: [{ name: 'clear' }], models: [] })
    sendChatMessage('w1', '/clear')
    expect(lastWritten()).toMatchObject({
      type: 'user',
      message: { content: [{ type: 'text', text: '/clear' }] }
    })
    expect(attachChat('w1').pending).toBeNull()
  })

  it('reports a TUI-only command the CLI rejects as unavailable, not as a reply', () => {
    startChat(baseOpts)
    sendChatMessage('w1', '/config')
    last().line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: "/config isn't available in this environment."
    })
    const items = attachChat('w1').items
    const lastItem = items[items.length - 1]
    expect(lastItem.role).toBe('info')
    expect(lastItem.text).toContain('/config')
    expect(lastItem.text).toContain('недоступна')
    // It must not be rendered as an assistant reply.
    expect(items.some((it) => it.role === 'assistant')).toBe(false)
  })

  it('surfaces control_response errors as info items', () => {
    startChat(baseOpts)
    last().line({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'x', error: 'Invalid model name' }
    })
    const items = attachChat('w1').items
    expect(items[items.length - 1].role).toBe('info')
    expect(items[items.length - 1].text).toContain('Invalid model name')
  })

  it('surfaces a failed /compact as an info item', () => {
    startChat(baseOpts)
    last().line({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'Not enough messages to compact.'
    })
    const items = attachChat('w1').items
    expect(items[items.length - 1].role).toBe('info')
    expect(items[items.length - 1].text).toContain('Not enough messages')
  })
})

describe('local commands (/model, /effort)', () => {
  const MODELS = [
    { value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'sonnet', displayName: 'Sonnet', supportsEffort: true }
  ]
  /** Spawn, report a session id, and advertise commands + models. */
  const ready = (): void => {
    startChat(baseOpts)
    last().line({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    answerInitialize({ commands: [{ name: 'clear' }], models: MODELS })
  }
  /** argv of the most recently spawned claude process. */
  const lastArgv = (): string => (spawnArgs[spawnArgs.length - 1] as [string, string[]])[1][1]

  it('buildCommand passes --model/--effort, after user args so a runtime choice wins', () => {
    startChat({ ...baseOpts, args: '--model opus', model: 'sonnet', effort: 'high' })
    const argv = lastArgv()
    expect(argv).toContain('--effort high')
    // Both --model flags are present; ours (sonnet) comes last and therefore wins.
    expect(argv.lastIndexOf('--model sonnet')).toBeGreaterThan(argv.indexOf('--model opus'))
  })

  it('an inline value applies directly: persists and restarts resuming the session', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', '/model sonnet')
    // Not forwarded to the CLI as a user message, and persisted.
    expect(sink).toHaveBeenCalledWith('w1', { model: 'sonnet' })
    expect(attachChat('w1').items.some((it) => it.role === 'user')).toBe(false)
    // The restart happens once the old proc is gone, carrying the new flag + resume.
    const before = spawned.length
    last().emit('exit', 0)
    expect(spawned.length).toBe(before + 1)
    expect(lastArgv()).toContain('--model sonnet')
    expect(lastArgv()).toContain('--resume sess-1')
  })

  it('/effort offers the current model levels and applies the chosen one', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', '/effort')
    const pending = attachChat('w1').pending
    expect(pending?.kind).toBe('question')
    if (pending?.kind !== 'question') throw new Error('expected question')
    expect(pending.questions[0].options.map((o) => o.label)).toEqual(['low', 'high'])
    answerChat('w1', {
      kind: 'question',
      requestId: pending.requestId,
      answers: { [pending.questions[0].question]: 'high' }
    })
    expect(sink).toHaveBeenCalledWith('w1', { effort: 'high' })
    expect(attachChat('w1').pending).toBeNull()
  })

  it('/model with no value opens a picker listing every model', () => {
    ready()
    sendChatMessage('w1', '/model')
    const pending = attachChat('w1').pending
    if (pending?.kind !== 'question') throw new Error('expected question')
    expect(pending.questions[0].options.map((o) => o.label)).toEqual(['Default', 'Sonnet'])
  })

  it('rejects an unknown value without restarting', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    const before = spawned.length
    sendChatMessage('w1', '/model gpt')
    expect(sink).not.toHaveBeenCalled()
    last().emit('exit', 0) // even if the proc died, nothing was queued to respawn
    expect(spawned.length).toBe(before)
    expect(attachChat('w1').items.at(-1)?.text).toContain('Невідоме значення')
  })

  it('refuses to change params mid-turn (while busy)', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', 'hi') // turn in flight ⇒ busy
    sendChatMessage('w1', '/model sonnet')
    expect(sink).not.toHaveBeenCalled()
    expect(attachChat('w1').items.at(-1)?.text).toContain('Зачекай')
  })

  it('reapplies a persisted model/effort on the next spawn', () => {
    startChat({ ...baseOpts, model: 'sonnet', effort: 'high' })
    expect(lastArgv()).toContain('--model sonnet')
    expect(lastArgv()).toContain('--effort high')
  })

  it('does not double-spawn if a message arrives during the restart window', () => {
    ready()
    sendChatMessage('w1', '/model sonnet') // kills the old proc, awaits its exit
    const before = spawned.length
    sendChatMessage('w1', 'hi') // ensureChat must NOT spawn a second proc yet
    expect(spawned.length).toBe(before)
    last().emit('exit', 0) // old proc gone ⇒ exactly one respawn
    expect(spawned.length).toBe(before + 1)
  })

  it('/plan is always offered, even without models', () => {
    startChat(baseOpts)
    answerInitialize({ commands: [{ name: 'clear' }], models: [] })
    expect((attachChat('w1').commands ?? []).map((c) => c.name)).toContain('plan')
  })

  it('/plan switches mode live via a control request — persisted, no restart', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    const before = spawned.length
    sendChatMessage('w1', '/plan plan')
    expect(sink).toHaveBeenCalledWith('w1', { permissionMode: 'plan' })
    // A set_permission_mode control request is sent; the session is NOT restarted.
    expect(lastWritten()).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_permission_mode', mode: 'plan' }
    })
    expect(spawned.length).toBe(before)
    expect(attachChat('w1').items.at(-1)?.role).toBe('info')
  })

  it('bare /plan leads with the actionable option for the current mode', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready() // starts in default
    sendChatMessage('w1', '/plan')
    let pending = attachChat('w1').pending
    if (pending?.kind !== 'question') throw new Error('expected picker')
    let options = pending.questions[0].options
    expect(options).toHaveLength(2)
    // In default the first (action) option turns planning ON; the second is current.
    expect(options[0].label).toContain('Увімкнути план мод')
    expect(options[1].label).toContain('Звичайний режим')
    answerChat('w1', {
      kind: 'question',
      requestId: pending.requestId,
      answers: { [pending.questions[0].question]: options[0].label }
    })
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'plan' })
    expect(attachChat('w1').items.at(-1)?.text).toContain('Увімкнено режим планування')

    // Now in plan, the first (action) option is "Вимкнути план мод".
    sendChatMessage('w1', '/plan')
    pending = attachChat('w1').pending
    if (pending?.kind !== 'question') throw new Error('expected picker')
    options = pending.questions[0].options
    expect(options[0].label).toContain('Вимкнути план мод')
    // Picking it turns planning off.
    answerChat('w1', {
      kind: 'question',
      requestId: pending.requestId,
      answers: { [pending.questions[0].question]: options[0].label }
    })
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'default' })
    expect(attachChat('w1').items.at(-1)?.text).toContain('Вимкнено режим планування')
  })

  it('picking the current mode in the picker is a no-op (no spam)', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready() // already in default
    sendChatMessage('w1', '/plan')
    const pending = attachChat('w1').pending
    if (pending?.kind !== 'question') throw new Error('expected picker')
    const offLabel = pending.questions[0].options[1].label // the current (default) option
    const writes = last().stdin.write.mock.calls.length
    answerChat('w1', {
      kind: 'question',
      requestId: pending.requestId,
      answers: { [pending.questions[0].question]: offLabel }
    })
    expect(sink).not.toHaveBeenCalled()
    expect(attachChat('w1').items.some((it) => it.text.includes('Вимкнено'))).toBe(false)
    expect(last().stdin.write.mock.calls.length).toBe(writes)
  })

  it('inline /plan plan toggles: re-issuing the same command flips the mode', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready() // default
    sendChatMessage('w1', '/plan plan') // default → plan
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'plan' })
    expect(attachChat('w1').items.at(-1)?.text).toContain('Увімкнено режим планування')
    sendChatMessage('w1', '/plan plan') // same command again → toggles back to default
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'default' })
    expect(attachChat('w1').items.at(-1)?.text).toContain('Вимкнено режим планування')
    sendChatMessage('w1', '/plan plan') // → plan again
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'plan' })
  })

  it('allows /plan mid-turn (it does not restart), unlike /model', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', 'hi') // turn in flight ⇒ busy
    sendChatMessage('w1', '/plan plan')
    expect(sink).toHaveBeenCalledWith('w1', { permissionMode: 'plan' })
  })

  it('re-asserts a persisted permission mode after the handshake (restart/restore)', () => {
    // Simulates a relaunch: startChat is given the persisted mode, and once the
    // session is ready we force it via set_permission_mode (so a --resume that
    // ignores --permission-mode still lands in the right mode).
    startChat({ ...baseOpts, permissionMode: 'plan' })
    expect(lastArgv()).toContain('--permission-mode plan') // also passed as a flag
    last().line({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    answerInitialize({ commands: [{ name: 'clear' }], models: MODELS })
    expect(lastWritten()).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_permission_mode', mode: 'plan' }
    })
  })

  it('does not force a mode when none was persisted (fresh workspace)', () => {
    startChat(baseOpts) // no permissionMode
    last().line({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    answerInitialize({ commands: [{ name: 'clear' }], models: MODELS })
    const writes = last().stdin.write.mock.calls.map((c) => JSON.parse(c[0] as string))
    expect(writes.some((w) => w.request?.subtype === 'set_permission_mode')).toBe(false)
  })

  it('buildCommand passes --permission-mode, reapplied on the next spawn', () => {
    startChat({ ...baseOpts, permissionMode: 'plan' })
    expect(lastArgv()).toContain('--permission-mode plan')
  })

  /** Emit a permission request for the given tool. */
  const askPermission = (toolName: string, reqId = 'perm-1'): void => {
    last().line({
      type: 'control_request',
      request_id: reqId,
      request: { subtype: 'can_use_tool', tool_name: toolName, display_name: 'Exit plan mode', input: {} }
    })
  }

  it('approving ExitPlanMode resets the tracked mode back to default', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', '/plan plan') // now in plan mode
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'plan' })
    askPermission('ExitPlanMode')
    answerChat('w1', { kind: 'permission', requestId: 'perm-1', allow: true })
    // Persisted back to default, and a control request was sent to align the CLI.
    expect(sink).toHaveBeenLastCalledWith('w1', { permissionMode: 'default' })
    expect(lastWritten()).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_permission_mode', mode: 'default' }
    })
    // /plan picker would now mark Default as current (no stale "plan").
    expect(attachChat('w1').items.some((it) => it.text.includes('Вихід із режиму планування'))).toBe(true)
  })

  it('does not touch the mode when ExitPlanMode is denied', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready()
    sendChatMessage('w1', '/plan plan')
    sink.mockClear()
    askPermission('ExitPlanMode')
    answerChat('w1', { kind: 'permission', requestId: 'perm-1', allow: false })
    expect(sink).not.toHaveBeenCalled()
  })

  it('ignores ExitPlanMode sync when not in plan mode (no spurious reset)', () => {
    const sink = vi.fn()
    onChatParams(sink)
    ready() // default mode
    askPermission('ExitPlanMode')
    answerChat('w1', { kind: 'permission', requestId: 'perm-1', allow: true })
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('session lifecycle', () => {
  it('reports the session id from the init event', () => {
    const sink = vi.fn()
    onChatSessionId(sink)
    startChat(baseOpts)
    last().line({ type: 'system', subtype: 'init', session_id: 'sess-42' })
    expect(sink).toHaveBeenCalledWith('w1', 'sess-42')
  })

  it('retries fresh (and clears the stored id) when a resume fails before init', () => {
    const sink = vi.fn()
    onChatSessionId(sink)
    startChat({ ...baseOpts, resume: 'stale' })
    last().emit('exit', 1)
    expect(sink).toHaveBeenCalledWith('w1', undefined)
    expect(spawned).toHaveLength(2)
    expect((spawnArgs[1] as [string, string[]])[1][1]).not.toContain('--resume')
  })

  it('logs an exit notice (with stderr tail) on an unexpected crash after init', () => {
    startChat(baseOpts)
    last().line({ type: 'system', subtype: 'init', session_id: 's1' })
    last().stderr.emit('data', Buffer.from('boom from stderr'))
    last().emit('exit', 1)
    const items = attachChat('w1').items
    expect(items[items.length - 1].role).toBe('info')
    expect(items[items.length - 1].text).toContain('код 1')
    expect(items[items.length - 1].text).toContain('boom from stderr')
    expect(spawned).toHaveLength(1) // no auto-respawn loop
  })

  it('clears pending and busy when the process exits', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'hi')
    last().line(QUESTION_REQUEST)
    last().emit('exit', 0)
    const snap = attachChat('w1')
    expect(snap.pending).toBeNull()
    expect(snap.busy).toBe(false)
  })

  it('ensureChat respawns a stopped session resuming the in-memory session id', () => {
    startChat(baseOpts)
    last().line({ type: 'system', subtype: 'init', session_id: 'sess-7' })
    stopChatProc('w1')
    last().emit('exit', 0)
    ensureChat('w1')
    expect(spawned).toHaveLength(2)
    expect((spawnArgs[1] as [string, string[]])[1][1]).toContain('--resume sess-7')
    // The transcript survived the restart.
  })

  it('killChat group-kills the proc and drops the transcript', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'hi')
    const pid = last().pid
    killChat('w1')
    expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
    expect(attachChat('w1').items).toHaveLength(0)
  })
})

describe('transcript persistence', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'))
    setChatStorageDir(dir)
  })
  afterEach(() => {
    killAllChats()
    setChatStorageDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves the transcript on kill and reloads it for the next session', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'збережи це')
    killChat('w1') // flushes the save, drops the in-memory entry
    expect(existsSync(join(dir, 'w1.json'))).toBe(true)
    // Fresh entry — as after an app restart or archive→restore.
    startChat(baseOpts)
    const items = attachChat('w1').items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user', text: 'збережи це' })
  })

  it('closes out a tool call that was still running when the session died', () => {
    startChat(baseOpts)
    last().line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 999' } }]
      }
    })
    killChat('w1')
    startChat(baseOpts)
    // No eternal spinner on reload — the interrupted call reads as errored.
    expect(attachChat('w1').items[0]).toMatchObject({ role: 'tool', done: true, isError: true })
  })

  it('flushes the debounced save when a turn completes', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'msg')
    last().line({ type: 'result', subtype: 'success', is_error: false })
    const saved = JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8')) as {
      items: ChatItem[]
    }
    expect(saved.items[0]).toMatchObject({ role: 'user', text: 'msg' })
  })

  it('deleteChatHistory removes the persisted file for good', () => {
    startChat(baseOpts)
    sendChatMessage('w1', 'x')
    killChat('w1')
    expect(existsSync(join(dir, 'w1.json'))).toBe(true)
    deleteChatHistory('w1')
    expect(existsSync(join(dir, 'w1.json'))).toBe(false)
    startChat(baseOpts)
    expect(attachChat('w1').items).toHaveLength(0)
  })

  it('survives a corrupt transcript file (starts empty instead of crashing)', () => {
    rmSync(join(dir, 'w1.json'), { force: true })
    startChat(baseOpts)
    killChat('w1')
    // Corrupt the file, then reload.
    writeFileSync(join(dir, 'w1.json'), '{broken', 'utf8')
    startChat(baseOpts)
    expect(attachChat('w1').items).toHaveLength(0)
  })

  /** Run one session: initialize with the given commands/models, then persist. */
  const runInit = (commands: { name: string }[], models: unknown[] = []): void => {
    startChat(baseOpts)
    const req = JSON.parse(last().stdin.write.mock.calls[0][0] as string) as {
      request_id: string
    }
    last().line({
      type: 'control_response',
      response: { subtype: 'success', request_id: req.request_id, response: { commands, models } }
    })
    killChat('w1')
  }
  const lastInfo = (): string => {
    const items = attachChat('w1').items.filter((it) => it.role === 'info')
    return items.map((it) => it.text).join('\n')
  }

  it('reports added and removed commands across sessions', () => {
    runInit([{ name: 'clear' }, { name: 'review' }])
    // Next session: /review is gone, /usage is new.
    startChat(baseOpts)
    const req = JSON.parse(last().stdin.write.mock.calls[0][0] as string) as { request_id: string }
    last().line({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { commands: [{ name: 'clear' }, { name: 'usage' }], models: [] }
      }
    })
    const text = lastInfo()
    expect(text).toContain('Команди більше недоступні: /review')
    expect(text).toContain('Нові команди: /usage')
  })

  it('does not report drift on the very first session (no baseline)', () => {
    startChat(baseOpts)
    const req = JSON.parse(last().stdin.write.mock.calls[0][0] as string) as { request_id: string }
    last().line({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: req.request_id,
        response: { commands: [{ name: 'clear' }], models: [] }
      }
    })
    expect(attachChat('w1').items.filter((it) => it.role === 'info')).toHaveLength(0)
  })
})

describe('/mcp command', () => {
  /** Feed a system/init event carrying mcp servers (+ optional tools and slash commands). */
  const initWithMcp = (
    mcpServers: unknown[],
    tools: unknown[] = [],
    slash: string[] = ['clear']
  ): void => {
    last().line({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      mcp_servers: mcpServers,
      tools,
      slash_commands: slash
    })
  }
  const mcpInfo = (): string =>
    attachChat('w1')
      .items.filter((it) => it.role === 'info')
      .map((it) => it.text)
      .join('\n')

  it('is offered even with no MCP servers (so a fresh profile can add the first)', () => {
    startChat(baseOpts)
    initWithMcp([])
    expect((attachChat('w1').commands ?? []).some((c) => c.name === 'mcp')).toBe(true)
  })

  it('is offered (with status + tool count) when servers are present', () => {
    startChat(baseOpts)
    initWithMcp(
      [{ name: 'linear', status: 'needs-auth' }],
      ['mcp__linear__create_issue', 'mcp__linear__list_issues', 'Bash']
    )
    expect((attachChat('w1').commands ?? []).some((c) => c.name === 'mcp')).toBe(true)
  })

  it('bare /mcp opens a picker: the ➕ Add option first, then the servers', () => {
    startChat(baseOpts)
    initWithMcp([
      { name: 'linear', status: 'needs-auth' },
      { name: 'github', status: 'connected' }
    ])
    sendChatMessage('w1', '/mcp')
    const pending = lastPending()
    expect(pending?.kind).toBe('question')
    const labels =
      pending?.kind === 'question' ? pending.questions[0].options.map((o) => o.label) : []
    expect(labels).toEqual(['➕ Додати сервер', '! linear', '✓ github'])
  })

  it('/mcp add delegates to the add sink (opens the Terminal)', () => {
    const addSink = vi.fn()
    onChatMcpAdd(addSink)
    startChat(baseOpts)
    initWithMcp([])
    sendChatMessage('w1', '/mcp add')
    expect(addSink).toHaveBeenCalledWith('w1')
    onChatMcpAdd(() => {})
  })

  it('picking a connected server lists its tools in the transcript', () => {
    startChat(baseOpts)
    initWithMcp(
      [{ name: 'github', status: 'connected' }],
      ['mcp__github__create_pr', 'mcp__github__list_repos']
    )
    sendChatMessage('w1', '/mcp')
    const pending = lastPending()
    const q = pending?.kind === 'question' ? pending.questions[0].question : ''
    answerChat('w1', { kind: 'question', requestId: pending!.requestId, answers: { [q]: '✓ github' } })
    const text = mcpInfo()
    expect(text).toContain('MCP «github»')
    expect(text).toContain('create_pr')
    expect(text).toContain('list_repos')
  })

  it('selecting a needs-auth server delegates to the auth sink', () => {
    const sink = vi.fn()
    onChatMcpAuth(sink)
    startChat(baseOpts)
    initWithMcp([{ name: 'linear', status: 'needs-auth' }])
    // Inline form goes straight through apply → mcpAction → the auth sink.
    sendChatMessage('w1', '/mcp linear')
    expect(sink).toHaveBeenCalledWith('w1', 'linear')
    onChatMcpAuth(() => {})
  })

  it('re-captures server status on the next init (needs-auth → connected)', () => {
    startChat(baseOpts)
    initWithMcp([{ name: 'linear', status: 'needs-auth' }])
    // A later init (e.g. after authenticating + restart) reports it connected.
    initWithMcp([{ name: 'linear', status: 'connected' }], ['mcp__linear__create_issue'])
    sendChatMessage('w1', '/mcp linear')
    expect(mcpInfo()).toContain('MCP «linear» (✓ підключено)')
  })
})

describe('summarizeToolUse', () => {
  it('picks the human-relevant field per tool', () => {
    expect(summarizeToolUse('Bash', { command: 'ls -la' })).toBe('ls -la')
    expect(summarizeToolUse('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeToolUse('Grep', { pattern: 'TODO' })).toBe('TODO')
    expect(summarizeToolUse('WebSearch', { query: 'docs' })).toBe('docs')
  })
  it('falls back to JSON and truncates long summaries', () => {
    expect(summarizeToolUse('Custom', { a: 1 })).toBe('{"a":1}')
    expect(summarizeToolUse('Bash', { command: 'x'.repeat(500) })).toHaveLength(300)
  })
})
