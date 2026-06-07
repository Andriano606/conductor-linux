import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Settings, Workspace } from '../../src/shared/types'

// ── Mocks ────────────────────────────────────────────────────────────────────
// In-memory store so status transitions are observable without touching disk.
const store = vi.hoisted(() => {
  let settings: Settings
  let projects: Project[] = []
  let workspaces: Workspace[] = []
  return {
    _set(s: Settings, ps: Project[], ws: Workspace[]) {
      settings = s
      projects = ps
      workspaces = ws
    },
    getSettings: vi.fn(() => settings),
    getProjects: vi.fn(() => projects),
    getProject: vi.fn((id: string) => projects.find((p) => p.id === id)),
    addProject: vi.fn((p: Project) => {
      projects.push(p)
    }),
    removeProject: vi.fn((id: string) => {
      projects = projects.filter((p) => p.id !== id)
    }),
    getWorkspaces: vi.fn(() => workspaces),
    getWorkspace: vi.fn((id: string) => workspaces.find((w) => w.id === id)),
    addWorkspace: vi.fn((w: Workspace) => {
      workspaces.push(w)
    }),
    removeWorkspace: vi.fn((id: string) => {
      workspaces = workspaces.filter((w) => w.id !== id)
    }),
    updateWorkspaceStatus: vi.fn((id: string, status: Workspace['status']) => {
      const w = workspaces.find((x) => x.id === id)
      if (w) w.status = status
    }),
    updateWorkspaceSetupStatus: vi.fn((id: string, setupStatus: Workspace['setupStatus']) => {
      const w = workspaces.find((x) => x.id === id)
      if (w) w.setupStatus = setupStatus
    }),
    nextPort: vi.fn(() => 3010)
  }
})
vi.mock('../../src/main/store', () => store)

const git = vi.hoisted(() => ({
  isGitRepo: vi.fn(async () => true),
  branchExists: vi.fn(async () => false),
  worktreeAdd: vi.fn(async () => {}),
  worktreeAddExisting: vi.fn(async () => {}),
  worktreePrune: vi.fn(async () => {}),
  worktreeRemove: vi.fn(async () => {}),
  branchDelete: vi.fn(async () => {})
}))
vi.mock('../../src/main/git', () => git)

const ptym = vi.hoisted(() => ({
  runTask: vi.fn(async () => 0),
  startClaude: vi.fn(),
  startShell: vi.fn(),
  killWorkspace: vi.fn(),
  stopTask: vi.fn()
}))
vi.mock('../../src/main/ptyManager', () => ptym)

const fsm = vi.hoisted(() => ({ existsSync: vi.fn(() => false), mkdirSync: vi.fn() }))
vi.mock('fs', () => fsm)

import {
  beginArchive,
  createProject,
  createWorkspace,
  deleteArchivedWorkspace,
  deleteProject,
  finishArchive,
  finishSetup,
  projectNameFromPath,
  restoreSessions,
  restoreWorktree,
  runWorkspace,
  slugify
} from '../../src/main/workspaces'

const settings: Settings = {
  worktreesDir: '/wt',
  startPort: 3002,
  ideCommand: '',
  claudeArgs: '--dangerously-skip-permissions'
}

const mkProject = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'proj',
  repoPath: '/repo',
  setupScript: '',
  runScript: '',
  archiveScript: '',
  createdAt: 0,
  ...over
})

const mkWs = (over: Partial<Workspace>): Workspace => ({
  id: 'id',
  projectId: 'p1',
  name: 'ws',
  branch: 'ws',
  baseBranch: undefined,
  path: '/wt/proj/ws',
  port: 3002,
  createdAt: 0,
  status: 'active',
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  git.isGitRepo.mockResolvedValue(true)
  git.branchExists.mockResolvedValue(false)
  git.worktreeAdd.mockResolvedValue(undefined)
  git.worktreeRemove.mockResolvedValue(undefined)
  ptym.runTask.mockResolvedValue(0)
  fsm.existsSync.mockReturnValue(false)
  store._set({ ...settings }, [mkProject()], [])
})

