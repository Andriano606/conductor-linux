import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { Workspace } from '@shared/types'

// Rename the workspace's git branch. Opened from the "Поточна гілка" badge's
// right-click menu. Renames locally only (git branch -m) — if the branch was
// pushed, we surface a note that origin keeps the old name. The workspace's
// display name (ws.name) is left untouched; only the branch changes.
export function RenameBranchModal({
  ws,
  onClose,
  onRenamed
}: {
  ws: Workspace
  onClose: () => void
  onRenamed: (newName: string) => void
}): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const [name, setName] = useState(ws.branch)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Set after a successful rename of a pushed branch, to show the remote note.
  const [pushed, setPushed] = useState<{ old: string; neu: string } | null>(null)

  // Cheap client-side checks; main re-validates authoritatively (incl. whether
  // the branch already exists in git).
  const taken = useMemo(
    () =>
      new Set(
        workspaces
          .filter((w) => w.id !== ws.id && w.projectId === ws.projectId)
          .flatMap((w) => [w.name, w.branch])
      ),
    [workspaces, ws.id, ws.projectId]
  )

  const trimmed = name.trim()
  const localErr = !trimmed
    ? 'Введи назву гілки.'
    : trimmed === ws.branch
      ? 'Це поточна назва гілки.'
      : taken.has(trimmed)
        ? `Воркспейс із назвою «${trimmed}» вже існує.`
        : null

  const submit = async (): Promise<void> => {
    if (localErr || busy) return
    setBusy(true)
    setErr(null)
    try {
      const { remoteExists } = await window.api.renameBranch(ws.id, trimmed)
      onRenamed(trimmed)
      if (remoteExists) setPushed({ old: ws.branch, neu: trimmed })
      else onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
        <h2>Перейменувати гілку</h2>
        {pushed ? (
          <>
            <div className="field">
              <div className="hint ok">
                Гілку перейменовано локально: «{pushed.old}» → «{pushed.neu}».
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                Віддалена гілка <code>origin/{pushed.old}</code> лишилась без змін. За потреби
                перепуш її вручну:
                <br />
                <code>git push -u origin {pushed.neu}</code>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn primary" autoFocus onClick={onClose}>
                Готово
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Нова назва гілки</label>
              <input
                value={name}
                autoFocus
                disabled={busy}
                onChange={(e) => {
                  setName(e.target.value)
                  setErr(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                  else if (e.key === 'Escape') onClose()
                }}
              />
              {(err || (localErr && trimmed !== ws.branch)) && (
                <div className="hint err">{err || localErr}</div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={onClose} disabled={busy}>
                Скасувати
              </button>
              <button
                className="btn primary"
                onClick={() => void submit()}
                disabled={busy || !!localErr}
              >
                {busy ? 'Перейменування…' : 'Перейменувати'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
