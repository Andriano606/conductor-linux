import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Settings, Workspace } from '../../src/shared/types'

// app.getPath is the only electron surface store.ts touches.
const h = vi.hoisted(() => ({ userData: '', home: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? h.userData : h.home) }
}))

import {
  addWorkspace,
  getSettings,
  getWorkspace,
  getWorkspaces,
  initStore,
  nextPort,
  removeWorkspace,
  setSettings,
  updateWorkspaceStatus
} from '../../src/main/store'

const mkWs = (over: Partial<Workspace> = {}): Workspace => ({
  id: over.id ?? 'id-' + Math.random().toString(36).slice(2),
  name: 'ws',
  branch: 'ws',
  baseBranch: undefined,
  path: '/wt/ws',
  port: 3002,
  createdAt: 0,
  status: 'active',
  ...over
})

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
    expect(s.repoPath).toBe('')
    expect(s.startPort).toBe(3002)
    expect(s.worktreesDir).toBe(join(tmp, '.conductor-linux', 'worktrees'))
    expect(s.claudeArgs).toBe('--dangerously-skip-permissions')
    expect(getWorkspaces()).toEqual([])
  })

  it('loads an existing file and merges partial settings over defaults', () => {
    writeFileSync(
      dataFile(),
      JSON.stringify({
        settings: { repoPath: '/my/repo', startPort: 4000 },
        workspaces: [mkWs({ id: 'w1' })]
      })
    )
    initStore()
    const s = getSettings()
    expect(s.repoPath).toBe('/my/repo')
    expect(s.startPort).toBe(4000)
    // Missing keys are backfilled from defaults.
    expect(s.setupScript).toBe('')
    expect(s.ideCommand).toBe('')
    expect(s.claudeArgs).toBe('--dangerously-skip-permissions')
    expect(getWorkspaces()).toHaveLength(1)
  })

  it('falls back to defaults on corrupt JSON', () => {
    writeFileSync(dataFile(), '{ not valid json')
    expect(() => initStore()).not.toThrow()
    expect(getSettings().repoPath).toBe('')
    expect(getWorkspaces()).toEqual([])
  })

  it('tolerates a file missing the workspaces array', () => {
    writeFileSync(dataFile(), JSON.stringify({ settings: { repoPath: '/r' } }))
    initStore()
    expect(getWorkspaces()).toEqual([])
  })
})

describe('settings persistence', () => {
  beforeEach(() => initStore())

  it('setSettings round-trips and persists to disk', () => {
    const next: Settings = {
      repoPath: '/repo',
      worktreesDir: '/wt',
      startPort: 3500,
      setupScript: '/s.sh',
      runScript: '/r.sh',
      archiveScript: '/a.sh',
      ideCommand: 'code',
      claudeArgs: '--dangerously-skip-permissions'
    }
    setSettings(next)
    expect(getSettings()).toEqual(next)
    const onDisk = JSON.parse(readFileSync(dataFile(), 'utf8'))
    expect(onDisk.settings).toEqual(next)
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
