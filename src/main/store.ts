import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { Settings, Workspace } from '../shared/types'

interface PersistedData {
  settings: Settings
  workspaces: Workspace[]
}

let dataPath = ''
let data: PersistedData

function defaults(): PersistedData {
  return {
    settings: {
      repoPath: '',
      worktreesDir: join(app.getPath('home'), '.conductor-linux', 'worktrees'),
      startPort: 3002,
      setupScript: '',
      runScript: '',
      archiveScript: ''
    },
    workspaces: []
  }
}

export function initStore(): void {
  dataPath = join(app.getPath('userData'), 'conductor-data.json')
  const base = defaults()
  if (existsSync(dataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as Partial<PersistedData>
      data = {
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
        workspaces: parsed.workspaces ?? []
      }
    } catch {
      data = base
    }
  } else {
    data = base
  }
}

function persist(): void {
  writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8')
}

export function getSettings(): Settings {
  return data.settings
}

export function setSettings(settings: Settings): Settings {
  data.settings = settings
  persist()
  return data.settings
}

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

/**
 * Lowest free port starting at the configured startPort, skipping ports already
 * assigned to a workspace. Exposed to scripts as CONDUCTOR_PORT.
 */
export function nextPort(): number {
  const used = new Set(data.workspaces.map((w) => w.port))
  let port = data.settings.startPort || 3002
  while (used.has(port)) port++
  return port
}
