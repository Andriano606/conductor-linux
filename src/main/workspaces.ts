import { randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Workspace } from '../shared/types'
import {
  addWorkspace,
  getSettings,
  getWorkspace,
  getWorkspaces,
  nextPort,
  removeWorkspace,
  updateWorkspaceStatus
} from './store'
import {
  branchDelete,
  branchExists,
  isGitRepo,
  worktreeAdd,
  worktreeAddExisting,
  worktreePrune,
  worktreeRemove
} from './git'
import { buildEnv } from './env'
import { runTask, startClaude, killWorkspace, stopTask } from './ptyManager'

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  )
}

/**
 * Create a workspace: add a git worktree + branch and persist it. Returns
 * immediately with status 'setting_up' so the UI does not block. The setup
 * script and Claude session are started afterwards via finishSetup().
 */
export async function createWorkspace(name: string): Promise<Workspace> {
  const settings = getSettings()
  if (!(await isGitRepo(settings.repoPath))) {
    throw new Error('Repository path is not a git repository. Set it in Settings.')
  }

  const slug = slugify(name)
  const taken = new Set(getWorkspaces().map((w) => w.path))
  // Find a name free in app state, on disk, and in git (a branch may linger
  // from an archived workspace, since archive keeps the branch).
  let candidate = slug
  let wtPath = join(settings.worktreesDir, candidate)
  let branch = `conductor/${candidate}`
  let suffix = 2
  while (
    taken.has(wtPath) ||
    existsSync(wtPath) ||
    (await branchExists(settings.repoPath, branch))
  ) {
    candidate = `${slug}-${suffix}`
    wtPath = join(settings.worktreesDir, candidate)
    branch = `conductor/${candidate}`
    suffix++
  }

  mkdirSync(settings.worktreesDir, { recursive: true })
  await worktreeAdd(settings.repoPath, wtPath, branch)

  const ws: Workspace = {
    id: randomUUID(),
    // Use the deduplicated slug so the name matches the real worktree dir/branch
    // (e.g. "porto-2" when "porto" was taken), not the raw input.
    name: candidate,
    branch,
    path: wtPath,
    port: nextPort(),
    createdAt: Date.now(),
    status: 'setting_up'
  }
  addWorkspace(ws)
  return ws
}

/**
 * Run the setup script (streaming to the "task" terminal) and then start the
 * Claude session. Runs in the background after createWorkspace returns; calls
 * onChange when the status flips to 'active' so the UI can refresh.
 */
export async function finishSetup(id: string, onChange: () => void): Promise<void> {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) return
  const env = buildEnv(ws, settings)
  try {
    if (settings.setupScript) {
      await runTask({
        id: ws.id,
        scriptPath: settings.setupScript,
        label: 'setup',
        cwd: ws.path,
        env,
        cols: 80,
        rows: 24
      })
    }
  } finally {
    updateWorkspaceStatus(ws.id, 'active')
    startClaude({ id: ws.id, cwd: ws.path, env, cols: 80, rows: 24 })
    onChange()
  }
}

/**
 * Re-start the Claude session for every active workspace whose worktree still
 * exists. Called on app launch so the consoles come back after a restart (PTYs
 * live only in memory and are killed when the app closes). Idempotent.
 */
export function restoreSessions(): void {
  const settings = getSettings()
  for (const ws of getWorkspaces()) {
    if (ws.status !== 'active') continue
    if (!existsSync(ws.path)) continue
    startClaude({ id: ws.id, cwd: ws.path, env: buildEnv(ws, settings), cols: 80, rows: 24 })
  }
}

/** Run the configured run script in the workspace (does not wait for it). */
export async function runWorkspace(id: string): Promise<void> {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) throw new Error('Workspace not found')
  if (!settings.runScript) throw new Error('No run script configured. Set it in Settings.')
  void runTask({
    id: ws.id,
    scriptPath: settings.runScript,
    label: 'run',
    cwd: ws.path,
    env: buildEnv(ws, settings),
    cols: 80,
    rows: 24,
    track: true
  })
}

/** Mark a workspace as archiving so the UI updates immediately (non-blocking). */
export function beginArchive(id: string): void {
  if (!getWorkspace(id)) return
  // Stop the running app (run server) right away if it's up, so its port frees
  // and the archive script runs against a stopped app.
  stopTask(id)
  updateWorkspaceStatus(id, 'archiving')
}

/**
 * Run the archive script, kill PTYs and remove the worktree in the background.
 * Calls onChange when the workspace is finally dropped from the list.
 */
export async function finishArchive(id: string, onChange: () => void): Promise<void> {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) return

  try {
    if (settings.archiveScript) {
      await runTask({
        id: ws.id,
        scriptPath: settings.archiveScript,
        label: 'archive',
        cwd: ws.path,
        env: buildEnv(ws, settings),
        cols: 80,
        rows: 24
      })
    }
    killWorkspace(ws.id)
    await worktreeRemove(settings.repoPath, ws.path)
  } catch (err) {
    // Surface the error but still archive the workspace so the UI stays consistent.
    console.error('archive failed:', err)
  } finally {
    // Keep the workspace (and its git branch) so it can be restored later; the
    // worktree directory is gone but the branch lingers.
    updateWorkspaceStatus(ws.id, 'archived')
    onChange()
  }
}

/**
 * Re-create the worktree for an archived workspace on its existing branch and
 * flip it to 'setting_up'. The setup script + Claude session are started
 * afterwards via finishSetup(). Throws if the repo is missing.
 */
export async function restoreWorktree(id: string): Promise<void> {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) throw new Error('Workspace not found')
  if (!(await isGitRepo(settings.repoPath))) {
    throw new Error('Repository path is not a git repository. Set it in Settings.')
  }
  // Clean any stale worktree refs / leftover directory before re-adding.
  await worktreePrune(settings.repoPath)
  if (existsSync(ws.path)) {
    try {
      await worktreeRemove(settings.repoPath, ws.path)
    } catch {
      /* ignore — git will error on add if the path is truly unusable */
    }
  }
  if (await branchExists(settings.repoPath, ws.branch)) {
    await worktreeAddExisting(settings.repoPath, ws.path, ws.branch)
  } else {
    // Branch was deleted out-of-band; recreate it fresh.
    await worktreeAdd(settings.repoPath, ws.path, ws.branch)
  }
  updateWorkspaceStatus(id, 'setting_up')
}

/**
 * Permanently delete an archived workspace: kill PTYs, remove any leftover
 * worktree, delete the git branch and drop it from the store.
 */
export async function deleteArchivedWorkspace(id: string): Promise<void> {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) return
  killWorkspace(ws.id)
  if (existsSync(ws.path)) {
    try {
      await worktreeRemove(settings.repoPath, ws.path)
    } catch {
      /* ignore */
    }
  }
  try {
    await worktreePrune(settings.repoPath)
    await branchDelete(settings.repoPath, ws.branch)
  } catch (err) {
    // Branch may already be gone; deletion of the workspace should still proceed.
    console.error('delete branch failed:', err)
  }
  removeWorkspace(ws.id)
}
