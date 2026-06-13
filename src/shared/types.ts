// Types shared between the main, preload and renderer processes.

/**
 * Global, machine-wide settings shared by every project. Project-specific
 * settings (the repo path and setup/run/archive scripts) live on Project.
 */
export interface Settings {
  /** Base directory under which each project's worktrees are created (in a per-project subfolder). */
  worktreesDir: string
  /** Lowest port assigned to a workspace (exposed to scripts as CONDUCTOR_PORT). */
  startPort: number
  /** Command used to open a workspace in an editor/IDE, e.g. "code", "cursor". */
  ideCommand: string
  /** Extra CLI arguments passed to the `claude` session, e.g. "--dangerously-skip-permissions". */
  claudeArgs: string
}

/**
 * A target git repository. Workspaces are git worktrees of a project's repo.
 * Each project carries its own scripts so different repos can have different
 * setup/run/archive behaviour.
 */
export interface Project {
  id: string
  /** Display name (defaults to the repo folder name; editable). */
  name: string
  /** Path to the main git repository that worktrees are created from. */
  repoPath: string
  /** Absolute path to the setup script (runs on workspace creation). */
  setupScript: string
  /** Absolute path to the run script (runs on demand via the Run button). */
  runScript: string
  /** Absolute path to the archive script (runs before a workspace is archived). */
  archiveScript: string
  /**
   * Host (and optional scheme) used by the "open in browser" button, combined
   * with the workspace port, e.g. "localhost" → http://localhost:<port>, or
   * "myapp.local" / "https://myapp.local". Empty falls back to "localhost".
   */
  browserHost?: string
  createdAt: number
}

/** The project fields supplied at create time or edited later. */
export interface ProjectScripts {
  setupScript?: string
  runScript?: string
  archiveScript?: string
  browserHost?: string
}

export type WorkspaceStatus = 'setting_up' | 'active' | 'archiving' | 'archived'

/**
 * Outcome of the workspace's setup script, persisted so the sidebar indicator
 * survives restarts: 'pending' while it runs, 'success'/'error' from its exit
 * code. Undefined for legacy workspaces created before this was tracked.
 */
export type SetupStatus = 'pending' | 'success' | 'error'

export interface Workspace {
  id: string
  /** The project (repository) this workspace belongs to. */
  projectId: string
  name: string
  /** git branch created for this workspace, e.g. conductor/<name>. */
  branch: string
  /** The base ref this workspace's branch was created from (e.g. "origin/main"). */
  baseBranch?: string
  /** Absolute path of the worktree on disk. */
  path: string
  /** Unique port exposed to scripts as CONDUCTOR_PORT. */
  port: number
  createdAt: number
  status: WorkspaceStatus
  /** Persisted setup-script outcome, surfaced as a sidebar indicator. */
  setupStatus?: SetupStatus
  /**
   * Claude session id reported by the chat session's init event, persisted so
   * the conversation is resumed (--resume) after an app restart.
   */
  claudeSessionId?: string
}

/**
 * A terminal tab of a workspace: 'claude' is the structured Claude chat (not a
 * PTY — a stream-json session rendered by our own UI), 'task' aggregates script
 * output (read-only), 'shell' is a free interactive shell in the workspace
 * directory for running ad-hoc commands.
 */
export type PtyKind = 'claude' | 'task' | 'shell'

// ---- Claude chat (structured stream-json session) ------------------------

/** One selectable option of an AskUserQuestion question. */
export interface ChatQuestionOption {
  label: string
  description?: string
}

/** One question Claude asked via the AskUserQuestion tool. */
export interface ChatQuestion {
  question: string
  header?: string
  options: ChatQuestionOption[]
  multiSelect?: boolean
}

/**
 * A request from Claude that blocks the conversation until the user responds
 * from the chat input area: either a clarifying question with options (shown
 * as buttons) or a tool-permission request (Allow/Deny).
 */
export type ChatPending =
  | { kind: 'question'; requestId: string; questions: ChatQuestion[] }
  | { kind: 'permission'; requestId: string; toolName: string; summary: string }

/** One entry of the chat transcript. */
export interface ChatItem {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  /**
   * User items only: this entry records the answer to an options question,
   * not a typed message — excluded from the input's arrow-key history.
   */
  answer?: boolean
  /** Tool items only: the tool name (e.g. "Bash"). */
  toolName?: string
  /** Tool items only: flips true when its tool_result arrives. */
  done?: boolean
  /** Tool items only: the tool_result reported an error. */
  isError?: boolean
  ts: number
}

/** One slash command available in the session (reported by the CLI). */
export interface ChatCommand {
  name: string
  description?: string
  argumentHint?: string
}

/** Snapshot returned by chat:attach — the transcript plus live state. */
export interface ChatSnapshot {
  items: ChatItem[]
  pending: ChatPending | null
  busy: boolean
  /** Sequence number of the last event folded into this snapshot. */
  seq: number
  /** Slash commands the CLI reported (for the input's autocomplete). */
  commands?: ChatCommand[]
}

/** Incremental chat event streamed to the renderer over chat:event. */
export type ChatEvent =
  | { type: 'item'; item: ChatItem }
  | { type: 'append'; itemId: string; text: string }
  | { type: 'update'; item: ChatItem }
  | { type: 'pending'; pending: ChatPending | null }
  | { type: 'busy'; busy: boolean }
  | { type: 'commands'; commands: ChatCommand[] }
  /** The CLI reset the conversation (e.g. /clear) — drop the transcript. */
  | { type: 'clear' }

export interface ChatEventPayload {
  id: string
  seq: number
  ev: ChatEvent
}

/** The user's response to a ChatPending, sent from the renderer to main. */
export type ChatAnswer =
  | { kind: 'question'; requestId: string; answers: Record<string, string> }
  | { kind: 'permission'; requestId: string; allow: boolean; message?: string }

export interface PtyData {
  id: string
  kind: PtyKind
  data: string
}

export interface PtyExit {
  id: string
  kind: PtyKind
  exitCode: number
}

export interface IpcResult<T> {
  ok: boolean
  value?: T
  error?: string
}
