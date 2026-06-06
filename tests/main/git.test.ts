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
    const { branches, defaultBranch } = await listBranches(repo.dir)
    expect(defaultBranch).toBe('origin/main')
    expect(branches).toContain('origin/main')
    expect(branches.every((b) => !b.endsWith('/HEAD'))).toBe(true)
  })
})
