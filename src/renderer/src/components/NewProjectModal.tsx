import { useEffect, useState } from 'react'
import { useStore } from '../store'

export function NewProjectModal(): JSX.Element {
  const { createProject, openNewProject, busy, error, clearError } = useStore()
  const [repoPath, setRepoPath] = useState('')
  const [repoValid, setRepoValid] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!repoPath) {
      setRepoValid(null)
      return
    }
    window.api.isGitRepo(repoPath).then((ok) => {
      if (!cancelled) setRepoValid(ok)
    })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const setPath = (p: string): void => {
    setRepoPath(p)
    clearError()
  }

  const browse = async (): Promise<void> => {
    const picked = await window.api.pickDir()
    if (picked) setPath(picked)
  }

  const canSubmit = !busy && !!repoPath.trim() && repoValid === true

  // The project name is derived from the repo folder name on the main side.
  const submit = (): void => {
    if (canSubmit) void createProject(repoPath.trim())
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && openNewProject(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <h2>Новий проект</h2>

        <div className="field">
          <label>Репозиторій (git)</label>
          <div className="row">
            <input
              autoFocus
              spellCheck={false}
              value={repoPath}
              disabled={busy}
              placeholder="/шлях/до/репозиторію"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <button className="btn" disabled={busy} onClick={() => void browse()}>
              Огляд…
            </button>
          </div>
          <div className="hint">
            Головний git-репозиторій проекту. Назва проекту береться з назви теки. З репозиторію
            створюються worktree для воркспейсів.
            {repoValid === false && <span className="err"> — це не git-репозиторій.</span>}
            {repoValid === true && <span className="ok"> — git-репозиторій знайдено.</span>}
          </div>
        </div>

        {error && <div className="err">{error}</div>}

        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => openNewProject(false)}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Створення…' : 'Створити'}
          </button>
        </div>
      </div>
    </div>
  )
}
