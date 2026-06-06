import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { useStore } from '../store'

type ScriptField = 'setupScript' | 'runScript' | 'archiveScript'

export function ProjectSettingsModal(): JSX.Element | null {
  const { projects, projectSettingsId, saveProject, deleteProject, openProjectSettings, askConfirm, error } =
    useStore()
  const project = projects.find((p) => p.id === projectSettingsId)
  const [form, setForm] = useState<Project | null>(project ?? null)
  const [repoValid, setRepoValid] = useState<boolean | null>(null)

  useEffect(() => {
    setForm(project ?? null)
  }, [project])

  useEffect(() => {
    let cancelled = false
    if (!form?.repoPath) {
      setRepoValid(null)
      return
    }
    window.api.isGitRepo(form.repoPath).then((ok) => {
      if (!cancelled) setRepoValid(ok)
    })
    return () => {
      cancelled = true
    }
  }, [form?.repoPath])

  if (!form) return null

  const set = (key: keyof Project, value: string): void =>
    setForm((f) => (f ? { ...f, [key]: value } : f))

  const browseDir = async (): Promise<void> => {
    const picked = await window.api.pickDir()
    if (picked) set('repoPath', picked)
  }
  const browseScript = async (key: ScriptField): Promise<void> => {
    const picked = await window.api.pickFile()
    if (picked) set(key, picked)
  }

  const canSave = !!form.name.trim() && !!form.repoPath.trim() && repoValid !== false

  const remove = async (): Promise<void> => {
    if (
      await askConfirm(
        `Видалити проект «${form.name}» разом з усіма його воркспейсами? Гілки git буде видалено — це незворотно.`
      )
    ) {
      void deleteProject(form.id)
    }
  }

  const scripts: { key: ScriptField; label: string; hint: string }[] = [
    {
      key: 'setupScript',
      label: 'Setup-скрипт',
      hint: 'Виконується автоматично при створенні воркспейсу.'
    },
    {
      key: 'runScript',
      label: 'Run-скрипт',
      hint: 'Виконується кнопкою Run. Доступний $CONDUCTOR_PORT.'
    },
    {
      key: 'archiveScript',
      label: 'Archive-скрипт',
      hint: 'Виконується перед архівацією воркспейсу.'
    }
  ]

  return (
    <div className="modal-backdrop" onClick={() => openProjectSettings(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Налаштування проекту</h2>

        <div className="field">
          <label>Назва проекту</label>
          <input spellCheck={false} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>

        <div className="field">
          <label>Репозиторій (git)</label>
          <div className="row">
            <input
              spellCheck={false}
              value={form.repoPath}
              placeholder="/шлях/до/репозиторію"
              onChange={(e) => set('repoPath', e.target.value)}
            />
            <button className="btn" onClick={() => void browseDir()}>
              Огляд…
            </button>
          </div>
          <div className="hint">
            Головний git-репозиторій, з якого створюються worktree.
            {repoValid === false && <span className="err"> — це не git-репозиторій.</span>}
            {repoValid === true && <span className="ok"> — git-репозиторій знайдено.</span>}
          </div>
        </div>

        {scripts.map((s) => (
          <div className="field" key={s.key}>
            <label>{s.label}</label>
            <div className="row">
              <input
                value={form[s.key]}
                placeholder="/шлях/до/скрипта.sh"
                onChange={(e) => set(s.key, e.target.value)}
              />
              <button className="btn" onClick={() => void browseScript(s.key)}>
                Огляд…
              </button>
            </div>
            <div className="hint">{s.hint}</div>
          </div>
        ))}

        {error && <div className="err">{error}</div>}

        <div className="modal-actions">
          <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}>
            🗑 Видалити проект
          </button>
          <button className="btn" onClick={() => openProjectSettings(null)}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!canSave} onClick={() => void saveProject(form)}>
            Зберегти
          </button>
        </div>
      </div>
    </div>
  )
}
