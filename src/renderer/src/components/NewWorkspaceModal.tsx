import { useEffect, useMemo, useState } from 'react'
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
  const { projects, workspaces, newWorkspaceProjectId, createWorkspace, openNewWorkspace, busy, error, clearError } =
    useStore()
  const projectId = newWorkspaceProjectId as string
  const project = projects.find((p) => p.id === projectId)
  // One field: both the workspace name and the full branch name.
  const [name, setName] = useState(SUGGESTIONS[Math.floor(performance.now()) % SUGGESTIONS.length])

  const [branches, setBranches] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [search, setSearch] = useState('')
  const [loadingBranches, setLoadingBranches] = useState(true)
  const [branchError, setBranchError] = useState<string | null>(null)

  // Pull branches dynamically (with a fresh git fetch) when the modal opens.
  useEffect(() => {
    let cancelled = false
    window.api
      .listBranches(projectId)
      .then(({ branches, defaultBranch }) => {
        if (cancelled) return
        setBranches(branches)
        setBase(defaultBranch || branches[0] || '')
      })
      .catch((e: Error) => !cancelled && setBranchError(e.message))
      .finally(() => !cancelled && setLoadingBranches(false))
    return () => {
      cancelled = true
    }
  }, [projectId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches
  }, [branches, search])

  const trimmed = name.trim()
  // Live validation: no existing workspace (active or archived) in this project with this name/branch.
  const duplicate = useMemo(
    () =>
      !!trimmed &&
      workspaces.some(
        (w) => w.projectId === projectId && (w.name === trimmed || w.branch === trimmed)
      ),
    [workspaces, trimmed, projectId]
  )

  const canSubmit = !busy && !!trimmed && !duplicate && (!!base || branches.length === 0)

  const submit = (): void => {
    if (canSubmit) void createWorkspace(projectId, trimmed, base || undefined)
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && openNewWorkspace(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <h2>Новий воркспейс{project ? ` · ${project.name}` : ''}</h2>

        <div className="field">
          <label>Назва / гілка</label>
          <input
            autoFocus
            spellCheck={false}
            value={name}
            disabled={busy}
            placeholder="напр. feature/login"
            onChange={(e) => {
              setName(e.target.value)
              clearError()
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="hint">
            Це і назва воркспейсу, і повна назва нової гілки (без обовʼязкового префікса), створеної
            від базової.
            {duplicate && <span className="err"> — воркспейс з такою назвою вже існує.</span>}
          </div>
        </div>

        <div className="field">
          <label>Базова гілка{base ? <span className="branch-current"> · {base}</span> : null}</label>
          <input
            spellCheck={false}
            placeholder="Пошук гілки…"
            value={search}
            disabled={busy || loadingBranches}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length) {
                setBase(filtered[0])
                setSearch('')
              }
            }}
          />
          <div className="branch-list">
            {loadingBranches ? (
              <div className="branch-loading">
                <div className="spinner" />
              </div>
            ) : branchError ? (
              <div className="branch-empty err">{branchError}</div>
            ) : filtered.length === 0 ? (
              <div className="branch-empty">Нічого не знайдено.</div>
            ) : (
              filtered.map((b) => (
                <div
                  key={b}
                  className={`branch-item ${b === base ? 'selected' : ''}`}
                  onClick={() => setBase(b)}
                >
                  {b}
                </div>
              ))
            )}
          </div>
          {error && <div className="err">{error}</div>}
        </div>

        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => openNewWorkspace(null)}>
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
