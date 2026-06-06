import { create } from 'zustand'
import type { PtyKind, Settings, Workspace } from '@shared/types'

interface AppState {
  settings: Settings | null
  workspaces: Workspace[]
  activeId: string | null
  activeKind: PtyKind
  showSettings: boolean
  showNew: boolean
  busy: boolean
  error: string | null
  /** Whether a run script is currently active, per workspace id. */
  runningById: Record<string, boolean>

  load: () => Promise<void>
  setActive: (id: string) => void
  setKind: (kind: PtyKind) => void
  openSettings: (open: boolean) => void
  openNew: (open: boolean) => void
  saveSettings: (s: Settings) => Promise<void>
  createWorkspace: (name: string) => Promise<void>
  runActive: () => Promise<void>
  stopActive: () => Promise<void>
  archiveActive: () => Promise<void>
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
  busy: false,
  error: null,
  runningById: {},

  load: async () => {
    const [settings, workspaces] = await Promise.all([
      window.api.getSettings(),
      window.api.listWorkspaces()
    ])
    set({ settings, workspaces })
    if (!get().activeId && workspaces.length > 0) set({ activeId: workspaces[0].id })
    // Force settings open on first run when nothing is configured.
    if (!settings.repoPath) set({ showSettings: true })
  },

  setActive: (id) => set({ activeId: id, activeKind: 'claude' }),
  setKind: (kind) => set({ activeKind: kind }),
  openSettings: (open) => set({ showSettings: open }),
  openNew: (open) => set({ showNew: open }),

  saveSettings: async (s) => {
    const saved = await window.api.setSettings(s)
    set({ settings: saved, showSettings: false })
  },

  createWorkspace: async (name) => {
    set({ busy: true, error: null })
    try {
      const ws = await window.api.createWorkspace(name)
      // Show the "Скрипти" tab so the user can watch setup stream in the background.
      set({ showNew: false, activeId: ws.id, activeKind: 'task' })
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
    set((s) => ({ error: null, activeKind: 'task', runningById: { ...s.runningById, [id]: true } }))
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

  setRunning: (id, running) =>
    set((s) => ({ runningById: { ...s.runningById, [id]: running } })),

  archiveActive: async () => {
    const id = get().activeId
    if (!id) return
    // Non-blocking: show the archive output; the workspace drops out of the list
    // (and the active one switches) via the workspaces:changed event when done.
    set({ error: null, activeKind: 'task' })
    try {
      await window.api.archiveWorkspace(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  setWorkspaces: (ws) => set({ workspaces: ws }),
  clearError: () => set({ error: null })
}))
