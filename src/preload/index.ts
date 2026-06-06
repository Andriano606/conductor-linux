import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { PtyData, PtyExit, PtyKind, Settings, Workspace } from '../shared/types'

const api = {
  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:set', s),
  isGitRepo: (path: string): Promise<boolean> => ipcRenderer.invoke('settings:isGitRepo', path),
  copyText: (text: string): void => clipboard.writeText(text),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFile'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),

  // Workspaces
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (name: string): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:create', name),
  runWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:run', id),
  stopWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:stop', id),
  openInBrowser: (id: string): Promise<void> => ipcRenderer.invoke('workspace:openInBrowser', id),
  openInIde: (id: string): Promise<void> => ipcRenderer.invoke('workspace:openInIde', id),
  archiveWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:archive', id),
  restoreWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:restore', id),
  deleteWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:delete', id),
  onTaskRunning: (cb: (d: { id: string; running: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, d: { id: string; running: boolean }): void => cb(d)
    ipcRenderer.on('task:running', listener)
    return () => ipcRenderer.removeListener('task:running', listener)
  },
  onWorkspacesChanged: (cb: (workspaces: Workspace[]) => void): (() => void) => {
    const listener = (_e: unknown, workspaces: Workspace[]): void => cb(workspaces)
    ipcRenderer.on('workspaces:changed', listener)
    return () => ipcRenderer.removeListener('workspaces:changed', listener)
  },

  // PTY
  attachPty: (id: string, kind: PtyKind): Promise<string> =>
    ipcRenderer.invoke('pty:attach', id, kind),
  sendInput: (id: string, kind: PtyKind, data: string): void =>
    ipcRenderer.send('pty:input', id, kind, data),
  resizePty: (id: string, kind: PtyKind, cols: number, rows: number): void =>
    ipcRenderer.send('pty:resize', id, kind, cols, rows),
  onPtyData: (cb: (d: PtyData) => void): (() => void) => {
    const listener = (_e: unknown, d: PtyData): void => cb(d)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (cb: (d: PtyExit) => void): (() => void) => {
    const listener = (_e: unknown, d: PtyExit): void => cb(d)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
