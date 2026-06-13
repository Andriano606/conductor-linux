import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Settings, Workspace } from '../../src/shared/types'

// ── Mocks ────────────────────────────────────────────────────────────────────
// In-memory store so status transitions are observable without touching disk.
const store = vi.hoisted(() => {
  let settings: Settings
  let projects: Project[] = []
  let workspaces: Workspace[] = []
  let profiles: { id: string; name: string; path: string; createdAt: number }[] = []
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
    updateWorkspaceBranch: vi.fn((id: string, branch: string) => {
      const w = workspaces.find((x) => x.id === id)
      if (w) w.branch = branch
    }),
    updateWorkspaceSetupStatus: vi.fn((id: string, setupStatus: Workspace['setupStatus']) => {
      const w = workspaces.find((x) => x.id === id)
      if (w) w.setupStatus = setupStatus
    }),
    findSession: vi.fn((sessionId: string) => {
      for (const w of workspaces) {
        const session = w.sessions?.find((s) => s.id === sessionId)
        if (session) return { ws: w, session }
      }
      return undefined
    }),
    addSession: vi.fn((workspaceId: string) => {
      const w = workspaces.find((x) => x.id === workspaceId)
      if (!w) return undefined
      const session = { id: 's-' + (w.sessions.length + 1), createdAt: 0 }
      w.sessions.push(session)
      return session
    }),
    removeSession: vi.fn((sessionId: string) => {
      for (const w of workspaces) {
        if (w.sessions.length > 1 && w.sessions.some((s) => s.id === sessionId)) {
          w.sessions = w.sessions.filter((s) => s.id !== sessionId)
        }
      }
    }),
    renameSession: vi.fn(),
    updateSessionClaudeParams: vi.fn((sessionId: string, patch: { profileId?: string }) => {
      for (const w of workspaces) {
        const s = w.sessions?.find((x) => x.id === sessionId)
        if (s && 'profileId' in patch) s.claudeConfigProfileId = patch.profileId
      }
    }),
    getClaudeProfiles: vi.fn(() => profiles),
    nextPort: vi.fn(() => 3010),
    _setProfiles(ps: { id: string; name: string; path: string; createdAt: number }[]) {
      profiles = ps
    }
  }
})
vi.mock('../../src/main/store', () => store)

const git = vi.hoisted(() => ({
  isGitRepo: vi.fn(async () => true),
  branchExists: vi.fn(async () => false),
  branchRename: vi.fn(async () => {}),
  currentBranch: vi.fn(async () => ''),
  remoteBranchExists: vi.fn(async () => false),
  fetchQuiet: vi.fn(async () => {}),
  fastForwardToRemote: vi.fn(async () => false),
  worktreeAdd: vi.fn(async () => {}),
  worktreeAddExisting: vi.fn(async () => {}),
  worktreeAddFromRemote: vi.fn(async () => {}),
  worktreeGitDir: vi.fn(async () => '/repo/.git/worktrees/ws'),
  worktreePrune: vi.fn(async () => {}),
  worktreeRemove: vi.fn(async () => {}),
  branchDelete: vi.fn(async () => {})
}))
vi.mock('../../src/main/git', () => git)

const watcher = vi.hoisted(() => ({
  startBranchWatch: vi.fn(),
  stopBranchWatch: vi.fn(),
  stopAllBranchWatches: vi.fn()
}))
vi.mock('../../src/main/branchWatcher', () => watcher)

const ptym = vi.hoisted(() => ({
  runTask: vi.fn(async () => 0),
  startShell: vi.fn(),
  killWorkspace: vi.fn(),
  stopTask: vi.fn()
}))
vi.mock('../../src/main/ptyManager', () => ptym)

const chat = vi.hoisted(() => ({
  startChat: vi.fn(),
  killChat: vi.fn(),
  stopChatProc: vi.fn(),
  deleteChatHistory: vi.fn(),
  setChatConfigDir: vi.fn()
}))
vi.mock('../../src/main/claudeChat', () => chat)

