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
import { runTask, startClaude, startShell, killWorkspace, stopTask } from './ptyManager'

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
export async function createWorkspace(name: string, baseBranch?: string): Promise<Workspace> {
  const settings = getSettings()
  if (!(await isGitRepo(settings.repoPath))) {
    throw new Error('Repository path is not a git repository. Set it in Settings.')
  }

  // One field is both the display name and the full branch name (no forced prefix).
  const branchName = name.trim()
  if (!branchName) throw new Error('Name is required.')
  // No other workspace (active or archived) may already use this name/branch.
  if (getWorkspaces().some((w) => w.name === branchName || w.branch === branchName)) {
    throw new Error(`A workspace named "${branchName}" already exists.`)
  }
  // The git branch must not already exist — `git worktree add -b` would fail.
  if (await branchExists(settings.repoPath, branchName)) {
    throw new Error(`Branch "${branchName}" already exists. Choose another name.`)
  }

  // The worktree directory is derived from a filesystem-safe slug and
  // deduplicated against app state and disk so checkouts never collide.
  const slug = slugify(branchName)
  const taken = new Set(getWorkspaces().map((w) => w.path))
  let candidate = slug
  let wtPath = join(settings.worktreesDir, candidate)
  let suffix = 2
  while (taken.has(wtPath) || existsSync(wtPath)) {
    candidate = `${slug}-${suffix}`
    wtPath = join(settings.worktreesDir, candidate)
    suffix++
  }

  mkdirSync(settings.worktreesDir, { recursive: true })
  await worktreeAdd(settings.repoPath, wtPath, branchName, baseBranch)

  const ws: Workspace = {
    id: randomUUID(),
    // Name and branch are the same user-chosen value; the worktree dir uses the
    // slugified, deduped form on disk.
    name: branchName,
    branch: branchName,
    baseBranch: baseBranch?.trim() || undefined,
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
 * On app launch: resolve any workspace left in a transient state (the app was
 * closed mid-setup/mid-archive, which otherwise leaves it stuck forever), then
 * re-start the Claude session for every usable workspace. PTYs live only in
 * memory and are killed on quit, so consoles must be restarted. Idempotent.
 */
export function restoreSessions(): void {
  const settings = getSettings()
  for (const ws of getWorkspaces()) {
    if (ws.status === 'archived') continue
    const exists = existsSync(ws.path)
    // Heal stuck transient states left by an interrupted setup/archive.
    if (ws.status === 'archiving') {
      // The archive didn't finish: if the worktree is gone it's effectively
      // archived; otherwise treat it as active so the user can retry.
      updateWorkspaceStatus(ws.id, exists ? 'active' : 'archived')
    } else if (ws.status === 'setting_up' && exists) {
      // Setup was interrupted; make the workspace usable instead of stuck.
      updateWorkspaceStatus(ws.id, 'active')
    }
    if (!exists) continue
    startClaude({ id: ws.id, cwd: ws.path, env: buildEnv(ws, settings), cols: 80, rows: 24 })
  }
}

/**
 * Ensure a free interactive shell is running for the workspace (idempotent).
 * Called when the user opens the Terminal tab; restarts it if it had exited.
 */
export function ensureShell(id: string): void {
  const settings = getSettings()
  const ws = getWorkspace(id)
  if (!ws) return
  startShell({ id: ws.id, cwd: ws.path, env: buildEnv(ws, settings), cols: 80, rows: 24 })
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
