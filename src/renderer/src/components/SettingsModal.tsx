import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { useStore } from '../store'

export function SettingsModal(): JSX.Element {
  const { settings, saveSettings, openSettings } = useStore()
  const [form, setForm] = useState<Settings>(
    settings ?? {
      worktreesDir: '',
      startPort: 3002,
      ideCommand: '',
      claudeArgs: '--dangerously-skip-permissions'
    }
  )

  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  const set = (key: keyof Settings, value: string): void => setForm((f) => ({ ...f, [key]: value }))

  const browseDir = async (): Promise<void> => {
    const picked = await window.api.pickDir()
    if (picked) set('worktreesDir', picked)
  }

  const canSave = !!form.worktreesDir && form.startPort >= 1024 && form.startPort <= 65535

  return (
    <div className="modal-backdrop" onClick={() => openSettings(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Глобальні налаштування</h2>

        <div className="field">
          <label>Директорія для worktree</label>
          <div className="row">
            <input
              value={form.worktreesDir}
              placeholder="/шлях/до/директорії"
              onChange={(e) => set('worktreesDir', e.target.value)}
            />
            <button className="btn" onClick={() => void browseDir()}>
              Огляд…
            </button>
          </div>
          <div className="hint">
            Базова тека, де зберігаються ізольовані worktree. Кожен проект отримує власну підпапку.
          </div>
        </div>

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

        <div className="field">
          <label>IDE</label>
          <div className="row">
            <input
              spellCheck={false}
              placeholder="code"
              value={form.ideCommand}
              onChange={(e) => set('ideCommand', e.target.value)}
            />
          </div>
          <div className="hint">
            Команда для відкриття воркспейсу, напр. code, cursor, subl, webstorm. Шлях до воркспейсу
            передається аргументом.
          </div>
        </div>

        <div className="field">
          <label>Аргументи claude</label>
          <div className="row">
            <input
              spellCheck={false}
              placeholder="--dangerously-skip-permissions"
              value={form.claudeArgs}
              onChange={(e) => set('claudeArgs', e.target.value)}
            />
          </div>
          <div className="hint">
            Додаткові аргументи командного рядка, з якими запускається сесія claude.
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={() => openSettings(false)}>
            Скасувати
          </button>
          <button className="btn primary" disabled={!canSave} onClick={() => void saveSettings(form)}>
            Зберегти
          </button>
        </div>
      </div>
    </div>
  )
}
