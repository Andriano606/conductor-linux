import { app } from 'electron'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { ChatSession, Project, Settings, Workspace } from '../shared/types'

interface PersistedData {
  settings: Settings
  projects: Project[]
  workspaces: Workspace[]
}

let dataPath = ''
let data: PersistedData

function defaults(): PersistedData {
  return {
    settings: {
      worktreesDir: join(app.getPath('home'), '.conductor-linux', 'worktrees'),
      startPort: 3002,
      ideCommand: '',
      claudeArgs: '--dangerously-skip-permissions'
    },
    projects: [],
    workspaces: []
  }
}

/**
 * Reconcile a persisted (possibly legacy) data file with the current schema.
 *
 * Legacy files (pre-projects) stored repoPath + the three scripts on the global
 * settings and had workspaces with no projectId. We move those into a single
 * synthesized project and stamp every orphan workspace with its id so existing
 * installs keep working after the projects refactor.
 */
function migrate(parsed: Record<string, unknown>): PersistedData {
  const base = defaults()
  const ps = (parsed.settings ?? {}) as Record<string, unknown>
  const settings: Settings = {
    worktreesDir: (ps.worktreesDir as string) ?? base.settings.worktreesDir,
    startPort: (ps.startPort as number) ?? base.settings.startPort,
    ideCommand: (ps.ideCommand as string) ?? base.settings.ideCommand,
    claudeArgs: (ps.claudeArgs as string) ?? base.settings.claudeArgs
  }
  let projects = (parsed.projects as Project[]) ?? []
  let workspaces = (parsed.workspaces as Workspace[]) ?? []

  // Legacy migration: no projects array yet, but the old global settings held a
  // repoPath/scripts (or there are orphan workspaces). Fold them into one project.
  if (!parsed.projects && (ps.repoPath || workspaces.length)) {
    const repoPath = (ps.repoPath as string) ?? ''
    const legacy: Project = {
      id: randomUUID(),
      name: basename(repoPath) || 'project',
      repoPath,
      setupScript: (ps.setupScript as string) ?? '',
      runScript: (ps.runScript as string) ?? '',
      archiveScript: (ps.archiveScript as string) ?? '',
      createdAt: Date.now()
    }
    projects = [legacy]
    workspaces = workspaces.map((w) => ({ ...w, projectId: w.projectId || legacy.id }))
  }

  // Sessions migration: a workspace from before multi-session support has its
  // Claude state (session id, model/effort/permission-mode) on the workspace and
  // no `sessions` array. Fold those fields into a single session whose id reuses
  // the workspace id, so the existing chats/<wsId>.json transcript and resume id
  // keep working untouched.
  workspaces = workspaces.map((w) => {
    if (Array.isArray(w.sessions) && w.sessions.length) return w
    const legacy = w as Workspace & {
      claudeSessionId?: string
      claudeModel?: string
      claudeEffort?: string
      claudePermissionMode?: string
    }
    const session: ChatSession = {
      id: w.id,
      createdAt: w.createdAt,
      claudeSessionId: legacy.claudeSessionId,
      claudeModel: legacy.claudeModel,
      claudeEffort: legacy.claudeEffort,
      claudePermissionMode: legacy.claudePermissionMode
    }
    delete legacy.claudeSessionId
    delete legacy.claudeModel
    delete legacy.claudeEffort
    delete legacy.claudePermissionMode
    return { ...w, sessions: [session] }
  })

  return { settings, projects, workspaces }
}

export function initStore(): void {
  dataPath = join(app.getPath('userData'), 'conductor-data.json')
  if (existsSync(dataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as Record<string, unknown>
      data = migrate(parsed)
    } catch {
      data = defaults()
    }
  } else {
    data = defaults()
  }
}

function persist(): void {
  writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8')
}

// ---- Settings (global) ----
export function getSettings(): Settings {
  return data.settings
}

export function setSettings(settings: Settings): Settings {
  data.settings = settings
  persist()
  return data.settings
}

// ---- Projects ----
export function getProjects(): Project[] {
  return data.projects
}

export function getProject(id: string): Project | undefined {
  return data.projects.find((p) => p.id === id)
}

export function addProject(project: Project): void {
  data.projects.push(project)
  persist()
}