describe('slugify', () => {
  it('lowercases, dashes non-alphanumerics and trims edge dashes', () => {
    expect(slugify('Feature/Login Page')).toBe('feature-login-page')
    expect(slugify('  Hello!! ')).toBe('hello')
    expect(slugify('keep-this_one')).toBe('keep-this_one')
  })
  it('falls back to "workspace" for empty/symbol-only input', () => {
    expect(slugify('')).toBe('workspace')
    expect(slugify('!!!')).toBe('workspace')
  })
})

describe('createProject', () => {
  it('throws on an empty path', async () => {
    await expect(createProject('   ')).rejects.toThrow(/path is required/)
  })
  it('throws when the folder is not a git repository', async () => {
    git.isGitRepo.mockResolvedValue(false)
    await expect(createProject('/not/git')).rejects.toThrow(/not a git repository/)
  })
  it('throws on a duplicate repo path', async () => {
    store._set({ ...settings }, [mkProject({ repoPath: '/repo' })], [])
    await expect(createProject('/repo')).rejects.toThrow(/already exists/)
  })
  it('derives the name from the repo folder and persists', async () => {
    store._set({ ...settings }, [], [])
    const p = await createProject('/some/cool-app')
    expect(p.name).toBe('cool-app')
    expect(p.repoPath).toBe('/some/cool-app')
    expect(store.addProject).toHaveBeenCalledWith(p)
  })
  it('seeds the project scripts from the supplied object (trimmed)', async () => {
    store._set({ ...settings }, [], [])
    const p = await createProject('/some/cool-app', {
      setupScript: ' /s.sh ',
      runScript: '/r.sh',
      archiveScript: '',
      browserHost: ' myapp.local '
    })
    expect(p.setupScript).toBe('/s.sh')
    expect(p.runScript).toBe('/r.sh')
    expect(p.archiveScript).toBe('')
    expect(p.browserHost).toBe('myapp.local')
  })
})

describe('projectNameFromPath', () => {
  it('takes the last path segment, ignoring trailing slashes', () => {
    expect(projectNameFromPath('/home/me/cool-app')).toBe('cool-app')
    expect(projectNameFromPath('/home/me/cool-app/')).toBe('cool-app')
  })
})

describe('deleteProject', () => {
  it('tears down every workspace and removes the project', async () => {
    store._set({ ...settings }, [mkProject({ id: 'p1' })], [
      mkWs({ id: 'a', projectId: 'p1', branch: 'a', path: '/wt/proj/a' }),
      mkWs({ id: 'b', projectId: 'p1', branch: 'b', path: '/wt/proj/b' })
    ])
    fsm.existsSync.mockReturnValue(true)
    await deleteProject('p1')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('b')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/proj/a')
    expect(git.branchDelete).toHaveBeenCalledWith('/repo', 'b')
    expect(store.removeWorkspace).toHaveBeenCalledWith('a')
    expect(store.removeProject).toHaveBeenCalledWith('p1')
  })
  it('is a no-op for an unknown id', async () => {
    await deleteProject('nope')
    expect(store.removeProject).not.toHaveBeenCalled()
  })
})

describe('createWorkspace validation', () => {
  it('throws when the project is missing', async () => {
    await expect(createWorkspace('nope', 'x')).rejects.toThrow(/Project not found/)
  })
  it('throws when the repo is not a git repository', async () => {
    git.isGitRepo.mockResolvedValue(false)
    await expect(createWorkspace('p1', 'x')).rejects.toThrow(/not a git repository/)
  })
  it('throws on an empty name', async () => {
    await expect(createWorkspace('p1', '   ')).rejects.toThrow(/Name is required/)
  })
  it('throws on a duplicate name/branch within the project', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', name: 'dup', branch: 'dup' })])
    await expect(createWorkspace('p1', 'dup')).rejects.toThrow(/already exists/)
  })
  it('allows the same name in a different project', async () => {
    store._set({ ...settings }, [mkProject({ id: 'p1' }), mkProject({ id: 'p2', name: 'other' })], [
      mkWs({ id: 'a', projectId: 'p1', name: 'dup', branch: 'dup' })
    ])
    const ws = await createWorkspace('p2', 'dup')
    expect(ws.projectId).toBe('p2')
  })
  it('throws when the git branch already exists', async () => {
    git.branchExists.mockResolvedValue(true)
    await expect(createWorkspace('p1', 'feat')).rejects.toThrow(/Branch .* already exists/)
  })
})