const reaper = vi.hoisted(() => ({ reapWorkspaceProcesses: vi.fn(async () => [] as number[]) }))
vi.mock('../../src/main/procReaper', () => reaper)

const fsm = vi.hoisted(() => ({ existsSync: vi.fn(() => false), mkdirSync: vi.fn() }))
vi.mock('fs', () => fsm)

import {
  beginArchive,
  closeChatSession,
  createChatSession,
  createProject,
  createWorkspace,
  deleteArchivedWorkspace,
  deleteProject,
  finishArchive,
  finishSetup,
  killWorkspaceProcesses,
  projectNameFromPath,
  renameWorkspaceBranch,
  rerunSetup,
  restoreSessions,
  restoreWorktree,
  runWorkspace,
  setSessionProfile,
  slugify,
  syncWorkspaceBranch
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

const mkWs = (over: Partial<Workspace>): Workspace => {
  const id = over.id ?? 'id'
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
    // First session reuses the workspace id (migration convention) unless overridden.
    sessions: [{ id, createdAt: 0 }],
    ...over
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  git.isGitRepo.mockResolvedValue(true)
  git.branchExists.mockResolvedValue(false)
  git.branchRename.mockResolvedValue(undefined)
  git.currentBranch.mockResolvedValue('')
  git.remoteBranchExists.mockResolvedValue(false)
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
    expect(chat.deleteChatHistory).toHaveBeenCalledWith('a')
    expect(chat.deleteChatHistory).toHaveBeenCalledWith('b')
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

  it('does NOT fetch or fast-forward on the create path (moved to finishSetup)', async () => {
    // The blocking fetch + fast-forward "pull latest" now happen in the
    // background finishSetup, so the modal closes without an ~8.5s freeze.
    await createWorkspace('p1', 'feature-fresh', 'origin/main')
    expect(git.fetchQuiet).not.toHaveBeenCalled()
    expect(git.fastForwardToRemote).not.toHaveBeenCalled()
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
    // The fast-forward "pull latest" moved to finishSetup, so create stays fast.
    expect(git.fetchQuiet).not.toHaveBeenCalled()
    expect(git.fastForwardToRemote).not.toHaveBeenCalled()
  })

  it('checks out an origin-only branch via a local tracking branch', async () => {
    git.branchExists.mockResolvedValue(false)
    git.remoteBranchExists.mockResolvedValue(true)
    const ws = await createWorkspace('p1', 'teammate-br', undefined, true)
    expect(ws.branch).toBe('teammate-br')
    expect(git.worktreeAddFromRemote).toHaveBeenCalledWith(
      '/repo',
      '/wt/proj/teammate-br',
      'teammate-br'
    )
    expect(git.worktreeAddExisting).not.toHaveBeenCalled()
    expect(git.worktreeAdd).not.toHaveBeenCalled()
    // Cut straight from the fresh origin ref — no fast-forward needed.
    expect(git.fastForwardToRemote).not.toHaveBeenCalled()
  })

  it('throws when the selected branch exists neither locally nor on origin', async () => {
    git.branchExists.mockResolvedValue(false)
    git.remoteBranchExists.mockResolvedValue(false)
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
    expect(chat.startChat).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
    // Setup is reset to pending while it runs, then resolved by the exit code.
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'pending')
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'success')
  })

  it('pulls latest (fetch + fast-forward) before running the setup script', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'setting_up', path: '/wt/proj/a', branch: 'feature-x' })
    ])
    ptym.runTask.mockResolvedValue(0)
    await finishSetup('a', vi.fn())
    expect(git.fetchQuiet).toHaveBeenCalledWith('/repo')
    expect(git.fastForwardToRemote).toHaveBeenCalledWith('/wt/proj/a', 'feature-x')
    // The pull happens before the setup script launches.
    expect(git.fetchQuiet.mock.invocationCallOrder[0]).toBeLessThan(
      ptym.runTask.mock.invocationCallOrder[0]
    )
  })

  it('reapplies the persisted model/effort/plan mode (e.g. restored from archive)', async () => {
    // restoreWorktree flips an archived workspace to setting_up and calls
    // finishSetup, which must restart claude with the persisted params intact.
    store._set({ ...settings }, [mkProject()], [
      mkWs({
        id: 'a',
        status: 'setting_up',
        sessions: [
          {
            id: 'a',
            createdAt: 0,
            claudeSessionId: 'sess-9',
            claudeModel: 'opus[1m]',
            claudeEffort: 'max',
            claudePermissionMode: 'plan'
          }
        ]
      })
    ])
    await finishSetup('a', vi.fn())
    expect(chat.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a',
        resume: 'sess-9',
        model: 'opus[1m]',
        effort: 'max',
        permissionMode: 'plan'
      })
    )
  })

  it('resolves the session config profile to its CLAUDE_CONFIG_DIR path on start', async () => {
    // A session bound to a profile id must come back up under that profile's
    // directory (e.g. after archive→restore or an app relaunch).
    store._setProfiles([{ id: 'pr1', name: 'work', path: '/home/u/.claude-work', createdAt: 0 }])
    store._set({ ...settings }, [mkProject()], [
      mkWs({
        id: 'a',
        status: 'setting_up',
        sessions: [{ id: 'a', createdAt: 0, claudeConfigProfileId: 'pr1' }]
      })
    ])
    await finishSetup('a', vi.fn())
    expect(chat.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', configDir: '/home/u/.claude-work' })
    )
  })

  it('passes no configDir when the session has no (or a dangling) profile', async () => {
    store._setProfiles([])
    store._set({ ...settings }, [mkProject()], [
      mkWs({
        id: 'a',
        status: 'setting_up',
        sessions: [{ id: 'a', createdAt: 0, claudeConfigProfileId: 'gone' }]
      })
    ])
    await finishSetup('a', vi.fn())
    expect(chat.startChat).toHaveBeenCalledWith(expect.objectContaining({ configDir: undefined }))
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
    // The window must open without waiting for setup OR the background pull:
    // claude + active + notify have all happened synchronously even though the
    // setup task is still running.
    expect(chat.startChat).toHaveBeenCalled()
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'active')
    expect(onChange).toHaveBeenCalled()
    // The setup script only launches after the background fetch + fast-forward
    // "pull latest" (a couple of awaits), so flush microtasks first.
    await new Promise((r) => setTimeout(r, 0))
    expect(git.fetchQuiet).toHaveBeenCalledWith('/repo')
    expect(ptym.runTask).toHaveBeenCalled()
    // claude was spawned before the setup task was launched.
    expect(chat.startChat.mock.invocationCallOrder[0]).toBeLessThan(
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
    expect(chat.startChat).toHaveBeenCalledWith(
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
    expect(chat.startChat).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('skips the setup script when none is configured (setup counts as success)', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'setting_up' })])
    await finishSetup('a', vi.fn())
    expect(ptym.runTask).not.toHaveBeenCalled()
    expect(chat.startChat).toHaveBeenCalled()
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'success')
  })

  it('returns without throwing for an unknown id', async () => {
    await expect(finishSetup('nope', vi.fn())).resolves.toBeUndefined()
    expect(chat.startChat).not.toHaveBeenCalled()
  })

  it('returns without starting claude when the project is gone', async () => {
    store._set({ ...settings }, [], [mkWs({ id: 'a', status: 'setting_up', projectId: 'gone' })])
    await expect(finishSetup('a', vi.fn())).resolves.toBeUndefined()
    expect(chat.startChat).not.toHaveBeenCalled()
  })
})

