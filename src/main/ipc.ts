import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { PtyKind, Settings } from '../shared/types'
import { getSettings, getWorkspaces, setSettings } from './store'
import { isGitRepo } from './git'
import { attach, resize, stopTask, write } from './ptyManager'
import { beginArchive, createWorkspace, finishArchive, finishSetup, runWorkspace } from './workspaces'

function notifyWorkspacesChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('workspaces:changed', getWorkspaces())
  }
}

export function registerIpc(): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, settings: Settings) => setSettings(settings))
  ipcMain.handle('settings:isGitRepo', (_e, path: string) => isGitRepo(path))

  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- Workspaces ----
  ipcMain.handle('workspaces:list', () => getWorkspaces())

  ipcMain.handle('workspace:create', async (_e, name: string) => {
    const ws = await createWorkspace(name)
    notifyWorkspacesChanged()
    // Run setup + start Claude in the background so the UI never blocks.
    void finishSetup(ws.id, notifyWorkspacesChanged)
    return ws
  })

  ipcMain.handle('workspace:run', async (_e, id: string) => {
    await runWorkspace(id)
  })

  ipcMain.handle('workspace:stop', (_e, id: string) => stopTask(id))

  ipcMain.handle('workspace:archive', (_e, id: string) => {
    // Non-blocking: mark archiving now, do the slow work (script + worktree
    // removal) in the background, then notify when the workspace is dropped.
    beginArchive(id)
    notifyWorkspacesChanged()
    void finishArchive(id, notifyWorkspacesChanged)
  })

  // ---- PTY ----
  ipcMain.handle('pty:attach', (_e, id: string, kind: PtyKind) => attach(id, kind))
  ipcMain.on('pty:input', (_e, id: string, kind: PtyKind, data: string) => write(id, kind, data))
  ipcMain.on('pty:resize', (_e, id: string, kind: PtyKind, cols: number, rows: number) =>
    resize(id, kind, cols, rows)
  )
}
