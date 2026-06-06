import { useStore } from '../store'

export function Sidebar(): JSX.Element {
  const { workspaces, activeId, setActive, openNew, openSettings, openArchived } = useStore()
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
      <button className="new-btn" onClick={() => openNew(true)}>
        + Новий воркспейс
      </button>
      <div className="ws-list">
        {live.length === 0 ? (
          <div className="empty-hint">
            Немає воркспейсів. Натисни «+ Новий воркспейс», щоб створити git worktree та запустити
            сесію Claude.
          </div>
        ) : (
          live.map((w) => (
            <div
              key={w.id}
              className={`ws-item ${w.id === activeId ? 'active' : ''}`}
              onClick={() => setActive(w.id)}
            >
              <div className="name">
                {w.name}
                {w.status === 'setting_up' && <span className="ws-badge">⏳ налаштування…</span>}
                {w.status === 'archiving' && <span className="ws-badge">📦 архівується…</span>}
              </div>
              <div className="meta">
                {w.branch} · :{w.port}
              </div>
            </div>
          ))
        )}
      </div>
      <button className="archived-btn" onClick={() => openArchived(true)}>
        🗄 Архів{archivedCount > 0 ? ` (${archivedCount})` : ''}
      </button>
    </div>
  )
}
