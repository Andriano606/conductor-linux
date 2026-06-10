import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { TerminalView } from './components/TerminalView'
import { SettingsModal } from './components/SettingsModal'
import { NewProjectModal } from './components/NewProjectModal'
import { ProjectSettingsModal } from './components/ProjectSettingsModal'
import { NewWorkspaceModal } from './components/NewWorkspaceModal'
import { ArchivedModal } from './components/ArchivedModal'
import { ConfirmModal } from './components/ConfirmModal'
import { ClaudePane } from './components/ClaudePane'
import { disposeWorkspace, requestMenuScan, setMenuListener, writeData } from './termRegistry'

export function App(): JSX.Element {
  const {
    workspaces,
    activeId,
    activeKind,
    showSettings,
    showNewProject,
    newWorkspaceProjectId,
    projectSettingsId,
    showArchived,
    load,
    setProjects,
    setWorkspaces,
    setRunning,
    setClaudeBusy
  } = useStore()

  useEffect(() => {
    void load()

    const offData = window.api.onPtyData(({ id, kind, data }) => writeData(id, kind, data))
    const offRunning = window.api.onTaskRunning(({ id, running }) => setRunning(id, running))
    // Select menus detected on the Claude screen feed the chips above the
    // composer. While Claude is busy generating, anything that still looks like
    // a menu is stale, so it is suppressed.
    setMenuListener((id, menu) => {
      const s = useStore.getState()
      s.setMenu(id, s.claudeBusyById[id] ? null : menu)
    })
    const offBusy = window.api.onClaudeBusy(({ id, busy }) => {
      setClaudeBusy(id, busy)
      // Busy → the chips are stale immediately. Idle → rescan: the menu usually
      // finished rendering before the busy detector's idle timer fired, so the
      // settle-scan that saw it was suppressed by the gate above.
      if (busy) useStore.getState().setMenu(id, null)
      else requestMenuScan(id)
    })
    const offProjects = window.api.onProjectsChanged((next) => setProjects(next))
    const offChanged = window.api.onWorkspacesChanged((next) => {
      const state = useStore.getState()
      const prev = state.workspaces
      // Tear down terminals for workspaces that disappeared (deleted) or were
      // just archived — their PTYs are killed in main either way.
      const liveNextIds = new Set(next.filter((w) => w.status !== 'archived').map((w) => w.id))
      for (const w of prev) {
        if (w.status !== 'archived' && !liveNextIds.has(w.id)) disposeWorkspace(w.id)
      }
      // Note: we intentionally do NOT switch tabs when setup finishes — the user
      // stays on whatever tab they're currently viewing.
      setWorkspaces(next)
      // The active workspace was archived/deleted — switch to another live one.
      const live = next.filter((w) => w.status !== 'archived')
      if (state.activeId && !live.some((w) => w.id === state.activeId)) {
        if (live.length) state.setActive(live[0].id)
        else useStore.setState({ activeId: null })
      }
    })

    return () => {
      setMenuListener(null)
      offData()
      offRunning()
      offBusy()
      offProjects()
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
            {activeKind === 'claude' ? (
              <ClaudePane id={active.id} />
            ) : (
              <TerminalView id={active.id} kind={activeKind} />
            )}
          </>
        ) : (
          <div className="placeholder">
            Додай проект і створи воркспейс, щоб почати сесію Claude в ізольованому git worktree.
          </div>
        )}
      </div>
      {showSettings && <SettingsModal />}
      {showNewProject && <NewProjectModal />}
      {projectSettingsId && <ProjectSettingsModal />}
      {newWorkspaceProjectId && <NewWorkspaceModal />}
      {showArchived && <ArchivedModal />}
      <ConfirmModal />
    </div>
  )
}