describe('rerunSetup', () => {
  it('replays the setup script and re-persists success, without touching status or claude', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'active', setupStatus: 'error' })
    ])
    const onChange = vi.fn()
    ptym.runTask.mockResolvedValue(0)
    await rerunSetup('a', onChange)
    expect(ptym.runTask).toHaveBeenCalledWith(expect.objectContaining({ scriptPath: '/setup.sh' }))
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'pending')
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'success')
    // Re-run replays only the script — status stays put and claude is not restarted.
    expect(store.updateWorkspaceStatus).not.toHaveBeenCalled()
    expect(chat.startChat).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('re-persists error when the script exits non-zero', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'active', setupStatus: 'error' })
    ])
    ptym.runTask.mockResolvedValue(1)
    await rerunSetup('a', vi.fn())
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'error')
    expect(store.updateWorkspaceSetupStatus).not.toHaveBeenCalledWith('a', 'success')
  })

  it('no-ops when the project has no setup script', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '' })], [
      mkWs({ id: 'a', status: 'active', setupStatus: 'error' })
    ])
    await rerunSetup('a', vi.fn())
    expect(ptym.runTask).not.toHaveBeenCalled()
    expect(store.updateWorkspaceSetupStatus).not.toHaveBeenCalled()
  })

  it('no-ops when the workspace is not active', async () => {
    store._set({ ...settings }, [mkProject({ setupScript: '/setup.sh' })], [
      mkWs({ id: 'a', status: 'archived' })
    ])
    await rerunSetup('a', vi.fn())
    expect(ptym.runTask).not.toHaveBeenCalled()
  })

  it('returns without throwing for an unknown id', async () => {
    await expect(rerunSetup('nope', vi.fn())).resolves.toBeUndefined()
    expect(ptym.runTask).not.toHaveBeenCalled()
  })
})

