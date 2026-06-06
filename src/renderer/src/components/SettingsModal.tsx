import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { useStore } from '../store'

type PathField = 'repoPath' | 'worktreesDir' | 'setupScript' | 'runScript' | 'archiveScript'

export function SettingsModal(): JSX.Element {
  const { settings, saveSettings, openSettings } = useStore()
  const [form, setForm] = useState<Settings>(
    settings ?? {
      repoPath: '',
      worktreesDir: '',
      startPort: 3002,
      setupScript: '',
      runScript: '',
      archiveScript: ''
    }
  )
  const [repoValid, setRepoValid] = useState<boolean | null>(null)

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  useEffect(() => {
    let cancelled = false
    if (!form.repoPath) {
      setRepoValid(null)
      return
    }
    window.api.isGitRepo(form.repoPath).then((ok) => {
      if (!cancelled) setRepoValid(ok)
    })
    return () => {
      cancelled = true
    }
  }, [form.repoPath])

  const set = (key: PathField, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const browse = async (key: PathField, dir: boolean): Promise<void> => {
    const picked = dir ? await window.api.pickDir() : await window.api.pickFile()
    if (picked) set(key, picked)
  }

  const canSave =
    !!form.repoPath &&
    !!form.worktreesDir &&
    repoValid !== false &&
    form.startPort >= 1024 &&
    form.startPort <= 65535

  const fields: { key: PathField; label: string; dir: boolean; hint: string }[] = [
    {
      key: 'repoPath',
      label: 'Репозиторій (git)',
      dir: true,
      hint: 'Головний git-репозиторій, з якого створюються worktree.'
    },
    {
      key: 'worktreesDir',
      label: 'Директорія для worktree',
      dir: true,
      hint: 'Де зберігати ізольовані копії воркспейсів.'
    },
    {
      key: 'setupScript',
      label: 'Setup-скрипт',
      dir: false,
      hint: 'Виконується автоматично при створенні воркспейсу.'
    },
    {
      key: 'runScript',
      label: 'Run-скрипт',
      dir: false,
      hint: 'Виконується кнопкою Run. Доступний $CONDUCTOR_PORT.'
    },
    {
      key: 'archiveScript',
      label: 'Archive-скрипт',
      dir: false,
      hint: 'Виконується перед архівацією воркспейсу.'
    }
  ]

  return (
    <div className="modal-backdrop" onClick={() => settings?.repoPath && openSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Налаштування</h2>
        {fields.map((f) => (
          <div className="field" key={f.key}>
            <label>{f.label}</label>
            <div className="row">
              <input
                value={form[f.key]}
                placeholder={f.dir ? '/шлях/до/директорії' : '/шлях/до/скрипта.sh'}
                onChange={(e) => set(f.key, e.target.value)}
              />
              <button className="btn" onClick={() => void browse(f.key, f.dir)}>
                Огляд…
              </button>
            </div>
            <div className="hint">
              {f.hint}
              {f.key === 'repoPath' && repoValid === false && (
                <span className="err"> — це не git-репозиторій.</span>
              )}
              {f.key === 'repoPath' && repoValid === true && (
                <span className="ok"> — git-репозиторій знайдено.</span>
              )}
            </div>
          </div>
        ))}
        <div className="field">
          <label>Початковий порт</label>
          <div className="row">
            <input
              type="number"
              min={1024}
              max={65535}
              style={{ maxWidth: 140 }}
              value={form.startPort}
              onChange={(e) =>
                setForm((f) => ({ ...f, startPort: parseInt(e.target.value, 10) || 0 }))
              }
            />
          </div>
          <div className="hint">
            Воркспейси отримують порти починаючи з цього значення (передається скриптам як
            $CONDUCTOR_PORT).
          </div>
        </div>
        <div className="modal-actions">
          {settings?.repoPath && (
            <button className="btn" onClick={() => openSettings(false)}>
              Скасувати
            </button>
          )}
          <button className="btn primary" disabled={!canSave} onClick={() => void saveSettings(form)}>
            Зберегти
          </button>
        </div>
      </div>
    </div>
  )
}
