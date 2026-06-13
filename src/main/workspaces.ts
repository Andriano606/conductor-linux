import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { basename, join } from 'path'
import { promisify } from 'util'
import type { ChatSession, Project, ProjectScripts, Workspace } from '../shared/types'
import {
  addProject,
  addSession,
  addWorkspace,
  findSession,
  getClaudeProfiles,
  getProject,
  getProjects,
  getSettings,
  getWorkspace,
  getWorkspaces,
  nextPort,
  removeProject,
  removeSession,
  removeWorkspace,
  renameSession,
  updateSessionClaudeParams,
  updateWorkspaceBranch,
  updateWorkspaceStatus,
  updateWorkspaceSetupStatus
} from './store'
import {
  branchDelete,
  branchExists,
  branchRename,
  currentBranch,
  fastForwardToRemote,
  fetchQuiet,
  isGitRepo,
  remoteBranchExists,
  worktreeAdd,
  worktreeAddExisting,
  worktreeAddFromRemote,
  worktreeGitDir,
  worktreePrune,
  worktreeRemove
} from './git'
import { startBranchWatch, stopBranchWatch } from './branchWatcher'
import { buildEnv } from './env'
import { focusTerminal, runTask, startShell, write, killWorkspace, stopTask } from './ptyManager'
import {
  chatInfo,
  deleteChatHistory,
  killChat,
  setChatConfigDir,
  startChat,
  stopChatProc
} from './claudeChat'
import { reapWorkspaceProcesses } from './procReaper'

/**
 * Spawn (idempotently) the Claude chat process for one session of a workspace,
 * wiring its cwd/env and the persisted resume id + model/effort/permission-mode.
 * The chat key is the session id.
 */
function startSessionChat(ws: Workspace, project: Project, session: ChatSession): void {
  // Resolve the session's config profile (if any) to its directory; a dangling
  // id (profile deleted) simply falls back to the default ~/.claude.
  const profile = session.claudeConfigProfileId
    ? getClaudeProfiles().find((p) => p.id === session.claudeConfigProfileId)
    : undefined
  startChat({
    id: session.id,
    cwd: ws.path,
    env: buildEnv(ws, project),
    args: getSettings().claudeArgs,
    resume: session.claudeSessionId,
    model: session.claudeModel,
    effort: session.claudeEffort,
    permissionMode: session.claudePermissionMode,
    configDir: profile?.path
  })
}

/**
 * Attach (or clear) a config profile on a session: persist the chosen profile id
 * and, if the session is running, restart it under the new CLAUDE_CONFIG_DIR
 * (resuming the conversation). Pass profileId = undefined to revert to default.
 */
export function setSessionProfile(sessionId: string, profileId: string | undefined): void {
  const found = findSession(sessionId)
  if (!found) return
  updateSessionClaudeParams(sessionId, { profileId })
  const profile = profileId ? getClaudeProfiles().find((p) => p.id === profileId) : undefined
  setChatConfigDir(sessionId, profile?.path, profile?.name ?? 'стандартний ~/.claude')
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  )
}

// ── Projects ──────────────────────────────────────────────────────────────────

/** Project display name is always derived from the repo folder name. */
export function projectNameFromPath(repoPath: string): string {
  return basename(repoPath.replace(/[/\\]+$/, '')) || 'project'
}

/**
 * Register a git repository as a project. Validates the path is a git repo and
 * isn't already registered, then persists it. The name comes from the repo
 * folder; the optional scripts seed the project's setup/run/archive scripts.
 */
export async function createProject(
  repoPath: string,
  scripts?: ProjectScripts
): Promise<Project> {
  const path = repoPath.trim()
  if (!path) throw new Error('Project path is required.')
  if (!(await isGitRepo(path))) {
    throw new Error('Selected folder is not a git repository.')
  }
  if (getProjects().some((p) => p.repoPath === path)) {
    throw new Error('A project for this repository already exists.')
  }
  const project: Project = {
    id: randomUUID(),
    name: projectNameFromPath(path),
    repoPath: path,
    setupScript: scripts?.setupScript?.trim() || '',
    runScript: scripts?.runScript?.trim() || '',
    archiveScript: scripts?.archiveScript?.trim() || '',
    browserHost: scripts?.browserHost?.trim() || '',
    createdAt: Date.now()
  }
  addProject(project)
  return project
}

/**
 * Permanently delete a project and every workspace under it: kill PTYs, remove
 * the worktrees, delete the git branches, then drop the project from the store.
 */
