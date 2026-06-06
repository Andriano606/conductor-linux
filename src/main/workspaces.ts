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
import { branchExists, isGitRepo, worktreeAdd, worktreeRemove } from './git'
import { buildEnv } from './env'
import { runTask, startClaude, killWorkspace } from './ptyManager'

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
    name: name.trim() || slug,
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
  if (getWorkspace(id)) updateWorkspaceStatus(id, 'archiving')
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
    // Surface the error but still drop the workspace so the UI stays consistent.
    console.error('archive failed:', err)
  } finally {
    removeWorkspace(ws.id)
    onChange()
  }
}
