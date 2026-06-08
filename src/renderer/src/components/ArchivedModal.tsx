import { useStore } from '../store'

export function ArchivedModal(): JSX.Element {
  const { workspaces, openArchived, restoreWorkspace, deleteWorkspace, askConfirm, error } = useStore()
  const archived = workspaces.filter((w) => w.status === 'archived')

  const remove = async (id: string, name: string): Promise<void> => {
    if (
      await askConfirm(`Видалити воркспейс «${name}» назавжди? Гілку git буде видалено — це незворотно.`)
    ) {
      void deleteWorkspace(id)
    }
  }

  const removeAll = async (): Promise<void> => {
    if (
      await askConfirm(
        `Видалити всі архівовані воркспейси (${archived.length}) назавжди? Гілки git буде видалено — це незворотно.`
      )
    ) {
      for (const w of archived) void deleteWorkspace(w.id)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => openArchived(false)}>
      <div
        className="modal archived-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 520 }}
      >
        <h2>Архівовані воркспейси</h2>
        {error && <div className="err">{error}</div>}
        <div className="archived-list">
          {archived.length === 0 ? (
            <div className="hint">Архів порожній.</div>
          ) : (
            archived.map((w) => (
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
                  <button className="btn danger" onClick={() => void remove(w.id, w.name)}>
                    🗑 Видалити
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          {archived.length > 0 && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={() => void removeAll()}
            >
              🗑 Видалити всі
            </button>
          )}
          <button className="btn" onClick={() => openArchived(false)}>
            Закрити
          </button>
        </div>
      </div>
    </div>
  )
}
