import { create } from 'zustand'
import type { PtyKind, Settings, Workspace } from '@shared/types'

interface AppState {
  settings: Settings | null
  workspaces: Workspace[]
  activeId: string | null
  activeKind: PtyKind
  showSettings: boolean
  showNew: boolean
  showArchived: boolean
  busy: boolean
  error: string | null
  /** Whether a run script is currently active, per workspace id. */
  runningById: Record<string, boolean>
  /** Last-selected tab per workspace id, so switching workspaces keeps the tab. */
  kindById: Record<string, PtyKind>

  load: () => Promise<void>
  setActive: (id: string) => void
  setKind: (kind: PtyKind) => void
  openSettings: (open: boolean) => void
  openNew: (open: boolean) => void
  openArchived: (open: boolean) => void
  saveSettings: (s: Settings) => Promise<void>
  createWorkspace: (name: string, baseBranch?: string) => Promise<void>
  runActive: () => Promise<void>
  stopActive: () => Promise<void>
  openActiveInBrowser: () => void
  openActiveInIde: () => void
  archiveActive: () => Promise<void>
  restoreWorkspace: (id: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  setRunning: (id: string, running: boolean) => void
  setWorkspaces: (ws: Workspace[]) => void
  clearError: () => void
}

export const useStore = create<AppState>((set, get) => ({
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

  load: async () => {
    const [settings, workspaces] = await Promise.all([
      window.api.getSettings(),
      window.api.listWorkspaces()
    ])
    set({ settings, workspaces })
    const live = workspaces.filter((w) => w.status !== 'archived')
    if (!get().activeId && live.length > 0) set({ activeId: live[0].id })
    // Force settings open on first run when nothing is configured.
    if (!settings.repoPath) set({ showSettings: true })
  },

  // Restore the tab this workspace was last on (default Claude).
  setActive: (id) => set((s) => ({ activeId: id, activeKind: s.kindById[id] ?? 'claude' })),
  // Remember the chosen tab for the active workspace.
  setKind: (kind) =>
    set((s) => ({
      activeKind: kind,
      kindById: s.activeId ? { ...s.kindById, [s.activeId]: kind } : s.kindById
    })),
  openSettings: (open) => set({ showSettings: open }),
  openNew: (open) => set({ showNew: open }),
  openArchived: (open) => set({ showArchived: open }),

  saveSettings: async (s) => {
    const saved = await window.api.setSettings(s)
    set({ settings: saved, showSettings: false })
  },

  createWorkspace: async (name, baseBranch) => {
    set({ busy: true, error: null })
    try {
      const ws = await window.api.createWorkspace(name, baseBranch)
      // Show the "Скрипти" tab so the user can watch setup stream in the background.
      set((s) => ({
        showNew: false,
        activeId: ws.id,
        activeKind: 'task',
        kindById: { ...s.kindById, [ws.id]: 'task' }
      }))
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
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

  setWorkspaces: (ws) => set({ workspaces: ws }),
  clearError: () => set({ error: null })
}))