export async function deleteProject(id: string): Promise<void> {
  const project = getProject(id)
  if (!project) return
  for (const ws of getWorkspaces().filter((w) => w.projectId === id)) {
    for (const s of ws.sessions) {
      killChat(s.id)
      deleteChatHistory(s.id)
    }
    killWorkspace(ws.id)
    // Also kill any detached orphans (test runners, headless Chrome) the tracked
    // PTYs left behind, so they don't keep the worktree dir busy or hold ports.
    await reapWorkspaceProcesses(ws.path)
    if (existsSync(ws.path)) {
      try {
        await worktreeRemove(project.repoPath, ws.path)
      } catch {
        /* ignore — best effort */
      }
    }
    try {
      await worktreePrune(project.repoPath)
      await branchDelete(project.repoPath, ws.branch)
    } catch {
      /* branch may already be gone */
    }
    removeWorkspace(ws.id)
  }
  removeProject(id)
}

// ── Workspaces ──────────────────────────────────────────────────────────────

/**
 * Create a workspace under a project: add a git worktree + branch and persist
 * it. Returns immediately with status 'setting_up' so the UI does not block. The
 * setup script and Claude session are started afterwards via finishSetup().
 */
export async function createWorkspace(
  projectId: string,
  name: string,
  baseBranch?: string,
  useExistingBranch?: boolean
): Promise<Workspace> {
  const settings = getSettings()
  const project = getProject(projectId)
  if (!project) throw new Error('Project not found.')
  if (!(await isGitRepo(project.repoPath))) {
    throw new Error('Project path is not a git repository. Check the project settings.')
  }

  // No fetch here: it would freeze the modal for up to ~8.5s on submit. The
  // worktree is cut from the refs already on disk (kept fresh by the modal's
  // background fetch), and finishSetup does the fetch + fast-forward "pull
  // latest" in the background after the tabs are already live.

  // One field is both the display name and the full branch name (no forced prefix).
  // When checking out an existing branch, that branch name is also the workspace name.
  const branchName = name.trim()
  if (!branchName) throw new Error('Name is required.')
  // No other workspace in this project (active or archived) may reuse the name/branch.
  // This also enforces "can't pick a branch a workspace already exists for" in the
  // existing-branch flow, where branchName is the selected branch.
  if (
    getWorkspaces().some(
      (w) => w.projectId === projectId && (w.name === branchName || w.branch === branchName)
    )
  ) {
    throw new Error(`A workspace named "${branchName}" already exists.`)
  }
  // Existing-branch flow: the branch may live locally or only on origin (a
  // teammate's branch never checked out here) — the latter gets a local
  // tracking branch of the same name, so no new branch name is created.
  let existingIsLocal = false
  if (useExistingBranch) {
    existingIsLocal = await branchExists(project.repoPath, branchName)
    if (!existingIsLocal && !(await remoteBranchExists(project.repoPath, branchName))) {
      throw new Error(`Branch "${branchName}" does not exist.`)
    }
  } else if (await branchExists(project.repoPath, branchName)) {
    // New-branch flow: `git worktree add -b` would fail on a name that already exists.
    throw new Error(`Branch "${branchName}" already exists. Choose another name.`)
  }

  // Worktrees live under a per-project subfolder so names can't collide across
  // projects. The leaf is a filesystem-safe slug, deduped against state and disk.
  const baseDir = join(settings.worktreesDir, slugify(project.name))
  const slug = slugify(branchName)
  const taken = new Set(getWorkspaces().map((w) => w.path))
  let candidate = slug
  let wtPath = join(baseDir, candidate)
  let suffix = 2
  while (taken.has(wtPath) || existsSync(wtPath)) {
    candidate = `${slug}-${suffix}`
    wtPath = join(baseDir, candidate)
    suffix++
  }

  mkdirSync(baseDir, { recursive: true })
  if (useExistingBranch && existingIsLocal) {
    await worktreeAddExisting(project.repoPath, wtPath, branchName)
    // The fast-forward to origin/<branch> now happens in finishSetup's background
    // "pull latest" step (after a fresh fetch), so it's skipped here.
  } else if (useExistingBranch) {
    // Origin-only: cut the local tracking branch straight from the (just
    // fetched) origin ref — already at the remote tip, nothing to fast-forward.
    await worktreeAddFromRemote(project.repoPath, wtPath, branchName)
  } else {
    await worktreeAdd(project.repoPath, wtPath, branchName, baseBranch)
  }

  const ws: Workspace = {
    id: randomUUID(),
    projectId,
    // Name and branch are the same user-chosen value; the worktree dir uses the
    // slugified, deduped form on disk.
    name: branchName,
    branch: branchName,
    // No base when reusing an existing branch — the worktree simply stays on it.
    baseBranch: useExistingBranch ? undefined : baseBranch?.trim() || undefined,
    path: wtPath,
    port: nextPort(),
    createdAt: Date.now(),
    status: 'setting_up',
    // Setup hasn't run yet; finishSetup resolves this to success/error.
    setupStatus: 'pending',
    // Every workspace starts with one Claude chat session.
    sessions: [{ id: randomUUID(), createdAt: Date.now() }]
  }
  addWorkspace(ws)
  return ws
}

