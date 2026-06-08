import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TempRepo, tempPlainDir } from '../helpers/tempRepo'
import {
  branchDelete,
  branchExists,
  currentBranch,
  fastForwardToRemote,
  isGitRepo,
  listBranches,
  worktreeAdd,
  worktreeAddExisting,
  worktreeList,
  worktreePrune,
  worktreeRemove
} from '../../src/main/git'

let repo: TempRepo
let wtBase: string
const wtPath = (name: string): string => join(wtBase, name)

beforeEach(() => {
  repo = TempRepo.create()
  wtBase = mkdtempSync(join(tmpdir(), 'conductor-wt-'))
})

afterEach(() => {
  repo.cleanup()
  rmSync(wtBase, { recursive: true, force: true })
})

describe('isGitRepo', () => {
  it('is true for a real repo', async () => {
    expect(await isGitRepo(repo.dir)).toBe(true)
  })
  it('is false for a plain directory', async () => {
    const plain = tempPlainDir()
    try {
      expect(await isGitRepo(plain.dir)).toBe(false)
    } finally {
      plain.cleanup()
    }
  })
  it('is false for an empty path', async () => {
    expect(await isGitRepo('')).toBe(false)
  })
})

describe('branchExists', () => {
  it('is true for an existing branch and false for a missing one', async () => {
    repo.branch('feature-x')
    expect(await branchExists(repo.dir, 'feature-x')).toBe(true)
    expect(await branchExists(repo.dir, 'nope')).toBe(false)
  })
})

describe('worktreeAdd', () => {
  it('creates a worktree on a fresh branch', async () => {
    const p = wtPath('wt1')
    await worktreeAdd(repo.dir, p, 'feature-1')
    expect(existsSync(p)).toBe(true)
    expect(await branchExists(repo.dir, 'feature-1')).toBe(true)
    expect(await currentBranch(p)).toBe('feature-1')
  })

  it('branches off the given base ref', async () => {
    repo.branch('base-b')
    repo.commit('only-on-main.txt', 'x', 'extra commit on main')
    const p = wtPath('wt-base')
    await worktreeAdd(repo.dir, p, 'from-base', 'base-b')
    // The new branch started from base-b, so the main-only file is absent.
    expect(existsSync(join(p, 'only-on-main.txt'))).toBe(false)
    expect(await branchExists(repo.dir, 'from-base')).toBe(true)
  })
})

describe('worktreeAddExisting', () => {
  it('checks out an existing branch into a new worktree', async () => {
    repo.branch('existing')
    const p = wtPath('wt-existing')
    await worktreeAddExisting(repo.dir, p, 'existing')
    expect(await currentBranch(p)).toBe('existing')
  })
})

describe('worktreeRemove', () => {
  it('force-removes a worktree even with untracked files', async () => {
    const p = wtPath('wt-rm')
    await worktreeAdd(repo.dir, p, 'rm-branch')
    writeFileSync(join(p, 'untracked.txt'), 'dirty')
    await worktreeRemove(repo.dir, p)
    expect(existsSync(p)).toBe(false)
  })
})

describe('worktreePrune', () => {
  it('drops admin refs after a worktree dir is deleted out-of-band', async () => {
    const p = wtPath('wt-prune')
    await worktreeAdd(repo.dir, p, 'prune-branch')
    rmSync(p, { recursive: true, force: true })
    // Still listed (stale) until pruned.
    expect(await worktreeList(repo.dir)).toContain('wt-prune')
    await worktreePrune(repo.dir)
    expect(await worktreeList(repo.dir)).not.toContain('wt-prune')
  })
})

describe('branchDelete', () => {
  it('removes a local branch', async () => {
    repo.branch('to-delete')
    expect(await branchExists(repo.dir, 'to-delete')).toBe(true)
    await branchDelete(repo.dir, 'to-delete')
    expect(await branchExists(repo.dir, 'to-delete')).toBe(false)
  })
})

describe('currentBranch', () => {
  it('returns the checked-out branch of a worktree', async () => {
    const p = wtPath('wt-cur')
    await worktreeAdd(repo.dir, p, 'cur-branch')
    expect(await currentBranch(p)).toBe('cur-branch')
  })

  it('returns empty string for a detached HEAD', async () => {
    const p = wtPath('wt-detached')
    execFileSync('git', ['-C', repo.dir, 'worktree', 'add', '--detach', p, 'HEAD'])
    expect(await currentBranch(p)).toBe('')
  })
})