describe('createWorkspace happy path', () => {
  it('adds a worktree under the project subfolder and persists a setting_up workspace', async () => {
    const ws = await createWorkspace('p1', 'feature-x', 'main')
    expect(ws.status).toBe('setting_up')
    expect(ws.projectId).toBe('p1')
    expect(ws.name).toBe('feature-x')
    expect(ws.branch).toBe('feature-x')
    expect(ws.baseBranch).toBe('main')
    expect(ws.port).toBe(3010)
    expect(ws.path).toBe('/wt/proj/feature-x')
    expect(ws.id).toBeTruthy()
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/proj/feature-x', 'feature-x', 'main')
    expect(store.addWorkspace).toHaveBeenCalledWith(ws)
  })

  it('leaves baseBranch undefined when not given', async () => {
    const ws = await createWorkspace('p1', 'feature-y')
    expect(ws.baseBranch).toBeUndefined()
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/proj/feature-y', 'feature-y', undefined)
  })

  it('deduplicates the worktree path against existing dirs on disk', async () => {
    fsm.existsSync.mockImplementation((p: string) => p === '/wt/proj/feat')
    const ws = await createWorkspace('p1', 'feat')
    expect(ws.path).toBe('/wt/proj/feat-2')
  })
})

describe('createWorkspace with an existing branch', () => {
  it('checks out the branch in place without creating a new one', async () => {
    git.branchExists.mockResolvedValue(true)
    const ws = await createWorkspace('p1', 'feature-x', undefined, true)
    expect(ws.branch).toBe('feature-x')
    // No base is recorded — the worktree simply stays on the branch.
    expect(ws.baseBranch).toBeUndefined()
    expect(git.worktreeAddExisting).toHaveBeenCalledWith('/repo', '/wt/proj/feature-x', 'feature-x')
    expect(git.worktreeAdd).not.toHaveBeenCalled()
  })

  it('throws when the selected branch does not exist', async () => {
    git.branchExists.mockResolvedValue(false)
    await expect(createWorkspace('p1', 'ghost', undefined, true)).rejects.toThrow(/does not exist/)
  })

  it('rejects a branch that already backs a workspace', async () => {
    git.branchExists.mockResolvedValue(true)
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', name: 'feat', branch: 'feat' })])
    await expect(createWorkspace('p1', 'feat', undefined, true)).rejects.toThrow(/already exists/)
  })
})

describe('finishSetup', () => {
  it('runs the setup script, flips to active, starts claude and notifies', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    const onChange = vi.fn()
    ptym.runTask.mockResolvedValue(0)
    await finishSetup('a', onChange)
    expect(ptym.runTask).toHaveBeenCalledWith(expect.objectContaining({ scriptPath: '/setup.sh' }))
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
    // Setup is reset to pending while it runs, then resolved by the exit code.
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'pending')
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'success')
  })

  it('marks setup as error when the setup script exits non-zero', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    ptym.runTask.mockResolvedValue(1)
    await finishSetup('a', vi.fn())
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'error')
    expect(store.updateWorkspaceSetupStatus).not.toHaveBeenCalledWith('a', 'success')
  })

  it('starts claude immediately, in parallel with (not after) the setup script', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    // Hold the setup script open so it never resolves during the assertions.
    let resolveTask: (code: number) => void = () => {}
    ptym.runTask.mockReturnValue(
      new Promise<number>((res) => {
        resolveTask = res
      })
    )
    const onChange = vi.fn()
    const pending = finishSetup('a', onChange)
    // The window must open without waiting for setup: claude + active + notify
    // have all happened even though the setup task is still running.
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(onChange).toHaveBeenCalled()
    expect(ptym.runTask).toHaveBeenCalled()
    // claude was spawned before the setup task was launched.
    expect(ptym.startClaude.mock.invocationCallOrder[0]).toBeLessThan(
      ptym.runTask.mock.invocationCallOrder[0]
    )
    resolveTask(0)
    await pending
  })

  it('passes the configured claude args through to startClaude', async () => {
    store._set({ ...settings, claudeArgs: '--dangerously-skip-permissions' }, [mkProject()], [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    await finishSetup('a', vi.fn())
    expect(ptym.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', args: '--dangerously-skip-permissions' })
    )
  })

  it('still activates and starts claude even when the setup script fails', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    ptym.runTask.mockRejectedValue(new Error('boom'))
    const onChange = vi.fn()
    // claude/active/notify happen before the setup task is awaited, so the
    // rejection still propagates afterwards — finishSetup is fire-and-forget in ipc.ts.
    await expect(finishSetup('a', onChange)).rejects.toThrow('boom')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('skips the setup script when none is configured (setup counts as success)', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'setting_up' })])
    await finishSetup('a', vi.fn())
    expect(ptym.runTask).not.toHaveBeenCalled()
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'success')
  })

  it('returns without throwing for an unknown id', async () => {
    await expect(finishSetup('nope', vi.fn())).resolves.toBeUndefined()
    expect(ptym.startClaude).not.toHaveBeenCalled()
  })

  it('returns without starting claude when the project is gone', async () => {
    store._set({ ...settings }, [], [mkWs({ id: 'a', status: 'setting_up', projectId: 'gone' })])
    await expect(finishSetup('a', vi.fn())).resolves.toBeUndefined()
    expect(ptym.startClaude).not.toHaveBeenCalled()
  })
})