/**
 * Rename a workspace's git branch (`git branch -m`). Updates only `ws.branch`,
 * not the workspace display name (`ws.name`). Renames locally only — a branch
 * already pushed keeps its old name on origin; the returned `remoteExists` flags
 * that so the UI can prompt the user to re-push. Validates the new name is free:
 * not used by another workspace in the project and not an existing local branch.
 */
export async function renameWorkspaceBranch(
  id: string,
  newName: string
): Promise<{ remoteExists: boolean }> {
  const ws = getWorkspace(id)
  if (!ws) throw new Error('Workspace not found.')
  const project = getProject(ws.projectId)
  if (!project) throw new Error('Project not found.')

  const branch = newName.trim()
  if (!branch) throw new Error('Name is required.')
  const oldBranch = ws.branch
  if (branch === oldBranch) return { remoteExists: false } // no-op

  // No OTHER workspace in this project (active or archived) may reuse the name/branch.
  if (
    getWorkspaces().some(
      (w) => w.id !== id && w.projectId === ws.projectId && (w.name === branch || w.branch === branch)
    )
  ) {
    throw new Error(`A workspace named "${branch}" already exists.`)
  }
  if (await branchExists(project.repoPath, branch)) {
    throw new Error(`Branch "${branch}" already exists. Choose another name.`)
  }

  await branchRename(project.repoPath, oldBranch, branch)
  updateWorkspaceBranch(id, branch)
  // The old branch may have been pushed; its remote-tracking ref outlives the
  // local rename, so flag it for the user (we never touch origin ourselves).
  const remoteExists = await remoteBranchExists(project.repoPath, oldBranch)
  return { remoteExists }
}

/**
 * Reconcile a workspace's persisted branch with what is actually checked out in
 * its worktree (the user may `git checkout` in the terminal). Returns the live
 * branch; a detached HEAD (empty) is ignored, leaving ws.branch as-is. Returns
 * the persisted branch unchanged when the worktree is gone.
 */
export async function syncWorkspaceBranch(id: string): Promise<string> {
  const ws = getWorkspace(id)
  if (!ws) return ''
  const live = await currentBranch(ws.path)
  if (live && live !== ws.branch) updateWorkspaceBranch(id, live)
  return live || ws.branch
}

/** Reconcile after a watched HEAD change and notify only if the branch moved. */
async function reconcileWatchedBranch(id: string, onChange: () => void): Promise<void> {
  const before = getWorkspace(id)?.branch
  if (before === undefined) return
  await syncWorkspaceBranch(id)
  if (getWorkspace(id)?.branch !== before) onChange()
}

/**
 * Start watching a live workspace's HEAD so an out-of-band branch switch/rename
 * (a manual `git` in the terminal) reflects in the UI immediately. Best effort —
 * a not-yet-ready/removed worktree just skips. Idempotent per workspace id.
 */
async function startWatchingBranch(ws: Workspace, onChange: () => void): Promise<void> {
  try {
    const gitDir = await worktreeGitDir(ws.path)
    startBranchWatch(ws.id, gitDir, () => void reconcileWatchedBranch(ws.id, onChange))
  } catch {
    /* worktree gone / git error — leave it to the toolbar's focus refresh */
  }
}

/**
 * Start the Claude session immediately and run the setup script (streaming to
 * the "task" terminal) in parallel — the Claude window must not wait for setup
 * to finish. Runs in the background after createWorkspace returns; calls
 * onChange when the status flips to 'active' so the UI can refresh.
 */
