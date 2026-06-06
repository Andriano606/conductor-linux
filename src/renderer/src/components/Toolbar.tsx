import { useStore } from '../store'
import type { Workspace } from '@shared/types'

export function Toolbar({ ws }: { ws: Workspace }): JSX.Element {
  const { activeKind, setKind, runActive, stopActive, archiveActive, busy, runningById } = useStore()
  const settingUp = ws.status === 'setting_up'
  const archiving = ws.status === 'archiving'
  const running = !!runningById[ws.id]

  const archive = (): void => {
    if (confirm(`Архівувати воркспейс «${ws.name}»? Worktree буде видалено.`)) {
      void archiveActive()
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="title">
          {ws.name}
          <small>{ws.path}</small>
        </div>
        {running ? (
          <button
            className="btn stop"
            onClick={() => void stopActive()}
            disabled={archiving}
            title="Зупинити run-скрипт"
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => void runActive()}
            disabled={busy || settingUp || archiving}
            title={settingUp ? 'Зачекай завершення setup' : 'Запустити run-скрипт'}
          >
            ▶ Run
          </button>
        )}
        <button className="btn danger" onClick={archive} disabled={archiving}>
          {archiving ? 'Архівується…' : 'Архівувати'}
        </button>
      </div>
      <div className="tabs">
        <button
          className={`tab ${activeKind === 'claude' ? 'active' : ''}`}
          onClick={() => setKind('claude')}
        >
          Claude
        </button>
        <button
          className={`tab ${activeKind === 'task' ? 'active' : ''}`}
          onClick={() => setKind('task')}
        >
          Скрипти
        </button>
      </div>
    </>
  )
}
