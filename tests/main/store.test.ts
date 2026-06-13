import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Project, Settings, Workspace } from '../../src/shared/types'

// app.getPath is the only electron surface store.ts touches.
const h = vi.hoisted(() => ({ userData: '', home: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? h.userData : h.home) }
}))

import {
  addProject,
  addSession,
  addWorkspace,
  findSession,
  getProject,
  getProjects,
  getSettings,
  getWorkspace,
  getWorkspaces,
  initStore,
  nextPort,
  removeProject,
  removeSession,
  removeWorkspace,
  renameSession,
  setSettings,
  updateProject,
  updateSessionClaudeParams,
  updateSessionSessionId,
  updateWorkspaceStatus
} from '../../src/main/store'

const mkProject = (over: Partial<Project> = {}): Project => ({
  id: over.id ?? 'p-' + Math.random().toString(36).slice(2),
  name: 'proj',
  repoPath: '/repo',
  setupScript: '',
  runScript: '',
  archiveScript: '',
  createdAt: 0,
  ...over
})

const mkWs = (over: Partial<Workspace> = {}): Workspace => {
  const id = over.id ?? 'id-' + Math.random().toString(36).slice(2)
  return {
    id,
    projectId: 'p1',
    name: 'ws',
    branch: 'ws',
    baseBranch: undefined,
    path: '/wt/proj/ws',
    port: 3002,
    createdAt: 0,
    status: 'active',
    // First session reuses the workspace id, mirroring the migration convention.
    sessions: [{ id, createdAt: 0 }],
    ...over
  }
}

let tmp: string
const dataFile = (): string => join(tmp, 'conductor-data.json')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'conductor-store-'))
  h.userData = tmp
  h.home = tmp
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('initStore', () => {
  it('uses defaults on a fresh install', () => {
    initStore()
    const s = getSettings()
    expect(s.startPort).toBe(3002)
    expect(s.worktreesDir).toBe(join(tmp, '.conductor-linux', 'worktrees'))
    expect(s.claudeArgs).toBe('--dangerously-skip-permissions')
    expect(getProjects()).toEqual([])
    expect(getWorkspaces()).toEqual([])
  })

  it('loads an existing modern file and merges partial settings over defaults', () => {
    writeFileSync(
      dataFile(),
      JSON.stringify({
        settings: { startPort: 4000 },
        projects: [mkProject({ id: 'p1' })],
        workspaces: [mkWs({ id: 'w1' })]
      })
    )
    initStore()
    const s = getSettings()
    expect(s.startPort).toBe(4000)
    // Missing keys are backfilled from defaults.
    expect(s.ideCommand).toBe('')
    expect(s.claudeArgs).toBe('--dangerously-skip-permissions')
    expect(getProjects()).toHaveLength(1)
    expect(getWorkspaces()).toHaveLength(1)
  })

  it('migrates a legacy file: folds repoPath/scripts into a project and stamps workspaces', () => {
    writeFileSync(
      dataFile(),
      JSON.stringify({
        settings: {
          repoPath: '/my/repo',
          worktreesDir: '/wt',
          startPort: 4000,
          setupScript: '/s.sh',
          runScript: '/r.sh',
          archiveScript: '/a.sh',
          ideCommand: 'code',
          claudeArgs: '--foo'
        },
        // Legacy workspaces have no projectId and no projects array exists.
        workspaces: [{ id: 'w1', name: 'ws', branch: 'ws', path: '/wt/ws', port: 3002, createdAt: 0, status: 'active' }]
      })
    )
    initStore()
    // Global settings keep only the global keys.
    const s = getSettings()
    expect(s).toEqual({ worktreesDir: '/wt', startPort: 4000, ideCommand: 'code', claudeArgs: '--foo' })
    expect((s as unknown as Record<string, unknown>).repoPath).toBeUndefined()
    // A single project carries the legacy repo + scripts.
    const projects = getProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      name: 'repo',
      repoPath: '/my/repo',
      setupScript: '/s.sh',
      runScript: '/r.sh',
      archiveScript: '/a.sh'
    })
    // The orphan workspace is stamped with the new project id.
    expect(getWorkspaces()[0].projectId).toBe(projects[0].id)
  })

  it('migrates a pre-sessions workspace: folds its Claude fields into one session keyed by ws id', () => {
    writeFileSync(
      dataFile(),
      JSON.stringify({
        settings: { startPort: 3002 },
        projects: [mkProject({ id: 'p1' })],
        // A workspace from before multi-session support: Claude state on the
        // workspace, no `sessions` array.
        workspaces: [
          {
            id: 'w1',
            projectId: 'p1',
            name: 'ws',
            branch: 'ws',
            path: '/wt/ws',
            port: 3002,
            createdAt: 7,
            status: 'active',
            claudeSessionId: 'sess-legacy',
            claudeModel: 'sonnet',
            claudeEffort: 'high',
            claudePermissionMode: 'plan'
          }
        ]
      })
    )
    initStore()
    const ws = getWorkspace('w1')!
    expect(ws.sessions).toHaveLength(1)
    // The session reuses the workspace id so chats/<wsId>.json keeps working.
    expect(ws.sessions[0]).toMatchObject({
      id: 'w1',
      claudeSessionId: 'sess-legacy',
      claudeModel: 'sonnet',
      claudeEffort: 'high',
      claudePermissionMode: 'plan'
    })
    // The legacy fields are stripped off the workspace.
    const raw = ws as unknown as Record<string, unknown>
    expect(raw.claudeSessionId).toBeUndefined()
    expect(raw.claudeModel).toBeUndefined()
  })

  it('falls back to defaults on corrupt JSON', () => {
    writeFileSync(dataFile(), '{ not valid json')
    expect(() => initStore()).not.toThrow()
    expect(getProjects()).toEqual([])
    expect(getWorkspaces()).toEqual([])
  })

  it('tolerates a file missing the arrays', () => {
    writeFileSync(dataFile(), JSON.stringify({ settings: { startPort: 5000 } }))
    initStore()
    expect(getProjects()).toEqual([])
    expect(getWorkspaces()).toEqual([])
  })
})

