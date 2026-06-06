import { vi } from 'vitest'
import type { Settings, Workspace } from '../../src/shared/types'
import { useStore } from '../../src/renderer/src/store'

export const settings: Settings = {
  repoPath: '/repo',
  worktreesDir: '/wt',
  startPort: 3002,
  setupScript: '',
  runScript: '',
  archiveScript: '',
  ideCommand: ''
}

export const mkWs = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'id',
  name: 'ws',
  branch: 'ws',
  baseBranch: undefined,
  path: '/wt/ws',
  port: 3002,
  createdAt: 0,
  status: 'active',
  ...over
})

/** A fully-stubbed window.api with sensible default resolutions. */
export function makeApi() {
  return {
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (s: Settings) => s),
    isGitRepo: vi.fn(async () => true),
    copyText: vi.fn(),
    pickFile: vi.fn(async () => null),
    pickDir: vi.fn(async () => null),
    listWorkspaces: vi.fn(async () => [] as Workspace[]),
    listBranches: vi.fn(async () => ({ branches: ['main'], defaultBranch: 'main' })),
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
    onWorkspacesChanged: vi.fn(() => () => {}),
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
    workspaces: [],
    activeId: null,
    activeKind: 'claude',
    showSettings: false,
    showNew: false,
    showArchived: false,
    busy: false,
    error: null,
    runningById: {},
    kindById: {},
    confirmRequest: null
  })
}

/** Install a fresh stubbed window.api and reset the store. Returns the api. */
export function setupRenderer(): Api {
  const api = makeApi()
  ;(window as unknown as { api: Api }).api = api
  resetStore()
  return api
}