export async function finishSetup(id: string, onChange: () => void): Promise<void> {
  const ws = getWorkspace(id)
  if (!ws) return
  const project = getProject(ws.projectId)
  if (!project) return
  const env = buildEnv(ws, project)
  // Flip to active and start Claude right away so the window opens without
  // blocking on the setup script.
  updateWorkspaceStatus(ws.id, 'active')
  // Reset to pending — matters on restore, where a prior success/error persists.
  updateWorkspaceSetupStatus(ws.id, 'pending')
  for (const session of ws.sessions) startSessionChat(ws, project, session)
  // Watch HEAD so a manual branch switch/rename in the terminal reflects at once.
  void startWatchingBranch(ws, onChange)
  onChange()
  // Pull the latest commits for this worktree's branch before setup runs. The UI
  // is already unblocked here (status active, Claude started, onChange fired), so
  // this best-effort fetch + fast-forward doesn't freeze the tabs. fastForward is
  // a no-op when there's no origin/<branch> (a genuine new branch) or on a
  // non-fast-forward, so it's safe for every create/restore flow.
  await fetchQuiet(project.repoPath)
  await fastForwardToRemote(ws.path, ws.branch)
  // Run the setup script alongside the now-live Claude session; its exit code
  // becomes the persisted setup indicator. No script ⇒ nothing to fail.
  if (project.setupScript) {
    const code = await runTask({
      id: ws.id,
      scriptPath: project.setupScript,
      label: 'setup',
      cwd: ws.path,
      env,
      cols: 80,
      rows: 24
    })
    updateWorkspaceSetupStatus(ws.id, code === 0 ? 'success' : 'error')
  } else {
    updateWorkspaceSetupStatus(ws.id, 'success')
  }
  onChange()
}

/**
 * Re-run only the project's setup script for a live workspace (e.g. after a
 * failed setup), streaming to the "task" terminal and re-persisting the outcome.
 * Unlike finishSetup it does NOT touch workspace status or the Claude sessions —
 * it just replays the script. No-ops if the workspace isn't active or the
 * project has no setup script.
 */
export async function rerunSetup(id: string, onChange: () => void): Promise<void> {
  const ws = getWorkspace(id)
  if (!ws || ws.status !== 'active') return
  const project = getProject(ws.projectId)
  if (!project?.setupScript) return
  const env = buildEnv(ws, project)
  updateWorkspaceSetupStatus(ws.id, 'pending')
  onChange()
  const code = await runTask({
    id: ws.id,
    scriptPath: project.setupScript,
    label: 'setup',
    cwd: ws.path,
    env,
    cols: 80,
    rows: 24
  })
  updateWorkspaceSetupStatus(ws.id, code === 0 ? 'success' : 'error')
  onChange()
}

/**
 * On app launch: resolve any workspace left in a transient state (the app was
 * closed mid-setup/mid-archive, which otherwise leaves it stuck forever), then
 * re-start the Claude session for every usable workspace. PTYs live only in
 * memory and are killed on quit, so consoles must be restarted. Idempotent.
 */
export async function restoreSessions(onChange: () => void = () => {}): Promise<void> {
  for (const ws of getWorkspaces()) {
    if (ws.status === 'archived') continue
    const project = getProject(ws.projectId)
    if (!project) continue
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
    // A setup left 'pending' means the script was killed mid-run by the quit —
    // its process is gone, so it can never resolve. Mark it failed (not a stuck
    // spinner) so the indicator reflects reality.
    if (ws.setupStatus === 'pending') updateWorkspaceSetupStatus(ws.id, 'error')
    if (!exists) continue
    // The previous session's PTYs were group-killed on quit, but processes that
    // detached into their own group (a test run still going, headless Chrome) — or
    // anything left when the app was closed with the window X — survive. Reap them
    // BEFORE starting Claude (whose env also carries our marker, so it must not be
    // running yet) to guarantee each workspace resumes from a clean slate.
    await reapWorkspaceProcesses(ws.path)
    // Pull in any out-of-band branch change (a manual `git checkout` in a prior
    // run) so archive/restore/delete operate on the branch actually checked out.
    await syncWorkspaceBranch(ws.id)
    void startWatchingBranch(ws, onChange)
    for (const session of ws.sessions) startSessionChat(ws, project, session)
  }
}

/**
 * Manually kill EVERY process running in a workspace: its tracked PTYs (Claude,
 * shell, the run/task script) plus any detached orphan still rooted in the
 * worktree (background test runners, headless Chrome) that the group-kill misses.
 * The user-facing "force-clean a stuck workspace" action. Returns how many orphan
 * pids were reaped beyond the tracked PTYs. Does not change the workspace status —
 * Claude can be restarted with ensureClaude/restoreSessions afterwards.
 */