/** Replace a project by id (no-op if it's gone). Returns the stored project. */
export function updateProject(project: Project): Project | undefined {
  const i = data.projects.findIndex((p) => p.id === project.id)
  if (i === -1) return undefined
  data.projects[i] = project
  persist()
  return project
}

export function removeProject(id: string): void {
  data.projects = data.projects.filter((p) => p.id !== id)
  persist()
}

// ---- Workspaces ----
export function getWorkspaces(): Workspace[] {
  return data.workspaces
}

export function getWorkspace(id: string): Workspace | undefined {
  return data.workspaces.find((w) => w.id === id)
}

export function addWorkspace(ws: Workspace): void {
  data.workspaces.push(ws)
  persist()
}

export function removeWorkspace(id: string): void {
  data.workspaces = data.workspaces.filter((w) => w.id !== id)
  persist()
}

export function updateWorkspaceStatus(id: string, status: Workspace['status']): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (ws) {
    ws.status = status
    persist()
  }
}

export function updateWorkspaceBranch(id: string, branch: string): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (ws) {
    ws.branch = branch
    persist()
  }
}

export function updateWorkspaceSetupStatus(id: string, setupStatus: Workspace['setupStatus']): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (ws) {
    ws.setupStatus = setupStatus
    persist()
  }
}

// ---- Chat sessions (keyed by the opaque session id, which is the chat key) ----

/** Locate a session by its id along with the workspace that owns it. */
export function findSession(
  sessionId: string
): { ws: Workspace; session: ChatSession } | undefined {
  for (const ws of data.workspaces) {
    const session = ws.sessions?.find((s) => s.id === sessionId)
    if (session) return { ws, session }
  }
  return undefined
}

/** Append a new chat session to a workspace and return it. */
export function addSession(workspaceId: string): ChatSession | undefined {
  const ws = data.workspaces.find((w) => w.id === workspaceId)
  if (!ws) return undefined
  const session: ChatSession = { id: randomUUID(), createdAt: Date.now() }
  ws.sessions.push(session)
  persist()
  return session
}

/** Remove a chat session from its workspace (no-op for the last remaining one). */
export function removeSession(sessionId: string): void {
  const found = findSession(sessionId)
  if (!found || found.ws.sessions.length <= 1) return
  found.ws.sessions = found.ws.sessions.filter((s) => s.id !== sessionId)
  persist()
}

/** Rename a chat session (empty title clears it, reverting to "Сесія N"). */
export function renameSession(sessionId: string, title: string): void {
  const found = findSession(sessionId)
  if (!found) return
  const next = title.trim() || undefined
  if (found.session.title !== next) {
    found.session.title = next
    persist()
  }
}

/** Persist the Claude chat session id so the conversation resumes on relaunch. */
export function updateSessionSessionId(id: string, sessionId: string | undefined): void {
  const found = findSession(id)
  if (found && found.session.claudeSessionId !== sessionId) {
    found.session.claudeSessionId = sessionId
    persist()
  }
}

/**
 * Persist a runtime model/effort choice (from the local /model, /effort
 * commands) so it is reapplied as --model/--effort on the next (re)spawn.
 */
export function updateSessionClaudeParams(
  id: string,
  patch: { model?: string; effort?: string; permissionMode?: string }
): void {
  const found = findSession(id)
  if (!found) return
  const session = found.session
  let changed = false
  if ('model' in patch && session.claudeModel !== patch.model) {
    session.claudeModel = patch.model
    changed = true
  }
  if ('effort' in patch && session.claudeEffort !== patch.effort) {
    session.claudeEffort = patch.effort
    changed = true
  }
  if ('permissionMode' in patch && session.claudePermissionMode !== patch.permissionMode) {
    session.claudePermissionMode = patch.permissionMode
    changed = true
  }
  if (changed) persist()
}

/**
 * Lowest free port starting at the configured startPort, skipping ports already
 * assigned to a workspace. Exposed to scripts as CONDUCTOR_PORT. Ports are
 * unique across all projects so two running workspaces never collide.
 */
export function nextPort(): number {
  const used = new Set(data.workspaces.map((w) => w.port))
  let port = data.settings.startPort || 3002
  while (used.has(port)) port++
  return port
}
