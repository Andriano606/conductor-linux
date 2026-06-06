import { useStore } from '../store'

export function ArchivedModal(): JSX.Element {
  const { workspaces, openArchived, restoreWorkspace, deleteWorkspace, error } = useStore()
  const archived = workspaces.filter((w) => w.status === 'archived')

  const remove = (id: string, name: string): void => {
    if (
      confirm(`Видалити воркспейс «${name}» назавжди? Гілку git буде видалено — це незворотно.`)
    ) {
      void deleteWorkspace(id)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => openArchived(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <h2>Архівовані воркспейси</h2>
        {error && <div className="err">{error}</div>}
        {archived.length === 0 ? (
          <div className="hint">Архів порожній.</div>
        ) : (
          <div className="archived-list">
            {archived.map((w) => (
              <div className="archived-item" key={w.id}>
                <div className="info">
                  <div className="name">{w.name}</div>
                  <div className="meta">{w.branch}</div>
                </div>
                <div className="actions">
                  <button
                    className="btn primary"
                    title="Відтворити worktree і заново виконати setup"
                    onClick={() => void restoreWorkspace(w.id)}
                  >
                    ↩ Повернути
                  </button>
                  <button className="btn danger" onClick={() => remove(w.id, w.name)}>
                    🗑 Видалити
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => openArchived(false)}>
            Закрити
          </button>
        </div>
      </div>
    </div>
  )
}