describe('settings persistence', () => {
  beforeEach(() => initStore())

  it('setSettings round-trips and persists to disk', () => {
    const next: Settings = {
      worktreesDir: '/wt',
      startPort: 3500,
      ideCommand: 'code',
      claudeArgs: '--dangerously-skip-permissions'
    }
    setSettings(next)
    expect(getSettings()).toEqual(next)
    const onDisk = JSON.parse(readFileSync(dataFile(), 'utf8'))
    expect(onDisk.settings).toEqual(next)
  })
})

describe('project CRUD', () => {
  beforeEach(() => initStore())

  it('adds and reads projects', () => {
    addProject(mkProject({ id: 'a' }))
    addProject(mkProject({ id: 'b' }))
    expect(getProjects().map((p) => p.id)).toEqual(['a', 'b'])
    expect(getProject('b')?.id).toBe('b')
    expect(getProject('missing')).toBeUndefined()
  })

  it('persists adds to disk', () => {
    addProject(mkProject({ id: 'a' }))
    const onDisk = JSON.parse(readFileSync(dataFile(), 'utf8'))
    expect(onDisk.projects).toHaveLength(1)
  })

  it('updateProject replaces by id and returns it; unknown id is a no-op', () => {
    addProject(mkProject({ id: 'a', name: 'old' }))
    const saved = updateProject(mkProject({ id: 'a', name: 'new' }))
    expect(saved?.name).toBe('new')
    expect(getProject('a')?.name).toBe('new')
    expect(updateProject(mkProject({ id: 'missing' }))).toBeUndefined()
  })

  it('removes a project; removing an unknown id is a no-op', () => {
    addProject(mkProject({ id: 'a' }))
    removeProject('missing')
    expect(getProjects()).toHaveLength(1)
    removeProject('a')
    expect(getProjects()).toHaveLength(0)
  })
})

