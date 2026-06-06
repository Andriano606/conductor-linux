import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { TerminalView } from './components/TerminalView'
import { SettingsModal } from './components/SettingsModal'
import { NewWorkspaceModal } from './components/NewWorkspaceModal'
import { disposeWorkspace, writeData } from './termRegistry'

export function App(): JSX.Element {
  const { workspaces, activeId, activeKind, showSettings, showNew, load, setWorkspaces, setRunning } =
    useStore()

  useEffect(() => {
    void load()

    const offData = window.api.onPtyData(({ id, kind, data }) => writeData(id, kind, data))
    const offRunning = window.api.onTaskRunning(({ id, running }) => setRunning(id, running))
    const offChanged = window.api.onWorkspacesChanged((next) => {
      const state = useStore.getState()
      const prev = state.workspaces
      // Tear down terminals for workspaces that disappeared (archived).
      const ids = new Set(next.map((w) => w.id))
      for (const w of prev) {
        if (!ids.has(w.id)) disposeWorkspace(w.id)
      }
      // When the active workspace finishes setup, reveal its Claude session.
      const before = prev.find((w) => w.id === state.activeId)
      const after = next.find((w) => w.id === state.activeId)
      if (before?.status === 'setting_up' && after?.status === 'active' && state.activeKind === 'task') {
        state.setKind('claude')
      }
      setWorkspaces(next)
      // The active workspace was archived/removed — switch to another (or none).
      if (state.activeId && !after) {
        if (next.length) state.setActive(next[0].id)
        else useStore.setState({ activeId: null })
      }
    })

    return () => {
      offData()
      offRunning()
      offChanged()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = workspaces.find((w) => w.id === activeId) ?? null

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {active ? (
          <>
            <Toolbar ws={active} />
            <TerminalView id={active.id} kind={activeKind} />
          </>
        ) : (
          <div className="placeholder">
            Створи воркспейс, щоб почати сесію Claude в ізольованому git worktree.
          </div>
        )}
      </div>
      {showSettings && <SettingsModal />}
      {showNew && <NewWorkspaceModal />}
    </div>
  )
}
