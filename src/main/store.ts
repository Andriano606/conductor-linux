import { app } from 'electron'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Project, Settings, Workspace } from '../shared/types'

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

export function updateWorkspaceSetupStatus(id: string, setupStatus: Workspace['setupStatus']): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (ws) {
    ws.setupStatus = setupStatus
    persist()
  }
}

/** Persist the Claude chat session id so the conversation resumes on relaunch. */
export function updateWorkspaceSessionId(id: string, sessionId: string | undefined): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (ws && ws.claudeSessionId !== sessionId) {
    ws.claudeSessionId = sessionId
    persist()
  }
}

/**
 * Persist a runtime model/effort choice (from the local /model, /effort
 * commands) so it is reapplied as --model/--effort on the next (re)spawn.
 */
export function updateWorkspaceClaudeParams(
  id: string,
  patch: { model?: string; effort?: string; permissionMode?: string }
): void {
  const ws = data.workspaces.find((w) => w.id === id)
  if (!ws) return
  let changed = false
  if ('model' in patch && ws.claudeModel !== patch.model) {
    ws.claudeModel = patch.model
    changed = true
  }
  if ('effort' in patch && ws.claudeEffort !== patch.effort) {
    ws.claudeEffort = patch.effort
    changed = true
  }
  if ('permissionMode' in patch && ws.claudePermissionMode !== patch.permissionMode) {
    ws.claudePermissionMode = patch.permissionMode
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
