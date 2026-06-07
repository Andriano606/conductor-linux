import { useEffect, useState } from 'react'
import { useStore } from '../store'

type ScriptField = 'setupScript' | 'runScript' | 'archiveScript'

const SCRIPTS: { key: ScriptField; label: string; hint: string }[] = [
  {
    key: 'setupScript',
    label: 'Setup-скрипт',
    hint: 'Виконується автоматично при створенні воркспейсу.'
  },
  { key: 'runScript', label: 'Run-скрипт', hint: 'Виконується кнопкою Run. Доступний $CONDUCTOR_PORT.' },
  { key: 'archiveScript', label: 'Archive-скрипт', hint: 'Виконується перед архівацією воркспейсу.' }
]

export function NewProjectModal(): JSX.Element {
  const { createProject, openNewProject, busy, error, clearError } = useStore()
  const [repoPath, setRepoPath] = useState('')
  const [browserHost, setBrowserHost] = useState('')
  const [scripts, setScripts] = useState<Record<ScriptField, string>>({
    setupScript: '',
    runScript: '',
    archiveScript: ''
  })
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
  const setScript = (key: ScriptField, value: string): void =>
    setScripts((s) => ({ ...s, [key]: value }))

  const browseDir = async (): Promise<void> => {
    const picked = await window.api.pickDir()
    if (picked) setPath(picked)
  }
  const browseScript = async (key: ScriptField): Promise<void> => {
    const picked = await window.api.pickFile()
    if (picked) setScript(key, picked)
  }

  const canSubmit = !busy && !!repoPath.trim() && repoValid === true

  // The project name is derived from the repo folder name on the main side.
  const submit = (): void => {
    if (canSubmit) void createProject(repoPath.trim(), { ...scripts, browserHost })
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
            <button className="btn" disabled={busy} onClick={() => void browseDir()}>
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

        {SCRIPTS.map((s) => (
          <div className="field" key={s.key}>
            <label>{s.label}</label>
            <div className="row">
              <input
                value={scripts[s.key]}
                disabled={busy}
                placeholder="/шлях/до/скрипта.sh"
                onChange={(e) => setScript(s.key, e.target.value)}
              />
              <button className="btn" disabled={busy} onClick={() => void browseScript(s.key)}>
                Огляд…
              </button>
            </div>
            <div className="hint">{s.hint}</div>
          </div>
        ))}

        <div className="field">
          <label>Хост для «У браузері»</label>
          <input
            spellCheck={false}
            value={browserHost}
            disabled={busy}
            placeholder="localhost"
            onChange={(e) => setBrowserHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="hint">
            Адреса для кнопки «У браузері»: <code>{`http://${browserHost.trim() || 'localhost'}:<порт>`}</code>.
            Порожнє — <code>localhost</code>.
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
