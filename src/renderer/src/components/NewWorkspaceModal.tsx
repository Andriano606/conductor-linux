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

/**
 * Pick a random suggested name, skipping any already taken by a workspace in
 * this project. Falls back to the full list if every suggestion is taken.
 */
function pickSuggestion(used: Set<string>): string {
  const free = SUGGESTIONS.filter((s) => !used.has(s))
  const pool = free.length ? free : SUGGESTIONS
  return pool[Math.floor(performance.now()) % pool.length]
}

export function NewWorkspaceModal(): JSX.Element {
  const { projects, workspaces, newWorkspaceProjectId, createWorkspace, openNewWorkspace, busy, error, clearError } =
    useStore()
  const projectId = newWorkspaceProjectId as string
  const project = projects.find((p) => p.id === projectId)
  // One field: both the workspace name and the full branch name. The initial
  // suggestion is random but skips names already taken in this project.
  const [name, setName] = useState(() =>
    pickSuggestion(
      new Set(workspaces.filter((w) => w.projectId === projectId).map((w) => w.branch))
    )
  )

  const [branches, setBranches] = useState<string[]>([])
  const [localBranches, setLocalBranches] = useState<string[]>([])
  const [base, setBase] = useState('')
  const [search, setSearch] = useState('')
  const [loadingBranches, setLoadingBranches] = useState(true)
  const [branchError, setBranchError] = useState<string | null>(null)
  // When on, no new branch is created — the worktree checks out the selected
  // existing branch and stays on it.
  const [useExisting, setUseExisting] = useState(false)

  // Pull branches dynamically (with a fresh git fetch) when the modal opens.
  useEffect(() => {
    let cancelled = false
    window.api
      .listBranches(projectId)
      .then(({ branches, localBranches, defaultBranch }) => {
        if (cancelled) return
        setBranches(branches)
        setLocalBranches(localBranches)
        setBase(defaultBranch || branches[0] || '')
      })
      .catch((e: Error) => !cancelled && setBranchError(e.message))
      .finally(() => !cancelled && setLoadingBranches(false))
    return () => {
      cancelled = true
    }
  }, [projectId])

  // Branches that already back a workspace in this project (active or archived) —
  // their branch is taken, so it can't be reused for a new workspace.
  const usedBranches = useMemo(
    () => new Set(workspaces.filter((w) => w.projectId === projectId).map((w) => w.branch)),
    [workspaces, projectId]
  )

  // In existing-branch mode only local branches are selectable (a remote-tracking
  // ref would force git to create a new local branch, defeating the purpose).
  const sourceBranches = useExisting ? localBranches : branches

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? sourceBranches.filter((b) => b.toLowerCase().includes(q)) : sourceBranches
  }, [sourceBranches, search])

  const trimmed = name.trim()
  // Live validation: no existing workspace (active or archived) in this project with this name/branch.
  const duplicate = useMemo(
    () => !!trimmed && usedBranches.has(trimmed),
    [usedBranches, trimmed]
  )

  const baseTaken = useExisting && !!base && usedBranches.has(base)
  // Block submit until branches have loaded: before that `branches` is empty and
  // `base` unset, so the non-existing-mode check would otherwise pass on name
  // alone and create a workspace off the wrong base.
  const canSubmit = !loadingBranches && (useExisting
    ? !busy && !!base && !baseTaken
    : !busy && !!trimmed && !duplicate && (!!base || branches.length === 0))

  const toggleExisting = (next: boolean): void => {
    setUseExisting(next)
    setSearch('')
    clearError()
    // Re-pick a valid selection for the new source list: an unused local branch
    // when switching into existing mode.
    if (next) {
      const firstFree = localBranches.find((b) => !usedBranches.has(b)) || ''
      if (!base || usedBranches.has(base) || !localBranches.includes(base)) setBase(firstFree)
    }
  }

  const submit = (): void => {
    if (!canSubmit) return
    if (useExisting) void createWorkspace(projectId, base, undefined, true)
    else void createWorkspace(projectId, trimmed, base || undefined, false)
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && openNewWorkspace(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <h2>Новий воркспейс{project ? ` · ${project.name}` : ''}</h2>

        <label className="switch-row">
          <span>Використати існуючу гілку (не створювати нову)</span>
          <span className="switch">
            <input
              type="checkbox"
              checked={useExisting}
              disabled={busy}
              onChange={(e) => toggleExisting(e.target.checked)}
            />
            <span className="slider" />
          </span>
        </label>

        <div className={`field ${useExisting ? 'field-muted' : ''}`}>
          <label>Назва / гілка</label>
          <input
            autoFocus
            spellCheck={false}
            value={useExisting ? '' : name}
            disabled={busy || useExisting}
            placeholder={useExisting ? 'не використовується — назва дорівнює обраній гілці' : 'напр. feature/login'}
            onChange={(e) => {
              setName(e.target.value)
              clearError()
            }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="hint hint-fixed">
            {useExisting ? (
              'Назва воркспейсу = обрана гілка. Воркспейс відкриється прямо на ній — нова гілка не створюється.'
            ) : (
              <>
                Це і назва воркспейсу, і повна назва нової гілки (без обовʼязкового префікса),
                створеної від базової.
                {duplicate && <span className="err"> — воркспейс з такою назвою вже існує.</span>}
              </>
            )}
          </div>
        </div>

        <div className="field">
          <label>
            {useExisting ? 'Гілка' : 'Базова гілка'}
            {base ? <span className="branch-current"> · {base}</span> : null}
          </label>
          <input
            spellCheck={false}
            placeholder="Пошук гілки…"
            value={search}
            disabled={busy || loadingBranches}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length) {
                const first = filtered.find((b) => !(useExisting && usedBranches.has(b)))
                if (first) {
                  setBase(first)
                  setSearch('')
                }
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
              <div className="branch-empty">
                {useExisting && sourceBranches.length === 0
                  ? 'Немає локальних гілок.'
                  : 'Нічого не знайдено.'}
              </div>
            ) : (
              filtered.map((b) => {
                const taken = useExisting && usedBranches.has(b)
                return (
                  <div
                    key={b}
                    className={`branch-item ${b === base ? 'selected' : ''} ${taken ? 'disabled' : ''}`}
                    onClick={() => !taken && setBase(b)}
                    title={taken ? 'Для цієї гілки вже є воркспейс' : undefined}
                  >
                    {b}
                    {taken && <span className="branch-tag"> — вже використовується</span>}
                  </div>
                )
              })
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
