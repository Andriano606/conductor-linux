import { create } from 'zustand'
import type { Project, ProjectScripts, PtyKind, Settings, Workspace } from '@shared/types'

interface AppState {
  settings: Settings | null
  projects: Project[]
  workspaces: Workspace[]
  activeId: string | null
  activeKind: PtyKind
  showSettings: boolean
  /** Project id whose New-workspace modal is open (null = closed). */
  newWorkspaceProjectId: string | null
  /**
   * Name to seed the New-workspace modal with — set when a create fails so the
   * modal can reopen with the typed name preserved next to the error. null on a
   * fresh open.
   */
  newWorkspaceDraftName: string | null
  /** Whether the New-project modal is open. */
  showNewProject: boolean
  /** Project id whose settings modal is open (null = closed). */
  projectSettingsId: string | null
  showArchived: boolean
  busy: boolean
  error: string | null
  /** Whether a run script is currently active, per workspace id. */
  runningById: Record<string, boolean>
  /** Whether Claude is currently working (streaming output), per workspace id. */
  claudeBusyById: Record<string, boolean>
  /** Last-selected tab per workspace id, so switching workspaces keeps the tab. */
  kindById: Record<string, PtyKind>
  /** Selected Claude session per workspace id (the chat tab strip selection). */
  activeSessionByWorkspace: Record<string, string>
  /** Pending in-app confirmation (replaces native confirm(), which breaks window focus on Linux). */
  confirmRequest: { message: string; onResolve: (ok: boolean) => void } | null

