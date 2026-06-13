import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TempRepo, tempPlainDir } from '../helpers/tempRepo'
import {
  branchDelete,
  branchExists,
  branchRename,
  checkedOutBranches,
  currentBranch,
  fastForwardToRemote,
  isGitRepo,
  listBranches,
  remoteBranchExists,
  worktreeAdd,
  worktreeAddExisting,
  worktreeAddFromRemote,
  worktreeGitDir,
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

describe('branchRename', () => {
  it('renames a local branch', async () => {
    repo.branch('old-name')
    await branchRename(repo.dir, 'old-name', 'new-name')
    expect(await branchExists(repo.dir, 'old-name')).toBe(false)
    expect(await branchExists(repo.dir, 'new-name')).toBe(true)
  })

  it('renames the branch checked out in a worktree, following its HEAD', async () => {
    const p = wtPath('wt-rename')
    await worktreeAdd(repo.dir, p, 'live')
    await branchRename(repo.dir, 'live', 'live-renamed')
    expect(await currentBranch(p)).toBe('live-renamed')
  })

  it('rejects renaming onto an existing branch name', async () => {
    repo.branch('one')
    repo.branch('two')
    await expect(branchRename(repo.dir, 'one', 'two')).rejects.toThrow()
  })
})

describe('worktreeGitDir', () => {
  it('resolves a linked worktree to its own gitdir (where HEAD lives)', async () => {
    const p = wtPath('wt-gitdir')
    await worktreeAdd(repo.dir, p, 'gd-branch')
    const gitDir = await worktreeGitDir(p)
    // A linked worktree's HEAD lives under <repo>/.git/worktrees/<name>, not <wt>/.git.
    expect(gitDir).toContain('worktrees')
    expect(existsSync(join(gitDir, 'HEAD'))).toBe(true)
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

  it('reports local branches in existingBranches', async () => {
    repo.branch('feature-a')
    const { existingBranches } = await listBranches(repo.dir)
    expect(existingBranches).toContain('main')
    expect(existingBranches).toContain('feature-a')
  })

  it('reports branches checked out in worktrees (incl. the main repo)', async () => {
    repo.branch('free-branch')
    const p = wtPath('wt-co')
    await worktreeAdd(repo.dir, p, 'wt-branch')
    const { checkedOut } = await listBranches(repo.dir)
    expect(checkedOut).toContain('main') // checked out in the main repo
    expect(checkedOut).toContain('wt-branch')
    expect(checkedOut).not.toContain('free-branch')
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
    const { branches, existingBranches, defaultBranch } = await listBranches(repo.dir)
    expect(defaultBranch).toBe('origin/main')
    expect(branches).toContain('origin/main')
    expect(branches.every((b) => !b.endsWith('/HEAD'))).toBe(true)
    // existingBranches carries plain names only — no 'origin/…' duplicates.
    expect(existingBranches).toContain('main')
    expect(existingBranches).not.toContain('origin/main')
    expect(existingBranches.filter((b) => b === 'main')).toHaveLength(1)
  })

  it('offers an origin-only branch (no local counterpart) in existingBranches', async () => {
    // Push a branch, then drop the local ref — only origin/remote-only is left.
    execFileSync('git', ['-C', repo.dir, 'branch', 'remote-only'])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'remote-only'])
    execFileSync('git', ['-C', repo.dir, 'branch', '-D', 'remote-only'])
    execFileSync('git', ['-C', repo.dir, 'fetch', '-q', 'origin'])
    const { existingBranches, checkedOut } = await listBranches(repo.dir)
    expect(existingBranches).toContain('remote-only')
    expect(checkedOut).not.toContain('remote-only')
  })

  it('skips the fetch with { fetch: false } — only refs already on disk show up', async () => {
    // A branch lands on origin but the local remote-tracking ref doesn't know it
    // yet (push then drop the local ref it created). With fetch:false the modal's
    // instant phase can't see it; only the default (fetch:true) re-discovers it.
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'main:appeared-on-origin'])
    execFileSync('git', ['-C', repo.dir, 'update-ref', '-d', 'refs/remotes/origin/appeared-on-origin'])
    const noFetch = await listBranches(repo.dir, { fetch: false })
    expect(noFetch.existingBranches).not.toContain('appeared-on-origin')
    const fetched = await listBranches(repo.dir, { fetch: true })
    expect(fetched.existingBranches).toContain('appeared-on-origin')
  })
})

describe('remoteBranchExists', () => {
  let remote: string
  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'conductor-remote-'))
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', remote])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'main'])
  })
  afterEach(() => rmSync(remote, { recursive: true, force: true }))

  it('is true for an origin branch and false otherwise', async () => {
    expect(await remoteBranchExists(repo.dir, 'main')).toBe(true)
    expect(await remoteBranchExists(repo.dir, 'nope')).toBe(false)
  })
})

describe('worktreeAddFromRemote', () => {
  let remote: string
  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), 'conductor-remote-'))
    execFileSync('git', ['init', '--bare', '-q', remote])
    execFileSync('git', ['-C', repo.dir, 'remote', 'add', 'origin', remote])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'main'])
  })
  afterEach(() => rmSync(remote, { recursive: true, force: true }))

  it('creates a local tracking branch from origin/<branch> and checks it out', async () => {
    // Make 'shared' exist only on origin.
    execFileSync('git', ['-C', repo.dir, 'branch', 'shared'])
    execFileSync('git', ['-C', repo.dir, 'push', '-q', 'origin', 'shared'])
    execFileSync('git', ['-C', repo.dir, 'branch', '-D', 'shared'])
    execFileSync('git', ['-C', repo.dir, 'fetch', '-q', 'origin'])
    expect(await branchExists(repo.dir, 'shared')).toBe(false)

    const p = wtPath('wt-from-remote')
    await worktreeAddFromRemote(repo.dir, p, 'shared')
    expect(await currentBranch(p)).toBe('shared')
    expect(await branchExists(repo.dir, 'shared')).toBe(true)
    const upstream = execFileSync(
      'git',
      ['-C', p, 'rev-parse', '--abbrev-ref', 'shared@{upstream}'],
      { encoding: 'utf8' }
    ).trim()
    expect(upstream).toBe('origin/shared')
  })
})

describe('checkedOutBranches', () => {
  it('lists every branch checked out in a worktree and skips detached HEADs', async () => {
    const p = wtPath('wt-co-1')
    await worktreeAdd(repo.dir, p, 'co-branch')
    execFileSync('git', ['-C', repo.dir, 'worktree', 'add', '--detach', wtPath('wt-co-det'), 'HEAD'])
    const out = await checkedOutBranches(repo.dir)
    expect(out).toContain('main')
    expect(out).toContain('co-branch')
    // The detached worktree contributes no branch name.
    expect(out).toHaveLength(2)
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
