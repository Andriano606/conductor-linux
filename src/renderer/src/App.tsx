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
import { ChatView } from './components/ChatView'
import { SessionTabs } from './components/SessionTabs'
import { disposeWorkspace, writeData } from './termRegistry'
import { useChatStore } from './chatStore'

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
    activeSessionByWorkspace,
    load,
    setProjects,
    setWorkspaces,
    setCustomPrompts,
    setClaudeProfiles,
    setRunning,
    setClaudeBusy
  } = useStore()

  useEffect(() => {
    void load()

    const offData = window.api.onPtyData(({ id, kind, data }) => writeData(id, kind, data))
    const offChat = window.api.onChatEvent((p) => useChatStore.getState().applyEvent(p))
    const offRunning = window.api.onTaskRunning(({ id, running }) => setRunning(id, running))
    const offBusy = window.api.onClaudeBusy(({ id, busy }) => setClaudeBusy(id, busy))
    const offProjects = window.api.onProjectsChanged((next) => setProjects(next))
    const offPrompts = window.api.onCustomPromptsChanged((next) => setCustomPrompts(next))
    const offProfiles = window.api.onClaudeProfilesChanged((next) => setClaudeProfiles(next))
    // /login asks the UI to surface the workspace's terminal so the user sees the
    // interactive OAuth flow.
    const offFocus = window.api.onPtyFocus(({ id, kind }) => {
      const s = useStore.getState()
      if (s.activeId !== id) s.setActive(id)
      s.setKind(kind)
    })
    const offChanged = window.api.onWorkspacesChanged((next) => {
      const state = useStore.getState()
      const prev = state.workspaces
      // Tear down terminals for workspaces that disappeared (deleted) or were
      // just archived — their PTYs are killed in main either way.
      const liveNextIds = new Set(next.filter((w) => w.status !== 'archived').map((w) => w.id))
      for (const w of prev) {
        if (w.status !== 'archived' && !liveNextIds.has(w.id)) {
          disposeWorkspace(w.id)
          for (const s of w.sessions) useChatStore.getState().dispose(s.id)
        }
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
      offData()
      offChat()
      offRunning()
      offBusy()
      offProjects()
      offPrompts()
      offProfiles()
      offFocus()
      offChanged()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = workspaces.find((w) => w.id === activeId) ?? null
  // Resolve the selected session, falling back to the first if the stored choice
  // was closed (or never set).
  const stored = active ? activeSessionByWorkspace[active.id] : undefined
  const activeSessionId =
    active?.sessions.find((s) => s.id === stored)?.id ?? active?.sessions[0]?.id ?? ''

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {active ? (
          <>
            <Toolbar ws={active} />
            {activeKind === 'claude' ? (
              <>
                <SessionTabs ws={active} activeSessionId={activeSessionId} />
                <ChatView id={activeSessionId} key={activeSessionId} />
              </>
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
