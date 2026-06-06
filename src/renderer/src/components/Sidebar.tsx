import { useStore } from '../store'

export function Sidebar(): JSX.Element {
  const { workspaces, activeId, setActive, openNew, openSettings } = useStore()

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
        {workspaces.length === 0 ? (
          <div className="empty-hint">
            Немає воркспейсів. Натисни «+ Новий воркспейс», щоб створити git worktree та запустити
            сесію Claude.
          </div>
        ) : (
          workspaces.map((w) => (
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
    </div>
  )
}