describe('restoreSessions healing matrix', () => {
  it('reconciles transient states and restarts claude only for live worktrees', async () => {
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

    await restoreSessions()

    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('arch-gone', 'archived')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('arch-live', 'active')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('setup-live', 'active')
    // archived is skipped entirely.
    expect(store.updateWorkspaceStatus).not.toHaveBeenCalledWith('archived', expect.anything())

    const started = chat.startChat.mock.calls.map((c) => c[0].id)
    expect(started.sort()).toEqual(['active-live', 'arch-live', 'setup-live'])

    // Each live workspace has its orphaned processes reaped before Claude restarts.
    const reaped = reaper.reapWorkspaceProcesses.mock.calls.map((c) => c[0]).sort()
    expect(reaped).toEqual(['/wt/proj/active-live', '/wt/proj/arch-live', '/wt/proj/setup-live'])
    // The reap for a workspace must precede its Claude restart (env carries our
    // marker, so Claude must not be running when we scan).
    const reapOrder = reaper.reapWorkspaceProcesses.mock.invocationCallOrder[0]
    const startOrder = chat.startChat.mock.invocationCallOrder[0]
    expect(reapOrder).toBeLessThan(startOrder)
  })

  it('restarts claude with the configured args', async () => {
    store._set({ ...settings, claudeArgs: '--dangerously-skip-permissions' }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', path: '/wt/proj/a' })
    ])
    fsm.existsSync.mockReturnValue(true)
    await restoreSessions()
    expect(chat.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', args: '--dangerously-skip-permissions' })
    )
  })

  it('reapplies the persisted model/effort/plan mode on app restart', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({
        id: 'a',
        status: 'active',
        path: '/wt/proj/a',
        sessions: [
          {
            id: 'a',
            createdAt: 0,
            claudeSessionId: 'sess-1',
            claudeModel: 'sonnet',
            claudeEffort: 'high',
            claudePermissionMode: 'plan'
          }
        ]
      })
    ])
    fsm.existsSync.mockReturnValue(true)
    await restoreSessions()
    expect(chat.startChat).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'a',
        resume: 'sess-1',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'plan'
      })
    )
  })

  it('skips workspaces whose project is gone', async () => {
    store._set({ ...settings }, [], [mkWs({ id: 'a', status: 'active', projectId: 'gone' })])
    fsm.existsSync.mockReturnValue(true)
    await restoreSessions()
    expect(chat.startChat).not.toHaveBeenCalled()
  })

  it('marks a setup left pending (killed by the quit) as failed', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', path: '/wt/proj/a', setupStatus: 'pending' }),
      mkWs({ id: 'b', status: 'active', path: '/wt/proj/b', setupStatus: 'success' })
    ])
    fsm.existsSync.mockReturnValue(true)
    await restoreSessions()
    expect(store.updateWorkspaceSetupStatus).toHaveBeenCalledWith('a', 'error')
    // A resolved setup is left untouched.
    expect(store.updateWorkspaceSetupStatus).not.toHaveBeenCalledWith('b', expect.anything())
  })
})