export async function killWorkspaceProcesses(id: string): Promise<number> {
  const ws = getWorkspace(id)
  if (!ws) return 0
  stopTask(id)
  // Kill each chat session's process but keep its transcript — the session
  // restarts lazily (resuming the conversation) when its tab is next attached.
  for (const s of ws.sessions) stopChatProc(s.id)
  killWorkspace(id)
  const reaped = await reapWorkspaceProcesses(ws.path)
  return reaped.length
}

/**
 * Ensure the structured Claude chat session is running (idempotent). Takes a
 * *session* id. Called when a Claude tab attaches or a message is sent, so a
 * crashed/killed session restarts lazily, resuming its conversation.
 */
export function ensureClaudeChat(sessionId: string): void {
  const found = findSession(sessionId)
  if (!found) return
  const { ws, session } = found
  if (ws.status === 'archived' || !existsSync(ws.path)) return
  const project = getProject(ws.projectId)
  if (!project) return
  startSessionChat(ws, project, session)
}

/**
 * Add a new Claude chat session to a workspace, start it, and return it. The new
 * session begins with a fresh conversation and the workspace/global defaults
 * (no inherited model/effort/permission-mode).
 */
export function createChatSession(workspaceId: string): ChatSession | undefined {
  const ws = getWorkspace(workspaceId)
  if (!ws || ws.status === 'archived') return undefined
  const session = addSession(workspaceId)
  if (session) ensureClaudeChat(session.id)
  return session
}

/**
 * Close a chat session: kill its process, drop its transcript and remove it from
 * the workspace. Refuses to close the workspace's last remaining session.
 */
export function closeChatSession(sessionId: string): void {
  const found = findSession(sessionId)
  if (!found || found.ws.sessions.length <= 1) return
  killChat(sessionId)
  deleteChatHistory(sessionId)
  removeSession(sessionId)
}

/** Rename a chat session (empty title reverts it to the auto "Сесія N" label). */
export function renameChatSession(sessionId: string, title: string): void {
  renameSession(sessionId, title)
}

/**
 * Ensure a free interactive shell is running for the workspace (idempotent).
 * Called when the user opens the Terminal tab; restarts it if it had exited.
 */
export function ensureShell(id: string): void {
  const ws = getWorkspace(id)
  if (!ws) return
  const project = getProject(ws.projectId)
  if (!project) return
  startShell({ id: ws.id, cwd: ws.path, env: buildEnv(ws, project), cols: 80, rows: 24 })
}

const runCmd = promisify(execFile)

/** Single-quote a value so it survives `bash -c`. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Handle the auth local commands (/login, /logout, /status) for a chat session.
 * Acts on that session's Claude profile (its CLAUDE_CONFIG_DIR), so login/logout/
 * status target the right account. `login` is interactive (browser OAuth), so it
 * runs in the workspace shell and the UI is switched to the Terminal tab; logout
 * and status are quick and their output is reported back into the transcript.
 */
export function handleChatAuth(
  sessionId: string,
  action: 'login' | 'logout' | 'status',
  useConsole = false
): void {
  const found = findSession(sessionId)
  if (!found) return
  const { ws, session } = found
  const project = getProject(ws.projectId)
  if (!project) return
  if (ws.status === 'archived' || !existsSync(ws.path)) {
    chatInfo(sessionId, 'Робочий простір недоступний.')
    return
  }
  const configDir = session.claudeConfigProfileId
    ? getClaudeProfiles().find((p) => p.id === session.claudeConfigProfileId)?.path
    : undefined

  if (action === 'login') {
    ensureShell(ws.id) // idempotent; uses buildEnv
    const prefix = configDir ? `CLAUDE_CONFIG_DIR=${shq(configDir)} ` : ''
    write(ws.id, 'shell', `${prefix}claude auth login${useConsole ? ' --console' : ''}\n`)
    focusTerminal(ws.id, 'shell')
    chatInfo(
      sessionId,
      'Запускаю вхід у вкладці «Термінал». Після завершення перезапусти сесію (напр. /model), щоб застосувати нові облікові дані.'
    )
    return
  }

  // logout / status — quick, non-interactive. Run through a login shell (like the
  // chat proc) so `claude` resolves from PATH; buildEnv strips the AppImage leak
  // vars that would otherwise break the shell rc under the packaged app.
  const env = { ...buildEnv(ws, project), ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }
  const cmd = action === 'logout' ? 'claude auth logout' : 'claude auth status --text'
  runCmd('/bin/bash', ['-lc', cmd], { env, timeout: 15_000 })
    .then(({ stdout, stderr }) => chatInfo(sessionId, (stdout || stderr).trim() || 'Готово.'))
    .catch((err: { stderr?: string; message?: string }) =>
      chatInfo(sessionId, `Помилка: ${String(err?.stderr || err?.message || err).trim()}`)
    )
}