describe('restoreSessions healing matrix', () => {
  it('reconciles transient states and restarts claude only for live worktrees', () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'archived', status: 'archived', path: '/wt/proj/archived' }),
      mkWs({ id: 'arch-gone', status: 'archiving', path: '/wt/proj/arch-gone' }),
      mkWs({ id: 'arch-live', status: 'archiving', path: '/wt/proj/arch-live' }),
      mkWs({ id: 'setup-live', status: 'setting_up', path: '/wt/proj/setup-live' }),
      mkWs({ id: 'active-live', status: 'active', path: '/wt/proj/active-live' }),
      mkWs({ id: 'active-gone', status: 'active', path: '/wt/proj/active-gone' })
    ])
    const present = new Set(['/wt/proj/arch-live', '/wt/proj/setup-live', '/wt/proj/active-live'])
    fsm.existsSync.mockImplementation((p: string) => present.has(p))

    restoreSessions()

    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('arch-gone', 'archived')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('arch-live', 'active')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('setup-live', 'active')
    // archived is skipped entirely.
    expect(store.updateWorkspaceStatus).not.toHaveBeenCalledWith('archived', expect.anything())

    const started = ptym.startClaude.mock.calls.map((c) => c[0].id)
    expect(started.sort()).toEqual(['active-live', 'arch-live', 'setup-live'])
  })

  it('restarts claude with the configured args', () => {
    store._set({ ...settings, claudeArgs: '--dangerously-skip-permissions' }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', path: '/wt/proj/a' })
    ])
    fsm.existsSync.mockReturnValue(true)
    restoreSessions()
    expect(ptym.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', args: '--dangerously-skip-permissions' })
    )
  })

  it('skips workspaces whose project is gone', () => {
    store._set({ ...settings }, [], [mkWs({ id: 'a', status: 'active', projectId: 'gone' })])
    fsm.existsSync.mockReturnValue(true)
    restoreSessions()
    expect(ptym.startClaude).not.toHaveBeenCalled()
  })

  it('marks a setup left pending (killed by the quit) as failed', () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', path: '/wt/proj/a', setupStatus: 'pending' }),
      mkWs({ id: 'b', status: 'active', path: '/wt/proj/b', setupStatus: 'success' })
    ])
    fsm.existsSync.mockReturnValue(true)
    restoreSessions()
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'error')
    // A resolved setup is left untouched.
    expect(store.updateWorkspaceSetupStatus).not.toHaveBeenCalledWith('b', expect.anything())
  })
})