describe('listBranches (offline, no remote)', () => {
  it('lists local branches and defaults to current HEAD', async () => {
    repo.branch('feature-a')
    repo.branch('feature-b')
    const { branches, defaultBranch } = await listBranches(repo.dir)
    expect(branches).toContain('main')
    expect(branches).toContain('feature-a')
    expect(branches).toContain('feature-b')
    // No origin/HEAD configured → falls back to the current branch.
    expect(defaultBranch).toBe('main')
    // No remote-tracking refs at all here, but ensure no '*/HEAD' leaks in.
    expect(branches.every((b) => !b.endsWith('/HEAD'))).toBe(true)
  })

  it('reports local branches in localBranches', async () => {
    repo.branch('feature-a')
    const { localBranches } = await listBranches(repo.dir)
    expect(localBranches).toContain('main')
    expect(localBranches).toContain('feature-a')
  })

  it('settles quickly with no remote configured', async () => {
    const start = Date.now()
    await listBranches(repo.dir)
    // fetchQuiet's hard deadline is 8.5s; with no remote it returns near-instantly.
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('listBranches (with a remote)', () => {
  let remote: string
  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'conductor-remote-'))
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', remote])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'main'])
    execFileSync('git', ['-C', repo.dir, 'remote', 'set-head', 'origin', 'main'])
    execFileSync('git', ['-C', repo.dir, 'fetch', '-q', 'origin'])
  })
  afterEach(() => rmSync(remote, { recursive: true, force: true }))

  it('derives default branch from origin/HEAD and filters out */HEAD refs', async () => {
    const { branches, localBranches, defaultBranch } = await listBranches(repo.dir)
    expect(defaultBranch).toBe('origin/main')
    expect(branches).toContain('origin/main')
    expect(branches.every((b) => !b.endsWith('/HEAD'))).toBe(true)
    // Remote-tracking refs are excluded from localBranches.
    expect(localBranches).toContain('main')
    expect(localBranches).not.toContain('origin/main')
  })
})

describe('fastForwardToRemote', () => {
  let remote: string
  let wt: string
  const headSha = (dir: string, ref: string): string =>
    execFileSync('git', ['-C', dir, 'rev-parse', ref], { encoding: 'utf8' }).trim()

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'conductor-remote-'))
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', remote])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'main'])
    wt = wtPath('wt-ff')
  })
  afterEach(() => rmSync(remote, { recursive: true, force: true }))

  it('advances a behind branch to origin/<branch> and returns true', async () => {
    // Push 'shared', then move origin/shared one commit ahead of the local ref.
    execFileSync('git', ['-C', repo.dir, 'branch', 'shared'])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'shared'])
    const c1 = headSha(repo.dir, 'shared')
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'shared'])
    repo.commit('remote-only.txt', 'x', 'remote commit')
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'shared'])
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'main'])
    execFileSync('git', ['-C', repo.dir, 'branch', '-f', 'shared', c1]) // rewind local

    await worktreeAddExisting(repo.dir, wt, 'shared')
    expect(existsSync(join(wt, 'remote-only.txt'))).toBe(false)
    expect(await fastForwardToRemote(wt, 'shared')).toBe(true)
    expect(existsSync(join(wt, 'remote-only.txt'))).toBe(true)
  })

  it('is a no-op (false) for a branch with no remote-tracking ref', async () => {
    repo.branch('local-only')
    await worktreeAddExisting(repo.dir, wt, 'local-only')
    expect(await fastForwardToRemote(wt, 'local-only')).toBe(false)
  })

  it('does not fast-forward a diverged branch and returns false', async () => {
    execFileSync('git', ['-C', repo.dir, 'branch', 'div'])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'div'])
    const c1 = headSha(repo.dir, 'div')
    // origin/div gets one commit...
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'div'])
    repo.commit('remote.txt', 'r', 'remote commit')
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'div'])
    // ...local div gets a DIFFERENT commit on top of c1 → diverged.
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'main'])
    execFileSync('git', ['-C', repo.dir, 'branch', '-f', 'div', c1])
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'div'])
    repo.commit('local.txt', 'l', 'local commit')
    execFileSync('git', ['-C', repo.dir, 'switch', '-q', 'main'])

    await worktreeAddExisting(repo.dir, wt, 'div')
    expect(await fastForwardToRemote(wt, 'div')).toBe(false)
    // Local commit kept; the remote commit was not merged in.
    expect(existsSync(join(wt, 'local.txt'))).toBe(true)
    expect(existsSync(join(wt, 'remote.txt'))).toBe(false)
  })
})
