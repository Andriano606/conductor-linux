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

/** Create a new worktree at wtPath on a fresh branch off the current HEAD. */
export async function worktreeAdd(repoPath: string, wtPath: string, branch: string): Promise<void> {
  await run('git', ['-C', repoPath, 'worktree', 'add', wtPath, '-b', branch])
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

export async function worktreeList(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'worktree', 'list'])
  return stdout
}
