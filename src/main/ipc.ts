import { spawn } from 'child_process'
import { BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { ChatAnswer, Project, ProjectScripts, PtyKind, Settings } from '../shared/types'
import {
  getProject,
  getProjects,
  getSettings,
  getWorkspace,
  getWorkspaces,
  setSettings,
  updateProject
} from './store'
import { currentBranch, isGitRepo, listBranches } from './git'
import { workspaceUrl } from '../shared/workspaceUrl'
import { attach, resize, stopTask, write } from './ptyManager'
import {
  beginArchive,
  createProject,
  createWorkspace,
  deleteArchivedWorkspace,
  deleteProject,
  ensureClaudeChat,
  ensureShell,
  finishArchive,
  finishSetup,
  killWorkspaceProcesses,
  projectNameFromPath,
  restoreWorktree,
  runWorkspace
} from './workspaces'
import { answerChat, attachChat, interruptChat, sendChatMessage } from './claudeChat'

function notifyWorkspacesChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspaces:changed', getWorkspaces())
  }
}

function notifyProjectsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('projects:changed', getProjects())
  }
}

export function registerIpc(): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, settings: Settings) => setSettings(settings))
  ipcMain.handle('settings:isGitRepo', (_e, path: string) => isGitRepo(path))
  ipcMain.handle('git:branches', (_e, projectId: string) => {
    const project = getProject(projectId)
    return project
      ? listBranches(project.repoPath)
      : { branches: [], existingBranches: [], checkedOut: [], defaultBranch: '' }
  })
  ipcMain.handle('git:currentBranch', (_e, id: string) => {
    const ws = getWorkspaces().find((w) => w.id === id)
    return ws ? currentBranch(ws.path) : ''
  })

  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- Projects ----
  ipcMain.handle('projects:list', () => getProjects())
  ipcMain.handle('project:create', async (_e, repoPath: string, scripts?: ProjectScripts) => {
    const project = await createProject(repoPath, scripts)
    notifyProjectsChanged()
    return project
  })
  ipcMain.handle('project:update', (_e, project: Project) => {
    // The name always tracks the repo folder, never hand-edited.
    const saved = updateProject({ ...project, name: projectNameFromPath(project.repoPath) })
    notifyProjectsChanged()
    return saved
  })
  ipcMain.handle('project:delete', async (_e, id: string) => {
    await deleteProject(id)
    notifyProjectsChanged()
    notifyWorkspacesChanged()
  })

  // ---- Workspaces ----
  ipcMain.handle('workspaces:list', () => getWorkspaces())

  ipcMain.handle(
    'workspace:create',
    async (_e, projectId: string, name: string, baseBranch?: string, useExistingBranch?: boolean) => {
    const ws = await createWorkspace(projectId, name, baseBranch, useExistingBranch)
    notifyWorkspacesChanged()
    // Run setup + start Claude in the background so the UI never blocks.
    void finishSetup(ws.id, notifyWorkspacesChanged)
    return ws
    }
  )

  ipcMain.handle('workspace:run', async (_e, id: string) => {
    await runWorkspace(id)
  })

  ipcMain.handle('workspace:stop', (_e, id: string) => stopTask(id))

  // Force-clean a stuck workspace: kill its tracked PTYs plus any detached orphan
  // (test runners, headless Chrome) still rooted in the worktree. Returns the
  // orphan count so the UI can report what it cleared.
  ipcMain.handle('workspace:killProcesses', async (_e, id: string) => {
    const reaped = await killWorkspaceProcesses(id)
    notifyWorkspacesChanged()
    return reaped
  })

  // Open the workspace's running app (served on its CONDUCTOR_PORT) in the
  // system's default browser.
  ipcMain.handle('workspace:openInBrowser', (_e, id: string) => {
    const ws = getWorkspace(id)
    if (ws) void shell.openExternal(workspaceUrl(getProject(ws.projectId)?.browserHost, ws.port))
  })

  // Open the workspace's worktree in the configured IDE. Runs through a login
  // shell so editor launchers on PATH (code, cursor, subl, …) resolve, and is
  // detached so the IDE outlives this app.
  ipcMain.handle('workspace:openInIde', (_e, id: string) => {
    const ws = getWorkspace(id)
    const ide = getSettings().ideCommand
    if (!ws || !ide) return
    const child = spawn('/bin/bash', ['-lc', `${ide} ${JSON.stringify(ws.path)}`], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  })

  ipcMain.handle('workspace:archive', (_e, id: string) => {
    // Non-blocking: mark archiving now, do the slow work (script + worktree
    // removal) in the background, then notify when the workspace is dropped.
    beginArchive(id)
    notifyWorkspacesChanged()
    void finishArchive(id, notifyWorkspacesChanged)
  })

  ipcMain.handle('workspace:restore', async (_e, id: string) => {
    // Re-create the worktree (may throw on git errors), then run setup + Claude
    // in the background so the UI never blocks.
    await restoreWorktree(id)
    notifyWorkspacesChanged()
    void finishSetup(id, notifyWorkspacesChanged)
  })

  ipcMain.handle('workspace:delete', async (_e, id: string) => {
    await deleteArchivedWorkspace(id)
    notifyWorkspacesChanged()
  })

  // ---- Claude chat ----
  ipcMain.handle('chat:attach', (_e, id: string) => {
    // Restart a crashed/killed session lazily the moment its tab is shown.
    ensureClaudeChat(id)
    return attachChat(id)
  })
  ipcMain.on('chat:send', (_e, id: string, text: string) => {
    ensureClaudeChat(id)
    sendChatMessage(id, text)
  })
  ipcMain.on('chat:answer', (_e, id: string, answer: ChatAnswer) => answerChat(id, answer))
  ipcMain.on('chat:interrupt', (_e, id: string) => interruptChat(id))

  // ---- PTY ----
  ipcMain.handle('pty:attach', (_e, id: string, kind: PtyKind) => {
    // The free shell is started lazily (and restarted if it had exited) the
    // moment its tab is attached — no script/setup needs to have run.
    if (kind === 'shell') ensureShell(id)
    return attach(id, kind)
  })
  ipcMain.on('pty:input', (_e, id: string, kind: PtyKind, data: string) => write(id, kind, data))
  ipcMain.on('pty:resize', (_e, id: string, kind: PtyKind, cols: number, rows: number) =>
    resize(id, kind, cols, rows)
  )

  // Right-click context menu for terminals: Copy the passed selection; Paste the
  // clipboard into the PTY for interactive terminals (the read-only 'task' one
  // gets Copy only).
  ipcMain.on('term:menu', (e, id: string, kind: PtyKind, selection: string) => {
    const clip = clipboard.readText()
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Копіювати',
        enabled: !!selection,
        click: () => {
          if (selection) clipboard.writeText(selection)
        }
      }
    ]
    if (kind !== 'task') {
      template.push({
        label: 'Вставити',
        enabled: !!clip,
        click: () => write(id, kind, clip)
      })
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    Menu.buildFromTemplate(template).popup(win ? { window: win } : {})
  })
}
