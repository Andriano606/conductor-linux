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
}

/**
 * A PTY belongs to a workspace: 'claude' is the interactive Claude session,
 * 'task' aggregates script output (read-only), 'shell' is a free interactive
 * shell in the workspace directory for running ad-hoc commands.
 */
export type PtyKind = 'claude' | 'task' | 'shell'

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
