import type { Workspace } from '@shared/types'
import { useStore } from '../store'

/**
 * The persisted setup indicator: a spinner while setup runs, then a green dot on
 * success or a red dot on failure. Nothing for legacy workspaces with no record.
 */
/**
 * Claude's "spark" mark in its brand orange, gently spinning + pulsing while
 * Claude is working — the animated-logo indicator (instead of a plain spinner).
 */
function ClaudeBusyIcon(): JSX.Element {
  // 12 tapered spokes radiating from the centre; alternating lengths give the
  // logo its irregular starburst look.
  const spokes = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]
  return (
    <span className="ind-claude" title="Claude працює">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          {spokes.map((deg, i) => {
            const rad = (deg * Math.PI) / 180
            const inner = 1.6
            const outer = i % 2 === 0 ? 9.5 : 6
            return (
              <line
                key={deg}
                x1={12 + Math.cos(rad) * inner}
                y1={12 + Math.sin(rad) * inner}
                x2={12 + Math.cos(rad) * outer}
                y2={12 + Math.sin(rad) * outer}
              />
            )
          })}
        </g>
      </svg>
    </span>
  )
}

function SetupIndicator({ w }: { w: Workspace }): JSX.Element | null {
  if (w.status === 'setting_up' || w.setupStatus === 'pending') {
    return <span className="ind-spin" title="Setup виконується…" />
  }
  if (w.setupStatus === 'success') {
    return <span className="ind ind-ok" title="Setup завершився успішно" />
  }
  if (w.setupStatus === 'error') {
    return <span className="ind ind-err" title="Setup завершився з помилкою" />
  }
  return null
}

export function Sidebar(): JSX.Element {
  const {
    projects,
    workspaces,
    activeId,
    runningById,
    claudeBusyById,
    setActive,
    openNewProject,
    openNewWorkspace,
    openProjectSettings,
    openSettings,
    openArchived
  } = useStore()
  const live = workspaces.filter((w) => w.status !== 'archived')
  const archivedCount = workspaces.length - live.length

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <h1>Conductor</h1>
        <button className="gear" title="Налаштування" onClick={() => openSettings(true)}>
          ⚙
        </button>
      </div>
      <button className="new-btn" onClick={() => openNewProject(true)}>
        + Новий проект
      </button>
      <div className="ws-list">
        {projects.length === 0 ? (
          <div className="empty-hint">
            Немає проектів. Натисни «+ Новий проект», щоб додати git-репозиторій, і далі створюй у
            ньому воркспейси.
          </div>
        ) : (
          projects.map((p) => {
            const projectWs = live.filter((w) => w.projectId === p.id)
            return (
              <div className="project-group" key={p.id}>
                <div className="project-header">
                  <div className="project-name" title={p.repoPath}>
                    {p.name}
                  </div>
                  <div className="project-actions">
                    <button
                      className="proj-btn"
                      title="Новий воркспейс у цьому проекті"
                      onClick={() => openNewWorkspace(p.id)}
                    >
                      +
                    </button>
                    <button
                      className="proj-btn"
                      title="Налаштування проекту"
                      onClick={() => openProjectSettings(p.id)}
                    >
                      ⚙
                    </button>
                  </div>
                </div>
                {projectWs.length === 0 ? (
                  <div className="project-empty">Немає воркспейсів — натисни «+».</div>
                ) : (
                  projectWs.map((w) => (
                    <div
                      key={w.id}
                      className={`ws-item ${w.id === activeId ? 'active' : ''}`}
                      onClick={() => setActive(w.id)}
                    >
                      <div className="ws-top">
                        <span className="name">{w.name}</span>
                        <span className="ws-indicators">
                          <SetupIndicator w={w} />
                          {runningById[w.id] && (
                            <span className="ind ind-run" title="Run-скрипт запущено" />
                          )}
                          {claudeBusyById[w.id] && <ClaudeBusyIcon />}
                        </span>
                      </div>
                      {w.status === 'archiving' && <span className="ws-badge">📦 архівується…</span>}
                      <div className="meta">
                        {w.branch} · :{w.port}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )
          })
        )}
      </div>
      <button className="archived-btn" onClick={() => openArchived(true)}>
        🗄 Архів{archivedCount > 0 ? ` (${archivedCount})` : ''}
      </button>
    </div>
  )
}
