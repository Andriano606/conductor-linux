import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  Project,
  ProjectScripts,
  PtyData,
  PtyExit,
  PtyKind,
  Settings,
  Workspace
} from '../shared/types'

const api = {
  // Settings
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:set', s),
  isGitRepo: (path: string): Promise<boolean> => ipcRenderer.invoke('settings:isGitRepo', path),
  copyText: (text: string): void => clipboard.writeText(text),
  pickFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFile'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir'),

  // Projects
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  createProject: (repoPath: string, scripts?: ProjectScripts): Promise<Project> =>
    ipcRenderer.invoke('project:create', repoPath, scripts),
  updateProject: (project: Project): Promise<Project | undefined> =>
    ipcRenderer.invoke('project:update', project),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('project:delete', id),
  onProjectsChanged: (cb: (projects: Project[]) => void): (() => void) => {
    const listener = (_e: unknown, projects: Project[]): void => cb(projects)
    ipcRenderer.on('projects:changed', listener)
    return () => ipcRenderer.removeListener('projects:changed', listener)
  },

  // Workspaces
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
  listBranches: (
    projectId: string
  ): Promise<{ branches: string[]; localBranches: string[]; defaultBranch: string }> =>
    ipcRenderer.invoke('git:branches', projectId),
  currentBranch: (id: string): Promise<string> => ipcRenderer.invoke('git:currentBranch', id),
  createWorkspace: (
    projectId: string,
    name: string,
    baseBranch?: string,
    useExistingBranch?: boolean
  ): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:create', projectId, name, baseBranch, useExistingBranch),
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
  showTermMenu: (id: string, kind: PtyKind, selection: string): void =>
    ipcRenderer.send('term:menu', id, kind, selection),
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
