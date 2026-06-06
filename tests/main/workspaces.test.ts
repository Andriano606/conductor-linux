import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings, Workspace } from '../../src/shared/types'

// ── Mocks ────────────────────────────────────────────────────────────────────
// In-memory store so status transitions are observable without touching disk.
const store = vi.hoisted(() => {
  let settings: Settings
  let workspaces: Workspace[] = []
  return {
    _set(s: Settings, ws: Workspace[]) {
      settings = s
      workspaces = ws
    },
    getSettings: vi.fn(() => settings),
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
  createWorkspace,
  deleteArchivedWorkspace,
  finishArchive,
  finishSetup,
  restoreSessions,
  restoreWorktree,
  runWorkspace,
  slugify
} from '../../src/main/workspaces'

const settings: Settings = {
  repoPath: '/repo',
  worktreesDir: '/wt',
  startPort: 3002,
  setupScript: '',
  runScript: '',
  archiveScript: '',
  ideCommand: '',
  claudeArgs: '--dangerously-skip-permissions'
}

const mkWs = (over: Partial<Workspace>): Workspace => ({
  id: 'id',
  name: 'ws',
  branch: 'ws',
  baseBranch: undefined,
  path: '/wt/ws',
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
  store._set({ ...settings }, [])
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

describe('createWorkspace validation', () => {
  it('throws when the repo is not a git repository', async () => {
    git.isGitRepo.mockResolvedValue(false)
    await expect(createWorkspace('x')).rejects.toThrow(/not a git repository/)
  })
  it('throws on an empty name', async () => {
    await expect(createWorkspace('   ')).rejects.toThrow(/Name is required/)
  })
  it('throws on a duplicate name/branch in the store', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', name: 'dup', branch: 'dup' })])
    await expect(createWorkspace('dup')).rejects.toThrow(/already exists/)
  })
  it('throws when the git branch already exists', async () => {
    git.branchExists.mockResolvedValue(true)
    await expect(createWorkspace('feat')).rejects.toThrow(/Branch .* already exists/)
  })
})

describe('createWorkspace happy path', () => {
  it('adds a worktree and persists a setting_up workspace', async () => {
    const ws = await createWorkspace('feature-x', 'main')
    expect(ws.status).toBe('setting_up')
    expect(ws.name).toBe('feature-x')
    expect(ws.branch).toBe('feature-x')
    expect(ws.baseBranch).toBe('main')
    expect(ws.port).toBe(3010)
    expect(ws.path).toBe('/wt/feature-x')
    expect(ws.id).toBeTruthy()
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/feature-x', 'feature-x', 'main')
    expect(store.addWorkspace).toHaveBeenCalledWith(ws)
  })

  it('leaves baseBranch undefined when not given', async () => {
    const ws = await createWorkspace('feature-y')
    expect(ws.baseBranch).toBeUndefined()
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/feature-y', 'feature-y', undefined)
  })

  it('deduplicates the worktree path against existing dirs on disk', async () => {
    fsm.existsSync.mockImplementation((p: string) => p === '/wt/feat')
    const ws = await createWorkspace('feat')
    expect(ws.path).toBe('/wt/feat-2')
  })
})

describe('finishSetup', () => {
  it('runs the setup script, flips to active, starts claude and notifies', async () => {
    store._set({ ...settings, setupScript: '/setup.sh' }, [mkWs({ id: 'a', status: 'setting_up' })])
    const onChange = vi.fn()
    await finishSetup('a', onChange)
    expect(ptym.runTask).toHaveBeenCalledWith(expect.objectContaining({ scriptPath: '/setup.sh' }))
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('starts claude immediately, in parallel with (not after) the setup script', async () => {
    store._set({ ...settings, setupScript: '/setup.sh' }, [mkWs({ id: 'a', status: 'setting_up' })])
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
    store._set({ ...settings, claudeArgs: '--dangerously-skip-permissions' }, [
      mkWs({ id: 'a', status: 'setting_up' })
    ])
    await finishSetup('a', vi.fn())
    expect(ptym.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', args: '--dangerously-skip-permissions' })
    )
  })

  it('still activates and starts claude even when the setup script fails', async () => {
    store._set({ ...settings, setupScript: '/setup.sh' }, [mkWs({ id: 'a', status: 'setting_up' })])
    ptym.runTask.mockRejectedValue(new Error('boom'))
    const onChange = vi.fn()
    // claude/active/notify happen before the setup task is awaited, so the
    // rejection still propagates afterwards — finishSetup is fire-and-forget in ipc.ts.
    await expect(finishSetup('a', onChange)).rejects.toThrow('boom')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(ptym.startClaude).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('skips the setup script when none is configured', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'setting_up' })])
    await finishSetup('a', vi.fn())
    expect(ptym.runTask).not.toHaveBeenCalled()
    expect(ptym.startClaude).toHaveBeenCalled()
  })

  it('returns without throwing for an unknown id', async () => {
    await expect(finishSetup('nope', vi.fn())).resolves.toBeUndefined()
    expect(ptym.startClaude).not.toHaveBeenCalled()
  })
})

describe('restoreSessions healing matrix', () => {
  it('reconciles transient states and restarts claude only for live worktrees', () => {
    store._set({ ...settings }, [
      mkWs({ id: 'archived', status: 'archived', path: '/wt/archived' }),
      mkWs({ id: 'arch-gone', status: 'archiving', path: '/wt/arch-gone' }),
      mkWs({ id: 'arch-live', status: 'archiving', path: '/wt/arch-live' }),
      mkWs({ id: 'setup-live', status: 'setting_up', path: '/wt/setup-live' }),
      mkWs({ id: 'active-live', status: 'active', path: '/wt/active-live' }),
      mkWs({ id: 'active-gone', status: 'active', path: '/wt/active-gone' })
    ])
    const present = new Set(['/wt/arch-live', '/wt/setup-live', '/wt/active-live'])
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
    store._set({ ...settings, claudeArgs: '--dangerously-skip-permissions' }, [
      mkWs({ id: 'a', status: 'active', path: '/wt/a' })
    ])
    fsm.existsSync.mockReturnValue(true)
    restoreSessions()
    expect(ptym.startClaude).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', args: '--dangerously-skip-permissions' })
    )
  })
})

describe('runWorkspace', () => {
  it('throws when the workspace is missing', async () => {
    await expect(runWorkspace('nope')).rejects.toThrow(/not found/)
  })
  it('throws when no run script is configured', async () => {
    store._set({ ...settings, runScript: '' }, [mkWs({ id: 'a' })])
    await expect(runWorkspace('a')).rejects.toThrow(/No run script/)
  })
  it('runs the run script as a tracked task', async () => {
    store._set({ ...settings, runScript: '/run.sh' }, [mkWs({ id: 'a' })])
    await runWorkspace('a')
    expect(ptym.runTask).toHaveBeenCalledWith(
      expect.objectContaining({ scriptPath: '/run.sh', track: true })
    )
  })
})

describe('beginArchive', () => {
  it('stops the task and flips status to archiving', () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'active' })])
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
    store._set({ ...settings, archiveScript: '/arch.sh' }, [mkWs({ id: 'a', status: 'archiving' })])
    const onChange = vi.fn()
    await finishArchive('a', onChange)
    expect(ptym.runTask).toHaveBeenCalledWith(expect.objectContaining({ scriptPath: '/arch.sh' }))
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/ws')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'archived')
    expect(onChange).toHaveBeenCalled()
  })

  it('still archives and notifies when a step throws', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archiving' })])
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
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived' })])
    git.isGitRepo.mockResolvedValue(false)
    await expect(restoreWorktree('a')).rejects.toThrow(/not a git repository/)
  })

  it('re-adds on the existing branch and flips to setting_up', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived', branch: 'feat' })])
    git.branchExists.mockResolvedValue(true)
    await restoreWorktree('a')
    expect(git.worktreePrune).toHaveBeenCalled()
    expect(git.worktreeAddExisting).toHaveBeenCalledWith('/repo', '/wt/ws', 'feat')
    expect(git.worktreeAdd).not.toHaveBeenCalled()
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'setting_up')
  })

  it('recreates the branch fresh when it was deleted out-of-band', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived', branch: 'feat' })])
    git.branchExists.mockResolvedValue(false)
    await restoreWorktree('a')
    expect(git.worktreeAdd).toHaveBeenCalledWith('/repo', '/wt/ws', 'feat')
    expect(git.worktreeAddExisting).not.toHaveBeenCalled()
  })

  it('removes a leftover worktree directory before re-adding', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived', branch: 'feat' })])
    fsm.existsSync.mockReturnValue(true)
    git.branchExists.mockResolvedValue(true)
    await restoreWorktree('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/ws')
  })
})

describe('deleteArchivedWorkspace', () => {
  it('kills PTYs, removes leftover worktree, deletes the branch and drops it', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived', branch: 'feat' })])
    fsm.existsSync.mockReturnValue(true)
    await deleteArchivedWorkspace('a')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/ws')
    expect(git.branchDelete).toHaveBeenCalledWith('/repo', 'feat')
    expect(store.removeWorkspace).toHaveBeenCalledWith('a')
  })

  it('still removes from the store when the branch is already gone', async () => {
    store._set({ ...settings }, [mkWs({ id: 'a', status: 'archived', branch: 'feat' })])
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