describe('chat sessions', () => {
  it('createChatSession adds a session and starts its chat with the workspace cwd', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', path: '/wt/proj/a' })
    ])
    fsm.existsSync.mockReturnValue(true)
    const session = createChatSession('a')
    expect(session).toBeDefined()
    expect(store.getWorkspace('a')?.sessions).toHaveLength(2)
    // The new session is spawned (ensureClaudeChat → startChat) under its own id.
    expect(chat.startChat).toHaveBeenCalledWith(
      expect.objectContaining({ id: session!.id, cwd: '/wt/proj/a' })
    )
  })

  it('createChatSession refuses an archived workspace', () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'archived' })])
    expect(createChatSession('a')).toBeUndefined()
    expect(chat.startChat).not.toHaveBeenCalled()
  })

  it('closeChatSession kills the proc, drops history and removes the session', () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', sessions: [
        { id: 'a', createdAt: 0 },
        { id: 's2', createdAt: 0 }
      ] })
    ])
    closeChatSession('s2')
    expect(chat.killChat).toHaveBeenCalledWith('s2')
    expect(chat.deleteChatHistory).toHaveBeenCalledWith('s2')
    expect(store.getWorkspace('a')?.sessions.map((s) => s.id)).toEqual(['a'])
  })

  it('closeChatSession refuses to close the last remaining session', () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'active' })])
    closeChatSession('a')
    expect(chat.killChat).not.toHaveBeenCalled()
    expect(store.getWorkspace('a')?.sessions).toHaveLength(1)
  })

  it('setSessionProfile persists the profile id and restarts under its path + name', () => {
    store._setProfiles([{ id: 'pr1', name: 'work', path: '/home/u/.claude-work', createdAt: 0 }])
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', status: 'active' })])
    setSessionProfile('a', 'pr1')
    expect(store.updateSessionClaudeParams).toHaveBeenCalledWith('a', { profileId: 'pr1' })
    expect(store.getWorkspace('a')?.sessions[0].claudeConfigProfileId).toBe('pr1')
    expect(chat.setChatConfigDir).toHaveBeenCalledWith('a', '/home/u/.claude-work', 'work')
  })

  it('setSessionProfile with undefined clears the profile and reverts to default', () => {
    store._setProfiles([])
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', status: 'active', sessions: [{ id: 'a', createdAt: 0, claudeConfigProfileId: 'pr1' }] })
    ])
    setSessionProfile('a', undefined)
    expect(store.updateSessionClaudeParams).toHaveBeenCalledWith('a', { profileId: undefined })
    expect(chat.setChatConfigDir).toHaveBeenCalledWith('a', undefined, 'стандартний ~/.claude')
  })
})

