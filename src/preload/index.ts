import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  ChatAnswer,
  ChatEventPayload,
  ChatSession,
  ChatSnapshot,
  ClaudeProfile,
  CustomPrompt,
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
  pickDir: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDir', defaultPath),
  homeDir: (): Promise<string> => ipcRenderer.invoke('sys:homeDir'),

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

  // Custom prompts (global prompt library)
  listCustomPrompts: (): Promise<CustomPrompt[]> => ipcRenderer.invoke('customPrompts:list'),
  createCustomPrompt: (title: string, content: string): Promise<CustomPrompt> =>
    ipcRenderer.invoke('customPrompt:create', title, content),
  updateCustomPrompt: (prompt: CustomPrompt): Promise<CustomPrompt | undefined> =>
    ipcRenderer.invoke('customPrompt:update', prompt),
  deleteCustomPrompt: (id: string): Promise<void> => ipcRenderer.invoke('customPrompt:delete', id),
  onCustomPromptsChanged: (cb: (prompts: CustomPrompt[]) => void): (() => void) => {
    const listener = (_e: unknown, prompts: CustomPrompt[]): void => cb(prompts)
    ipcRenderer.on('customPrompts:changed', listener)
    return () => ipcRenderer.removeListener('customPrompts:changed', listener)
  },

  // Claude config profiles (named CLAUDE_CONFIG_DIR list)
  listClaudeProfiles: (): Promise<ClaudeProfile[]> => ipcRenderer.invoke('claudeProfiles:list'),
  createClaudeProfile: (name: string, path: string): Promise<ClaudeProfile> =>
    ipcRenderer.invoke('claudeProfile:create', name, path),
  updateClaudeProfile: (profile: ClaudeProfile): Promise<ClaudeProfile | undefined> =>
    ipcRenderer.invoke('claudeProfile:update', profile),
  deleteClaudeProfile: (id: string): Promise<void> => ipcRenderer.invoke('claudeProfile:delete', id),
  onClaudeProfilesChanged: (cb: (profiles: ClaudeProfile[]) => void): (() => void) => {
    const listener = (_e: unknown, profiles: ClaudeProfile[]): void => cb(profiles)
    ipcRenderer.on('claudeProfiles:changed', listener)
    return () => ipcRenderer.removeListener('claudeProfiles:changed', listener)
  },

  // Workspaces
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
  listBranches: (
    projectId: string,
    fetch?: boolean
  ): Promise<{
    branches: string[]
    existingBranches: string[]
    checkedOut: string[]
    defaultBranch: string
  }> => ipcRenderer.invoke('git:branches', projectId, fetch),
  currentBranch: (id: string): Promise<string> => ipcRenderer.invoke('git:currentBranch', id),
  renameBranch: (id: string, newName: string): Promise<{ remoteExists: boolean }> =>
    ipcRenderer.invoke('workspace:renameBranch', id, newName),
  createWorkspace: (
    projectId: string,
    name: string,
    baseBranch?: string,
    useExistingBranch?: boolean
  ): Promise<Workspace> =>
    ipcRenderer.invoke('workspace:create', projectId, name, baseBranch, useExistingBranch),
  runWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:run', id),
  stopWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:stop', id),
  killWorkspaceProcesses: (id: string): Promise<number> =>
    ipcRenderer.invoke('workspace:killProcesses', id),
  openInBrowser: (id: string): Promise<void> => ipcRenderer.invoke('workspace:openInBrowser', id),
  openInIde: (id: string): Promise<void> => ipcRenderer.invoke('workspace:openInIde', id),
  archiveWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:archive', id),
  rerunSetup: (id: string): Promise<void> => ipcRenderer.invoke('workspace:rerunSetup', id),
  restoreWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:restore', id),
  deleteWorkspace: (id: string): Promise<void> => ipcRenderer.invoke('workspace:delete', id),
  onTaskRunning: (cb: (d: { id: string; running: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, d: { id: string; running: boolean }): void => cb(d)
    ipcRenderer.on('task:running', listener)
    return () => ipcRenderer.removeListener('task:running', listener)
  },
  onClaudeBusy: (cb: (d: { id: string; busy: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, d: { id: string; busy: boolean }): void => cb(d)
    ipcRenderer.on('claude:busy', listener)
    return () => ipcRenderer.removeListener('claude:busy', listener)
  },
  onWorkspacesChanged: (cb: (workspaces: Workspace[]) => void): (() => void) => {
    const listener = (_e: unknown, workspaces: Workspace[]): void => cb(workspaces)
    ipcRenderer.on('workspaces:changed', listener)
    return () => ipcRenderer.removeListener('workspaces:changed', listener)
  },

  // Claude chat
  attachChat: (id: string): Promise<ChatSnapshot> => ipcRenderer.invoke('chat:attach', id),
  sendChat: (id: string, text: string): void => ipcRenderer.send('chat:send', id, text),
  answerChat: (id: string, answer: ChatAnswer): void => ipcRenderer.send('chat:answer', id, answer),
  interruptChat: (id: string): void => ipcRenderer.send('chat:interrupt', id),
  onChatEvent: (cb: (payload: ChatEventPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: ChatEventPayload): void => cb(payload)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },

  // Chat sessions (multiple per workspace)
  createSession: (workspaceId: string): Promise<ChatSession | undefined> =>
    ipcRenderer.invoke('session:create', workspaceId),
  closeSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('session:close', sessionId),
  renameSession: (sessionId: string, title: string): Promise<void> =>
    ipcRenderer.invoke('session:rename', sessionId, title),
  setSessionProfile: (sessionId: string, profileId: string | undefined): Promise<void> =>
    ipcRenderer.invoke('session:setProfile', sessionId, profileId),

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