describe('runWorkspace', () => {
  it('throws when the workspace is missing', async () => {
    await expect(runWorkspace('nope')).rejects.toThrow(/not found/)
  })
  it('throws when no run script is configured', async () => {
    store._set({ ...settings }, [mkProject({ runScript: '' })], [mkWs({ id: 'a' })])
    await expect(runWorkspace('a')).rejects.toThrow(/No run script/)
  })
  it('runs the run script as a tracked task', async () => {
    store._set({ ...settings }, [mkProject({ runScript: '/run.sh' })], [mkWs({ id: 'a' })])
    await runWorkspace('a')
    expect(ptym.runTask).toHaveBeenCalledWith(
      expect.objectContaining({ scriptPath: '/run.sh', track: true })
    )
  })
})

describe('beginArchive', () => {
  it('stops the task and flips status to archiving', () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'active' })])
    beginArchive('a')
    expect(ptym.stopTask).toHaveBeenCalledWith('a')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'archiving')
  })
  it('is a no-op for an unknown id', () => {
    beginArchive('nope')
    expect(ptym.stopTask).not.toHaveBeenCalled()
    expect(store.updateWorkspaceStatus).not.toHaveBeenCalled()
  })
})

describe('finishArchive', () => {
  it('runs the archive script, kills PTYs, removes the worktree and archives', async () => {
    store._set({ ...settings }, [mkProject({ archiveScript: '/arch.sh' })], [
      mkWs({ id: 'a', status: 'archiving' })
    ])
    const onChange = vi.fn()
    await finishArchive('a', onChange)
    expect(ptym.runTask).toHaveBeenCalledWith(expect.objectContaining({ scriptPath: '/arch.sh' }))
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/proj/ws')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'archived')
    expect(onChange).toHaveBeenCalled()
  })

  it('still archives and notifies when a step throws', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'archiving' })])
    git.worktreeRemove.mockRejectedValue(new Error('busy'))
    const onChange = vi.fn()
    await finishArchive('a', onChange)
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'archived')
    expect(onChange).toHaveBeenCalled()
  })

  it('is a no-op for an unknown id', async () => {
    await finishArchive('nope', vi.fn())
    expect(store.updateWorkspaceStatus).not.toHaveBeenCalled()
  })
})

describe('restoreWorktree', () => {
  it('throws when the repo is invalid', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'archived' })])
    git.isGitRepo.mockResolvedValue(false)
    await expect(restoreWorktree('a')).rejects.toThrow(/not a git repository/)
  })

  it('re-adds on the existing branch and flips to setting_up', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'archived', branch: 'feat' })
    ])
    git.branchExists.mockResolvedValue(true)
    await restoreWorktree('a')
    expect(git.worktreePrune).toHaveBeenCalled()
    expect(git.worktreeAddExisting).toHaveBeenCalledWith('/repo', '/wt/proj/ws', 'feat')
    expect(git.worktreeAdd).not.toHaveBeenCalled()
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'setting_up')
  })

  it('recreates the branch fresh when it was deleted out-of-band', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'archived', branch: 'feat' })
    ])
    git.branchExists.mockResolvedValue(false)
    await restoreWorktree('a')
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/proj/ws', 'feat')
    expect(git.worktreeAddExisting).not.toHaveBeenCalled()
  })

  it('removes a leftover worktree directory before re-adding', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'archived', branch: 'feat' })
    ])
    fsm.existsSync.mockReturnValue(true)
    git.branchExists.mockResolvedValue(true)
    await restoreWorktree('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/proj/ws')
  })
})

describe('deleteArchivedWorkspace', () => {
  it('kills PTYs, removes leftover worktree, deletes the branch and drops it', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'archived', branch: 'feat' })
    ])
    fsm.existsSync.mockReturnValue(true)
    await deleteArchivedWorkspace('a')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/proj/ws')
    expect(git.branchDelete).toHaveBeenCalledWith('/repo', 'feat')
    expect(store.removeWorkspace).toHaveBeenCalledWith('a')
  })

  it('still removes from the store when the branch is already gone', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'archived', branch: 'feat' })
    ])
    git.branchDelete.mockRejectedValue(new Error('not found'))
    await deleteArchivedWorkspace('a')
    expect(store.removeWorkspace).toHaveBeenCalledWith('a')
  })

  it('is a no-op for an unknown id', async () => {
    await deleteArchivedWorkspace('nope')
    expect(ptym.killWorkspace).not.toHaveBeenCalled()
    expect(store.removeWorkspace).not.toHaveBeenCalled()
  })
})
