import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@shared/types'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'

/** Display label for a session: its title, or "Сесія N" by position. */
function sessionLabel(ws: Workspace, sessionId: string): string {
  const i = ws.sessions.findIndex((s) => s.id === sessionId)
  const session = ws.sessions[i]
  return session?.title || `Сесія ${i + 1}`
}

/**
 * The strip of Claude session tabs for a workspace, shown above the chat view.
 * Switch between sessions, add a new one (+), close any non-last session (×),
 * and double-click a tab to rename it. The busy spinner lights per session.
 */
export function SessionTabs({ ws, activeSessionId }: { ws: Workspace; activeSessionId: string }): JSX.Element {
  const { claudeBusyById, setActiveSession } = useStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) editRef.current?.select()
  }, [editingId])

  const canClose = ws.sessions.length > 1

  const addSession = async (): Promise<void> => {
    const session = await window.api.createSession(ws.id)
    if (session) setActiveSession(ws.id, session.id)
  }

  const closeSession = async (sessionId: string): Promise<void> => {
    // Pick a sibling to land on before the closed one disappears from the list.
    if (sessionId === activeSessionId) {
      const i = ws.sessions.findIndex((s) => s.id === sessionId)
      const sibling = ws.sessions[i + 1] ?? ws.sessions[i - 1]
      if (sibling) setActiveSession(ws.id, sibling.id)
    }
    await window.api.closeSession(sessionId)
    useChatStore.getState().dispose(sessionId)
  }

  const startRename = (sessionId: string): void => {
    setEditingId(sessionId)
    setEditText(ws.sessions.find((s) => s.id === sessionId)?.title ?? '')
  }

  const commitRename = (): void => {
    if (editingId) void window.api.renameSession(editingId, editText.trim())
    setEditingId(null)
  }

  return (
    <div className="session-tabs">
      {ws.sessions.map((s) => (
        <div
          key={s.id}
          className={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
          onClick={() => setActiveSession(ws.id, s.id)}
          onDoubleClick={() => startRename(s.id)}
          title="Подвійний клік — перейменувати"
        >
          {editingId === s.id ? (
            <input
              ref={editRef}
              className="session-tab-edit"
              value={editText}
              autoFocus
              onChange={(e) => setEditText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') setEditingId(null)
              }}
            />
          ) : (
            <>
              {claudeBusyById[s.id] && <span className="session-tab-spin" />}
              <span className="session-tab-name">{sessionLabel(ws, s.id)}</span>
              {canClose && (
                <button
                  className="session-tab-close"
                  title="Закрити сесію"
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeSession(s.id)
                  }}
                >
                  ×
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <button className="session-tab-add" title="Нова сесія Claude" onClick={() => void addSession()}>
        +
      </button>
    </div>
  )
}
