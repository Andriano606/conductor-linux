import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { Workspace } from '@shared/types'

export function Toolbar({ ws }: { ws: Workspace }): JSX.Element {
  // Current branch is read live from the worktree (the user may `git checkout`
  // in the terminal), refreshed on switch and when the window regains focus.
  const [curBranch, setCurBranch] = useState('')
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.api.currentBranch(ws.id).then((b) => !cancelled && setCurBranch(b))
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [ws.id, ws.status])

  const {
    activeKind,
    setKind,
    runActive,
    stopActive,
    openActiveInBrowser,
    openActiveInIde,
    archiveActive,
    askConfirm,
    busy,
    runningById,
    settings
  } = useStore()
  const ideConfigured = !!settings?.ideCommand
  const settingUp = ws.status === 'setting_up'
  const archiving = ws.status === 'archiving'
  const running = !!runningById[ws.id]

  const archive = async (): Promise<void> => {
    if (await askConfirm(`Архівувати воркспейс «${ws.name}»? Worktree буде видалено.`)) {
      void archiveActive()
    }
  }

  return (
    <>
      <div className="toolbar">
        <div className="title">
          <div className="title-main">
            {ws.name}
            <small>{ws.path}</small>
          </div>
          <div className="branch-info">
            <span title="Поточна гілка">⎇ {curBranch || ws.branch}</span>
            <span className="from" title="Базова гілка (звідки створено)">
              {' '}
              ← {ws.baseBranch || 'локальний HEAD'}
            </span>
          </div>
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
        <button
          className="btn"
          onClick={openActiveInBrowser}
          disabled={!running}
          title={
            running
              ? `Відкрити http://localhost:${ws.port} у браузері`
              : 'Спочатку запусти run-скрипт'
          }
        >
          🌐 У браузері
        </button>
        <button
          className="btn"
          onClick={openActiveInIde}
          disabled={settingUp || archiving || !ideConfigured}
          title={
            ideConfigured
              ? `Відкрити воркспейс у «${settings?.ideCommand}»`
              : 'Вкажи IDE в налаштуваннях'
          }
        >
          ⧉ Відкрити в IDE
        </button>
        <button className="btn danger" onClick={() => void archive()} disabled={archiving}>
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
          className={`tab ${activeKind === 'shell' ? 'active' : ''}`}
          onClick={() => setKind('shell')}
        >
          Термінал
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
