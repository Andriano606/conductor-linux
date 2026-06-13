import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { initStore, updateSessionClaudeParams, updateSessionSessionId } from './store'
import { notifyWorkspacesChanged, registerIpc } from './ipc'
import { stopAllBranchWatches } from './branchWatcher'
import { killAll, setMainWindow } from './ptyManager'
import {
  killAllChats,
  onChatParams,
  onChatSessionId,
  setChatStorageDir,
  setChatWindow
} from './claudeChat'
import { restoreSessions } from './workspaces'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1b1d23',
    title: 'Conductor Linux',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  setMainWindow(win.webContents)
  setChatWindow(win.webContents)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Remove the native menu bar entirely so it never flickers in (Alt-toggle etc.)
  Menu.setApplicationMenu(null)
  initStore()
  // Persist each workspace's Claude session id so chats resume after relaunch,
  // and the visible transcripts so the chat history survives restarts/archive.
  onChatSessionId(updateSessionSessionId)
  onChatParams(updateSessionClaudeParams)
  setChatStorageDir(join(app.getPath('userData'), 'chats'))
  registerIpc()
  // Reaps orphaned processes from the previous session before restarting Claude;
  // fire-and-forget so window creation isn't blocked by the SIGTERM grace period.
  void restoreSessions(notifyWorkspacesChanged)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAll()
  killAllChats()
  stopAllBranchWatches()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  killAll()
  killAllChats()
  stopAllBranchWatches()
})
