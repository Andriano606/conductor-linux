// Types shared between the main, preload and renderer processes.

export interface Settings {
  /** Path to the main git repository that worktrees are created from. */
  repoPath: string
  /** Directory where workspace worktrees are created. */
  worktreesDir: string
  /** Lowest port assigned to a workspace (exposed to scripts as CONDUCTOR_PORT). */
  startPort: number
  /** Absolute path to the setup script (runs on workspace creation). */
  setupScript: string
  /** Absolute path to the run script (runs on demand via the Run button). */
  runScript: string
  /** Absolute path to the archive script (runs before a workspace is archived). */
  archiveScript: string
}

export type WorkspaceStatus = 'setting_up' | 'active' | 'archived'

export interface Workspace {
  id: string
  name: string
  /** git branch created for this workspace, e.g. conductor/<name>. */
  branch: string
  /** Absolute path of the worktree on disk. */
  path: string
  /** Unique port exposed to scripts as CONDUCTOR_PORT. */
  port: number
  createdAt: number
  status: WorkspaceStatus
}

/** A PTY belongs to a workspace; 'claude' is the interactive session, 'task' aggregates script output. */
export type PtyKind = 'claude' | 'task'

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
