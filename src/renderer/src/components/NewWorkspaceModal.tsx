import { useState } from 'react'
import { useStore } from '../store'

const SUGGESTIONS = [
  'lisbon',
  'porto',
  'kyiv',
  'oslo',
  'tokyo',
  'cairo',
  'lima',
  'dakar',
  'hanoi',
  'sofia'
]

export function NewWorkspaceModal(): JSX.Element {
  const { createWorkspace, openNew, busy, error, clearError } = useStore()
  const [name, setName] = useState(SUGGESTIONS[Math.floor(performance.now()) % SUGGESTIONS.length])

  const submit = (): void => {
    if (name.trim()) void createWorkspace(name.trim())
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && openNew(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <h2>Новий воркспейс</h2>
        <div className="field">
          <label>Назва</label>
          <input
            autoFocus
            value={name}
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value)
              clearError()
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="hint">
            Створить git worktree на гілці <code>conductor/&lt;назва&gt;</code> і запустить setup-скрипт.
            {error && <div className="err">{error}</div>}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => openNew(false)}>
            Скасувати
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? 'Створення…' : 'Створити'}
          </button>
        </div>
      </div>
    </div>
  )
}