/** Run the configured run script in the workspace (does not wait for it). */
export async function runWorkspace(id: string): Promise<void> {
  const ws = getWorkspace(id)
  if (!ws) throw new Error('Workspace not found')
  const project = getProject(ws.projectId)
  if (!project) throw new Error('Project not found')
  if (!project.runScript) throw new Error('No run script configured. Set it in the project settings.')
  void runTask({
    id: ws.id,
    scriptPath: project.runScript,
    label: 'run',
    cwd: ws.path,
    env: buildEnv(ws, project),
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
  // The worktree (and its gitdir) is about to be removed — drop the HEAD watcher.
  stopBranchWatch(id)
  updateWorkspaceStatus(id, 'archiving')
}

/**
 * Run the archive script, kill PTYs and remove the worktree in the background.
 * Calls onChange when the workspace is finally dropped from the list.
 */
export async function finishArchive(id: string, onChange: () => void): Promise<void> {
  const ws = getWorkspace(id)
  if (!ws) return
  const project = getProject(ws.projectId)

  try {
    if (project?.archiveScript) {
      await runTask({
        id: ws.id,
        scriptPath: project.archiveScript,
        label: 'archive',
        cwd: ws.path,
        env: buildEnv(ws, project),
        cols: 80,
        rows: 24
      })
    }
    for (const s of ws.sessions) killChat(s.id)
    killWorkspace(ws.id)
    // Reap detached orphans before removing the worktree: a background test runner
    // still chdir'd inside it would otherwise survive and keep its DB/port handles.
    await reapWorkspaceProcesses(ws.path)
    if (project) await worktreeRemove(project.repoPath, ws.path)
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
  const ws = getWorkspace(id)
  if (!ws) throw new Error('Workspace not found')
  const project = getProject(ws.projectId)
  if (!project) throw new Error('Project not found')
  if (!(await isGitRepo(project.repoPath))) {
    throw new Error('Project path is not a git repository. Check the project settings.')
  }
  // Kill any processes orphaned by a previous instance of this workspace before
  // re-adding the worktree — a detached test runner left over from the prior run
  // can hold a DB lock (matched here via its " (deleted)" cwd) and wedge the new
  // setup script. Then clean stale worktree refs / leftover directory.
  await reapWorkspaceProcesses(ws.path)
  await worktreePrune(project.repoPath)
  if (existsSync(ws.path)) {
    try {
      await worktreeRemove(project.repoPath, ws.path)
    } catch {
      /* ignore — git will error on add if the path is truly unusable */
    }
  }
  if (await branchExists(project.repoPath, ws.branch)) {
    await worktreeAddExisting(project.repoPath, ws.path, ws.branch)
  } else {
    // Branch was deleted out-of-band; recreate it fresh.
    await worktreeAdd(project.repoPath, ws.path, ws.branch)
  }
  updateWorkspaceStatus(id, 'setting_up')
}

/**
 * Permanently delete an archived workspace: kill PTYs, remove any leftover
 * worktree, delete the git branch and drop it from the store.
 */
export async function deleteArchivedWorkspace(id: string): Promise<void> {
  const ws = getWorkspace(id)
  if (!ws) return
  stopBranchWatch(id)
  const project = getProject(ws.projectId)
  for (const s of ws.sessions) {
    killChat(s.id)
    // Permanent delete — the persisted chat history goes with it.
    deleteChatHistory(s.id)
  }
  killWorkspace(ws.id)
  await reapWorkspaceProcesses(ws.path)
  if (project && existsSync(ws.path)) {
    try {
      await worktreeRemove(project.repoPath, ws.path)
    } catch {
      /* ignore */
    }
  }
  if (project) {
    try {
      await worktreePrune(project.repoPath)
      await branchDelete(project.repoPath, ws.branch)
    } catch (err) {
      // Branch may already be gone; deletion of the workspace should still proceed.
      console.error('delete branch failed:', err)
    }
  }
  removeWorkspace(ws.id)
}