  load: () => Promise<void>
  askConfirm: (message: string) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void
  setActive: (id: string) => void
  setKind: (kind: PtyKind) => void
  setActiveSession: (workspaceId: string, sessionId: string) => void
  openSettings: (open: boolean) => void
  openNewProject: (open: boolean) => void
  openNewWorkspace: (projectId: string | null) => void
  openProjectSettings: (id: string | null) => void
  openArchived: (open: boolean) => void
  saveSettings: (s: Settings) => Promise<void>
  createProject: (repoPath: string, scripts?: ProjectScripts) => Promise<void>
  saveProject: (project: Project) => Promise<void>
  deleteProject: (id: string) => Promise<void>
  createWorkspace: (
    projectId: string,
    name: string,
    baseBranch?: string,
    useExistingBranch?: boolean
  ) => Promise<void>
  runActive: () => Promise<void>
  stopActive: () => Promise<void>
  openActiveInBrowser: () => void
  openActiveInIde: () => void
  archiveActive: () => Promise<void>
  rerunSetup: () => Promise<void>
  restoreWorkspace: (id: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setRunning: (id: string, running: boolean) => void
  setClaudeBusy: (id: string, busy: boolean) => void
  setProjects: (projects: Project[]) => void
  setWorkspaces: (ws: Workspace[]) => void
  clearError: () => void
}

export const useStore = create<AppState>((set, get) => ({
  settings: null,
  projects: [],
  workspaces: [],
  activeId: null,
  activeKind: 'claude',
  showSettings: false,
  newWorkspaceProjectId: null,
  newWorkspaceDraftName: null,
  showNewProject: false,
  projectSettingsId: null,
  showArchived: false,
  busy: false,
  error: null,
  runningById: {},
  claudeBusyById: {},
  kindById: {},
  activeSessionByWorkspace: {},
  confirmRequest: null,

  load: async () => {
    const [settings, projects, workspaces] = await Promise.all([
      window.api.getSettings(),
      window.api.listProjects(),
      window.api.listWorkspaces()
    ])
    set({ settings, projects, workspaces })
    const live = workspaces.filter((w) => w.status !== 'archived')
    if (!get().activeId && live.length > 0) set({ activeId: live[0].id })
  },

  // Restore the tab this workspace was last on (default Claude).
  setActive: (id) => set((s) => ({ activeId: id, activeKind: s.kindById[id] ?? 'claude' })),
  // Remember the chosen tab for the active workspace.
  setKind: (kind) =>
    set((s) => ({
      activeKind: kind,
      kindById: s.activeId ? { ...s.kindById, [s.activeId]: kind } : s.kindById
    })),
  setActiveSession: (workspaceId, sessionId) =>
    set((s) => ({
      activeSessionByWorkspace: { ...s.activeSessionByWorkspace, [workspaceId]: sessionId }
    })),
  openSettings: (open) => set({ showSettings: open }),
  openNewProject: (open) =>
    set(open ? { showNewProject: true, busy: false, error: null } : { showNewProject: false }),
  // Reset any stale busy/error so the New-workspace modal always opens unblocked.
  openNewWorkspace: (projectId) =>
    set(
      projectId
        ? { newWorkspaceProjectId: projectId, busy: false, error: null, newWorkspaceDraftName: null }
        : { newWorkspaceProjectId: null }
    ),
  openProjectSettings: (id) => set({ projectSettingsId: id, error: null }),
  openArchived: (open) => set({ showArchived: open }),

  saveSettings: async (s) => {
    const saved = await window.api.setSettings(s)
    set({ settings: saved, showSettings: false })
  },

  createProject: async (repoPath, scripts) => {
    set({ busy: true, error: null })
    try {
      // The project name is derived from the repo folder name on the main side.
      await window.api.createProject(repoPath, scripts)
      set({ showNewProject: false })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  saveProject: async (project) => {
    set({ error: null })
    try {
      await window.api.updateProject(project)
      set({ projectSettingsId: null })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  deleteProject: async (id) => {
    set({ error: null })
    try {
      await window.api.deleteProject(id)
      set({ projectSettingsId: null })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  createWorkspace: async (projectId, name, baseBranch, useExistingBranch) => {
    // Close the modal immediately: the worktree checkout, the background pull and
    // the setup script all run without blocking, so the modal must not hang
    // waiting on them. On failure it reopens with the typed name + the error.
    set({ newWorkspaceProjectId: null, busy: false, error: null, newWorkspaceDraftName: null })
    try {
      const ws = await window.api.createWorkspace(projectId, name, baseBranch, useExistingBranch)
      // Show the "Скрипти" tab so the user can watch setup stream in the background.
      set((s) => ({
        activeId: ws.id,
        activeKind: 'task',
        kindById: { ...s.kindById, [ws.id]: 'task' }
      }))
    } catch (e) {
      // Reopen the modal with the name preserved so the user can fix it (the
      // common case is a new-branch name that already exists as a git branch).
      set({
        newWorkspaceProjectId: projectId,
        error: (e as Error).message,
        newWorkspaceDraftName: name
      })
    }
  },

  runActive: async () => {
    const id = get().activeId
    if (!id) return
    // Optimistically flip to Stop; main confirms via the task:running event.
    set((s) => ({
      error: null,
      activeKind: 'task',
      runningById: { ...s.runningById, [id]: true },
      kindById: { ...s.kindById, [id]: 'task' }
    }))
    try {
      await window.api.runWorkspace(id)
    } catch (e) {
      set((s) => ({ error: (e as Error).message, runningById: { ...s.runningById, [id]: false } }))
    }
  },

  stopActive: async () => {
    const id = get().activeId
    if (!id) return
    try {
      await window.api.stopWorkspace(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  openActiveInBrowser: () => {
    const id = get().activeId
    if (id) void window.api.openInBrowser(id)
  },

  openActiveInIde: () => {
    const id = get().activeId
    if (id) void window.api.openInIde(id)
  },

  setRunning: (id, running) =>
    set((s) => ({ runningById: { ...s.runningById, [id]: running } })),

  setClaudeBusy: (id, busy) =>
    set((s) => ({ claudeBusyById: { ...s.claudeBusyById, [id]: busy } })),

  archiveActive: async () => {
    const id = get().activeId
    if (!id) return
    // Non-blocking: show the archive output; the workspace drops out of the list
    // (and the active one switches) via the workspaces:changed event when done.
    set((s) => ({ error: null, activeKind: 'task', kindById: { ...s.kindById, [id]: 'task' } }))
    try {
      await window.api.archiveWorkspace(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  rerunSetup: async () => {
    const id = get().activeId
    if (!id) return
    // Show the setup output as it replays; status comes back via workspaces:changed.
    set((s) => ({ error: null, activeKind: 'task', kindById: { ...s.kindById, [id]: 'task' } }))
    try {
      await window.api.rerunSetup(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  restoreWorkspace: async (id) => {
    set({ error: null })
    try {
      await window.api.restoreWorkspace(id)
      // Re-created workspace becomes active so the user watches setup run.
      set((s) => ({
        activeId: id,
        activeKind: 'task',
        showArchived: false,
        kindById: { ...s.kindById, [id]: 'task' }
      }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  deleteWorkspace: async (id) => {
    set({ error: null })
    try {
      await window.api.deleteWorkspace(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  askConfirm: (message) =>
    new Promise<boolean>((resolve) => set({ confirmRequest: { message, onResolve: resolve } })),
  resolveConfirm: (ok) => {
    const req = get().confirmRequest
    if (req) req.onResolve(ok)
    set({ confirmRequest: null })
  },

  setProjects: (projects) => set({ projects }),
  setWorkspaces: (ws) => set({ workspaces: ws }),
  clearError: () => set({ error: null })
}))