describe('workspace CRUD', () => {
  beforeEach(() => initStore())

  it('adds and reads workspaces', () => {
    addWorkspace(mkWs({ id: 'a' }))
    addWorkspace(mkWs({ id: 'b' }))
    expect(getWorkspaces().map((w) => w.id)).toEqual(['a', 'b'])
    expect(getWorkspace('b')?.id).toBe('b')
    expect(getWorkspace('missing')).toBeUndefined()
  })

  it('persists adds to disk', () => {
    addWorkspace(mkWs({ id: 'a' }))
    const onDisk = JSON.parse(readFileSync(dataFile(), 'utf8'))
    expect(onDisk.workspaces).toHaveLength(1)
  })

  it('removes a workspace; removing an unknown id is a no-op', () => {
    addWorkspace(mkWs({ id: 'a' }))
    removeWorkspace('missing')
    expect(getWorkspaces()).toHaveLength(1)
    removeWorkspace('a')
    expect(getWorkspaces()).toHaveLength(0)
  })

  it('updateWorkspaceStatus updates existing and ignores unknown', () => {
    addWorkspace(mkWs({ id: 'a', status: 'setting_up' }))
    updateWorkspaceStatus('a', 'active')
    expect(getWorkspace('a')?.status).toBe('active')
    expect(() => updateWorkspaceStatus('missing', 'archived')).not.toThrow()
  })

  it('updateSessionSessionId sets, clears, persists and ignores unknown/no-op', () => {
    addWorkspace(mkWs({ id: 'a' }))
    updateSessionSessionId('a', 'sess-1')
    expect(getWorkspace('a')?.sessions[0].claudeSessionId).toBe('sess-1')
    // Persisted to disk so the chat resumes after a restart.
    expect(
      JSON.parse(readFileSync(dataFile(), 'utf8')).workspaces[0].sessions[0].claudeSessionId
    ).toBe('sess-1')
    // Clearing it (e.g. a failed resume) is allowed.
    updateSessionSessionId('a', undefined)
    expect(getWorkspace('a')?.sessions[0].claudeSessionId).toBeUndefined()
    expect(() => updateSessionSessionId('missing', 'x')).not.toThrow()
  })

  it('updateSessionClaudeParams sets only the given keys, persists, ignores unknown', () => {
    addWorkspace(mkWs({ id: 'a' }))
    updateSessionClaudeParams('a', { model: 'sonnet', effort: 'high', permissionMode: 'plan' })
    expect(getWorkspace('a')?.sessions[0]).toMatchObject({
      claudeModel: 'sonnet',
      claudeEffort: 'high',
      claudePermissionMode: 'plan'
    })
    // Persisted so the /model, /effort, /plan choices survive a relaunch.
    expect(
      JSON.parse(readFileSync(dataFile(), 'utf8')).workspaces[0].sessions[0].claudePermissionMode
    ).toBe('plan')
    // A partial patch leaves the other fields untouched.
    updateSessionClaudeParams('a', { permissionMode: 'default' })
    expect(getWorkspace('a')?.sessions[0]).toMatchObject({
      claudeModel: 'sonnet',
      claudeEffort: 'high',
      claudePermissionMode: 'default'
    })
    expect(() => updateSessionClaudeParams('missing', { model: 'x' })).not.toThrow()
  })
})

describe('chat sessions', () => {
  beforeEach(() => initStore())

  it('findSession locates a session and its owning workspace', () => {
    addWorkspace(mkWs({ id: 'a' }))
    const found = findSession('a')
    expect(found?.ws.id).toBe('a')
    expect(found?.session.id).toBe('a')
    expect(findSession('missing')).toBeUndefined()
  })

  it('addSession appends a fresh session and persists it', () => {
    addWorkspace(mkWs({ id: 'a' }))
    const session = addSession('a')
    expect(session).toBeDefined()
    expect(getWorkspace('a')?.sessions).toHaveLength(2)
    expect(JSON.parse(readFileSync(dataFile(), 'utf8')).workspaces[0].sessions).toHaveLength(2)
    // Params/params target the right session via its id.
    updateSessionClaudeParams(session!.id, { model: 'opus' })
    expect(findSession(session!.id)?.session.claudeModel).toBe('opus')
    expect(getWorkspace('a')?.sessions[0].claudeModel).toBeUndefined()
    expect(addSession('missing')).toBeUndefined()
  })

  it('removeSession drops a session but refuses the last one', () => {
    addWorkspace(mkWs({ id: 'a' }))
    const second = addSession('a')!
    removeSession(second.id)
    expect(getWorkspace('a')?.sessions.map((s) => s.id)).toEqual(['a'])
    // The sole remaining session cannot be removed.
    removeSession('a')
    expect(getWorkspace('a')?.sessions).toHaveLength(1)
  })

  it('renameSession sets and clears the title', () => {
    addWorkspace(mkWs({ id: 'a' }))
    renameSession('a', '  refactor  ')
    expect(getWorkspace('a')?.sessions[0].title).toBe('refactor')
    renameSession('a', '   ')
    expect(getWorkspace('a')?.sessions[0].title).toBeUndefined()
  })
})

describe('nextPort', () => {
  beforeEach(() => initStore())

  it('returns startPort when free', () => {
    setSettings({ ...getSettings(), startPort: 3002 })
    expect(nextPort()).toBe(3002)
  })

  it('skips ports already assigned and returns the lowest free in a gap', () => {
    setSettings({ ...getSettings(), startPort: 3002 })
    addWorkspace(mkWs({ id: 'a', port: 3002 }))
    addWorkspace(mkWs({ id: 'b', port: 3003 }))
    addWorkspace(mkWs({ id: 'd', port: 3005 }))
    // 3004 is the lowest free starting from 3002.
    expect(nextPort()).toBe(3004)
  })

  it('honors a custom startPort', () => {
    setSettings({ ...getSettings(), startPort: 5000 })
    expect(nextPort()).toBe(5000)
  })

  it('falls back to 3002 when startPort is falsy', () => {
    setSettings({ ...getSettings(), startPort: 0 })
    expect(nextPort()).toBe(3002)
  })
})