describe('killWorkspaceProcesses', () => {
  it('stops the run, kills the PTYs, reaps orphans and returns the count', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', path: '/wt/proj/ws' })])
    reaper.reapWorkspaceProcesses.mockResolvedValueOnce([111, 222])
    const n = await killWorkspaceProcesses('a')
    expect(ptym.stopTask).toHaveBeenCalledWith('a')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(reaper.reapWorkspaceProcesses).toHaveBeenCalledWith('/wt/proj/ws')
    expect(n).toBe(2)
  })

  it('is a no-op returning 0 for an unknown id', async () => {
    store._set({ ...settings }, [mkProject()], [])
    expect(await killWorkspaceProcesses('nope')).toBe(0)
    expect(ptym.killWorkspace).not.toHaveBeenCalled()
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
    expect(watcher.stopBranchWatch).toHaveBeenCalledWith('a')
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
    expect(chat.killChat).toHaveBeenCalledWith('a')
    expect(ptym.killWorkspace).toHaveBeenCalledWith('a')
    expect(reaper.reapWorkspaceProcesses).toHaveBeenCalledWith('/wt/proj/ws')
    expect(git.worktreeRemove).toHaveBeenCalledWith('/repo', '/wt/proj/ws')
    expect(store.updateWorkspaceStatus).toHaveBeenCalledWith('a', 'archived')
    expect(onChange).toHaveBeenCalled()
    // Archiving keeps the persisted chat history — it reloads on restore.
    expect(chat.deleteChatHistory).not.toHaveBeenCalled()
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
    // Orphans from a prior instance are reaped before the worktree is re-added,
    // so a stale test runner can't hold a DB lock and wedge the new setup.
    expect(reaper.reapWorkspaceProcesses).toHaveBeenCalledWith('/wt/proj/ws')
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
    // Permanent delete also drops the persisted chat history.
    expect(chat.deleteChatHistory).toHaveBeenCalledWith('a')
    expect(reaper.reapWorkspaceProcesses).toHaveBeenCalledWith('/wt/proj/ws')
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

describe('renameWorkspaceBranch', () => {
  it('renames the git branch and updates ws.branch only (not ws.name)', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', name: 'feat', branch: 'feat' })])
    const res = await renameWorkspaceBranch('a', 'feat-2')
    expect(git.branchRename).toHaveBeenCalledWith('/repo', 'feat', 'feat-2')
    expect(store.updateWorkspaceBranch).toHaveBeenCalledWith('a', 'feat-2')
    const ws = store.getWorkspaces().find((w) => w.id === 'a')!
    expect(ws.branch).toBe('feat-2')
    expect(ws.name).toBe('feat') // display name untouched
    expect(res).toEqual({ remoteExists: false })
  })

  it('trims the new name', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    await renameWorkspaceBranch('a', '  feat-2  ')
    expect(git.branchRename).toHaveBeenCalledWith('/repo', 'feat', 'feat-2')
  })

  it('is a no-op when the name is unchanged', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    const res = await renameWorkspaceBranch('a', 'feat')
    expect(git.branchRename).not.toHaveBeenCalled()
    expect(res).toEqual({ remoteExists: false })
  })

  it('throws on an empty name', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    await expect(renameWorkspaceBranch('a', '   ')).rejects.toThrow(/required/)
  })

  it('rejects a name already used by another workspace in the project', async () => {
    store._set({ ...settings }, [mkProject()], [
      mkWs({ id: 'a', name: 'feat', branch: 'feat' }),
      mkWs({ id: 'b', name: 'other', branch: 'other' })
    ])
    await expect(renameWorkspaceBranch('a', 'other')).rejects.toThrow(/already exists/)
    expect(git.branchRename).not.toHaveBeenCalled()
  })

  it('rejects a name that already exists as a git branch', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    git.branchExists.mockResolvedValue(true)
    await expect(renameWorkspaceBranch('a', 'taken')).rejects.toThrow(/already exists/)
    expect(git.branchRename).not.toHaveBeenCalled()
  })

  it('reports remoteExists when the old branch was pushed', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    git.remoteBranchExists.mockResolvedValue(true)
    const res = await renameWorkspaceBranch('a', 'feat-2')
    expect(git.remoteBranchExists).toHaveBeenCalledWith('/repo', 'feat')
    expect(res).toEqual({ remoteExists: true })
  })
})

describe('syncWorkspaceBranch', () => {
  it('updates ws.branch when the worktree is on a different branch', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    git.currentBranch.mockResolvedValue('manual')
    const live = await syncWorkspaceBranch('a')
    expect(live).toBe('manual')
    expect(store.updateWorkspaceBranch).toHaveBeenCalledWith('a', 'manual')
  })

  it('leaves ws.branch unchanged on a detached HEAD (empty)', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    git.currentBranch.mockResolvedValue('')
    const live = await syncWorkspaceBranch('a')
    expect(live).toBe('feat')
    expect(store.updateWorkspaceBranch).not.toHaveBeenCalled()
  })

  it('does nothing when the live branch already matches', async () => {
    store._set({ ...settings }, [mkProject()], [mkWs({ id: 'a', branch: 'feat' })])
    git.currentBranch.mockResolvedValue('feat')
    await syncWorkspaceBranch('a')
    expect(store.updateWorkspaceBranch).not.toHaveBeenCalled()
  })
})
