import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Workspace } from '@shared/types'
import { workspaceUrl } from '@shared/workspaceUrl'

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
    settings,
    projects
  } = useStore()
  const browserUrl = workspaceUrl(
    projects.find((p) => p.id === ws.projectId)?.browserHost,
    ws.port
  )
  const ideConfigured = !!settings?.ideCommand
  const settingUp = ws.status === 'setting_up'
  const archiving = ws.status === 'archiving'
  const running = !!runningById[ws.id]

  const archive = async (): Promise<void> => {
    if (await askConfirm(`Архівувати воркспейс «${ws.name}»? Worktree буде видалено.`)) {
      void archiveActive()
    }
  }

  const curBranchName = curBranch || ws.branch
  const baseBranchName = ws.baseBranch || 'локальний HEAD'

  return (
    <>
      <div className="toolbar">
        <div className="title">
          <div className="title-main">{ws.name}</div>
          <div className="branch-info">
            <BranchBadge icon="⎇" label="Поточна гілка" value={curBranchName} kind="cur" />
            <BranchBadge icon="←" label="Базова гілка" value={baseBranchName} kind="from" />
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
              ? `Відкрити ${browserUrl} у браузері`
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

const MAX_BRANCH_CHARS = 15

// A branch badge: shows the name truncated to MAX_BRANCH_CHARS. Hovering pops
// the full name; clicking copies it and flashes a green "Скопійовано ✓".
function BranchBadge({
  icon,
  label,
  value,
  kind
}: {
  icon: string
  label: string
  value: string
  kind: 'cur' | 'from'
}): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = (): void => {
    void navigator.clipboard.writeText(value)
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  const truncated =
    value.length > MAX_BRANCH_CHARS ? value.slice(0, MAX_BRANCH_CHARS - 1) + '…' : value

  return (
    <span className="branch-badge-wrap">
      <button
        type="button"
        className={`branch-badge ${kind}`}
        onClick={copy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span className="bb-icon">{icon}</span>
        <span className="bb-name">{truncated}</span>
      </button>
      {copied ? (
        <span className="branch-pop copied" role="status">
          <span className="bb-check">✓</span> Скопійовано
        </span>
      ) : (
        hovered && (
          <span className="branch-pop">
            <span className="bb-pop-label">{label}</span>
            <code>{value}</code>
          </span>
        )
      )}
    </span>
  )
}
