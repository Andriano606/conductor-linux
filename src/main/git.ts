import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!repoPath) return false
  try {
    await run('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

/** True if a local branch with this name already exists in the repo. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Create a new worktree at wtPath on a fresh branch. Branches off `base` (a
 * local or remote-tracking ref like "main" or "origin/main") when given,
 * otherwise off the current HEAD.
 */
export async function worktreeAdd(
  repoPath: string,
  wtPath: string,
  branch: string,
  base?: string
): Promise<void> {
  const args = ['-C', repoPath, 'worktree', 'add', wtPath, '-b', branch]
  if (base) args.push(base)
  await run('git', args)
}

/**
 * List selectable base branches (local + remote-tracking), most-recently-committed
 * first, and the repo's default branch to preselect. Does a best-effort `git fetch`
 * first so remote branches are fresh; offline/no-remote just falls back to the
 * refs already on disk.
 */
export async function listBranches(
  repoPath: string
): Promise<{ branches: string[]; defaultBranch: string }> {
  try {
    await run('git', ['-C', repoPath, 'fetch', '--prune', '--quiet'], { timeout: 15000 })
  } catch {
    /* offline or no remote — use whatever refs we already have */
  }

  const { stdout } = await run('git', [
    '-C',
    repoPath,
    'for-each-ref',
    '--format=%(refname:short)',
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes'
  ])
  const branches = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => !b.endsWith('/HEAD'))

  let defaultBranch = ''
  try {
    const { stdout: sym } = await run('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD'
    ])
    defaultBranch = sym.trim()
  } catch {
    /* no origin/HEAD configured */
  }
  if (!defaultBranch) {
    try {
      const { stdout: cur } = await run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
      defaultBranch = cur.trim()
    } catch {
      /* detached HEAD */
    }
  }
  if (!defaultBranch && branches.length) defaultBranch = branches[0]

  return { branches, defaultBranch }
}

/** Add a worktree at wtPath checking out an already-existing branch. */
export async function worktreeAddExisting(
  repoPath: string,
  wtPath: string,
  branch: string
): Promise<void> {
  await run('git', ['-C', repoPath, 'worktree', 'add', wtPath, branch])
}

/** Remove a worktree directory (force, since it may contain untracked/build files). */
export async function worktreeRemove(repoPath: string, wtPath: string): Promise<void> {
  await run('git', ['-C', repoPath, 'worktree', 'remove', wtPath, '--force'])
}

/** Drop administrative references to worktrees whose directories are gone. */
export async function worktreePrune(repoPath: string): Promise<void> {
  await run('git', ['-C', repoPath, 'worktree', 'prune'])
}

/** Delete a local branch (force, ignoring merge state). */
export async function branchDelete(repoPath: string, branch: string): Promise<void> {
  await run('git', ['-C', repoPath, 'branch', '-D', branch])
}

/** Current branch checked out in a worktree ("HEAD detached…" → empty). */
export async function currentBranch(wtPath: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
    const b = stdout.trim()
    return b === 'HEAD' ? '' : b
  } catch {
    return ''
  }
}

export async function worktreeList(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list'])
  return stdout
}
