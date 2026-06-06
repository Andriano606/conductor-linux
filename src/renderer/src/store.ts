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

  load: () => Promise<void>
  setActive: (id: string) => void
  setKind: (kind: PtyKind) => void
  openSettings: (open: boolean) => void
  openNew: (open: boolean) => void
  saveSettings: (s: Settings) => Promise<void>
  createWorkspace: (name: string) => Promise<void>
  runActive: () => Promise<void>
  archiveActive: () => Promise<void>
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
    set({ error: null, activeKind: 'task' })
    try {
      await window.api.runWorkspace(id)
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  archiveActive: async () => {
    const id = get().activeId
    if (!id) return
    set({ busy: true, error: null })
    try {
      await window.api.archiveWorkspace(id)
      const remaining = get().workspaces.filter((w) => w.id !== id)
      set({ activeId: remaining[0]?.id ?? null, activeKind: 'claude' })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ busy: false })
    }
  },

  setWorkspaces: (ws) => set({ workspaces: ws }),
  clearError: () => set({ error: null })
}))
