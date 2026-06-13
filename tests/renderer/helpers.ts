import { vi } from 'vitest'
import type { ChatSnapshot, Project, Settings, Workspace } from '../../src/shared/types'
import { useStore } from '../../src/renderer/src/store'
import { useChatStore } from '../../src/renderer/src/chatStore'

export const settings: Settings = {
  worktreesDir: '/wt',
  startPort: 3002,
  ideCommand: '',
  claudeArgs: '--dangerously-skip-permissions'
}

export const mkProject = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'proj',
  repoPath: '/repo',
  setupScript: '',
  runScript: '',
  archiveScript: '',
  createdAt: 0,
  ...over
})

export const mkWs = (over: Partial<Workspace> = {}): Workspace => {
  const id = over.id ?? 'id'
  return {
    id,
    projectId: 'p1',
    name: 'ws',
    branch: 'ws',
    baseBranch: undefined,
    path: '/wt/proj/ws',
    port: 3002,
    createdAt: 0,
    status: 'active',
    sessions: [{ id, createdAt: 0 }],
    ...over
  }
}

/** A fully-stubbed window.api with sensible default resolutions. */
export function makeApi() {
  return {
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (s: Settings) => s),
    isGitRepo: vi.fn(async () => true),
    copyText: vi.fn(),
    pickFile: vi.fn(async () => null),
    pickDir: vi.fn(async () => null),
    listProjects: vi.fn(async () => [] as Project[]),
    createProject: vi.fn(async () => mkProject({ id: 'new' })),
    updateProject: vi.fn(async (p: Project) => p),
    deleteProject: vi.fn(async () => {}),
    onProjectsChanged: vi.fn(() => () => {}),
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    listBranches: vi.fn(async () => ({
      branches: ['main'],
      existingBranches: ['main'],
      checkedOut: [] as string[],
      defaultBranch: 'main'
    })),
    currentBranch: vi.fn(async () => 'main'),
    createWorkspace: vi.fn(async () => mkWs({ id: 'new' })),
    runWorkspace: vi.fn(async () => {}),
    stopWorkspace: vi.fn(async () => {}),
    openInBrowser: vi.fn(async () => {}),
    openInIde: vi.fn(async () => {}),
    archiveWorkspace: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    onTaskRunning: vi.fn(() => () => {}),
    onClaudeBusy: vi.fn(() => () => {}),
    onWorkspacesChanged: vi.fn(() => () => {}),
    attachChat: vi.fn(
      async (): Promise<ChatSnapshot> => ({
        items: [],
        pending: null,
        busy: false,
        seq: 0,
        commands: []
      })
    ),
    sendChat: vi.fn(),
    answerChat: vi.fn(),
    interruptChat: vi.fn(),
    onChatEvent: vi.fn(() => () => {}),
    createSession: vi.fn(async () => ({ id: 'sess-new', createdAt: 0 })),
    closeSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    attachPty: vi.fn(async () => ''),
    sendInput: vi.fn(),
    resizePty: vi.fn(),
    showTermMenu: vi.fn(),
    onPtyData: vi.fn(() => () => {}),
    onPtyExit: vi.fn(() => () => {})
  }
}

export type Api = ReturnType<typeof makeApi>

/** Reset the zustand store's data fields (keeps the action functions). */
export function resetStore(): void {
  useStore.setState({
    settings: null,
    projects: [],
    workspaces: [],
    activeId: null,
    activeKind: 'claude',
    showSettings: false,
    newWorkspaceProjectId: null,
    showNewProject: false,
    projectSettingsId: null,
    showArchived: false,
    busy: false,
    error: null,
    runningById: {},
    claudeBusyById: {},
    kindById: {},
    activeSessionByWorkspace: {},
    confirmRequest: null
  })
}

/** Install a fresh stubbed window.api and reset the stores. Returns the api. */
export function setupRenderer(): Api {
  const api = makeApi()
  ;(window as unknown as { api: Api }).api = api
  resetStore()
  useChatStore.setState({ byId: {} })
  return api
}
