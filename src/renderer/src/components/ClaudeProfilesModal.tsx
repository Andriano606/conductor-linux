import { useEffect, useState } from 'react'
import type { ClaudeProfile } from '@shared/types'
import { useStore } from '../store'

/**
 * Manage the global list of named Claude config profiles (each a
 * CLAUDE_CONFIG_DIR) AND pick which one the given session runs under. Selecting a
 * profile for the session restarts its claude process (resuming the conversation)
 * so the new config dir takes effect; "Без профілю" reverts to the default
 * ~/.claude. Modeled on PromptLibraryModal.
 */
export function ClaudeProfilesModal({
  sessionId,
  onClose
}: {
  sessionId: string
  onClose: () => void
}): JSX.Element {
  const {
    claudeProfiles,
    workspaces,
    claudeBusyById,
    createClaudeProfile,
    updateClaudeProfile,
    deleteClaudeProfile,
    setSessionProfile,
    askConfirm
  } = useStore()

  // The session we're attaching a profile to (look it up across workspaces).
  const session = workspaces.flatMap((w) => w.sessions).find((s) => s.id === sessionId)
  const currentProfileId = session?.claudeConfigProfileId
  const sessionBusy = !!claudeBusyById[sessionId]

  // Pending session-profile choice: the radios only stage it; it's applied on
  // submit ("Застосувати"), not live on each change.
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(currentProfileId)
  useEffect(() => {
    setSelectedProfileId(currentProfileId)
  }, [currentProfileId])
  const selectionChanged = selectedProfileId !== currentProfileId

  // null id = composing a new profile; otherwise editing the selected one.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  // Home dir, used to prefill the path for a new profile (~/.claude) so the
  // picker opens inside it — the GNOME portal chooser hides dotfiles otherwise.
  const [home, setHome] = useState('')
  useEffect(() => {
    void window.api.homeDir().then(setHome)
  }, [])
  useEffect(() => {
    if (!editingId && !path && home) setPath(`${home}/.claude`)
  }, [home, editingId, path])

  const reset = (): void => {
    setEditingId(null)
    setName('')
    setPath(home ? `${home}/.claude` : '')
  }

  const startEdit = (p: ClaudeProfile): void => {
    setEditingId(p.id)
    setName(p.name)
    setPath(p.path)
  }

  const browseDir = async (): Promise<void> => {
    // Open the dialog inside the typed path (or home) so even a hidden target is
    // visible/selectable.
    const picked = await window.api.pickDir(path.trim() || home || undefined)
    if (picked) setPath(picked)
  }

  const canSave = !!name.trim() && !!path.trim()

  const save = async (): Promise<void> => {
    if (!canSave) return
    const n = name.trim()
    const p = path.trim()
    if (editingId) {
      const existing = claudeProfiles.find((x) => x.id === editingId)
      if (existing) await updateClaudeProfile({ ...existing, name: n, path: p })
    } else {
      await createClaudeProfile(n, p)
    }
    reset()
  }

  const remove = async (p: ClaudeProfile): Promise<void> => {
    if (await askConfirm(`Видалити профіль «${p.name}»?`)) {
      if (editingId === p.id) reset()
      void deleteClaudeProfile(p.id)
    }
  }

  const applyProfile = (): void => {
    if (selectionChanged) void setSessionProfile(sessionId, selectedProfileId)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Конфігурації Claude</h2>

        <div className="field">
          <label>Профіль для цієї сесії</label>
          {sessionBusy && (
            <div className="hint">
              Claude зараз працює — зміна профілю перезапустить сесію. Краще зачекати завершення
              відповіді.
            </div>
          )}
          <div className="profile-pick-list">
            <label className="profile-pick">
              <input
                type="radio"
                name="session-profile"
                checked={!selectedProfileId}
                onChange={() => setSelectedProfileId(undefined)}
              />
              <span className="profile-pick-name">Без профілю (стандартний ~/.claude)</span>
            </label>
            {claudeProfiles.map((p) => (
              <label key={p.id} className="profile-pick">
                <input
                  type="radio"
                  name="session-profile"
                  checked={selectedProfileId === p.id}
                  onChange={() => setSelectedProfileId(p.id)}
                />
                <span className="profile-pick-name">{p.name}</span>
                <span className="profile-pick-path">{p.path}</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={!selectionChanged} onClick={applyProfile}>
              Застосувати для сесії
            </button>
          </div>
        </div>

        <div className="field">
          <label>Збережені профілі</label>
          {claudeProfiles.length === 0 ? (
            <div className="hint">Ще немає профілів. Додай перший нижче.</div>
          ) : (
            <div className="prompt-list">
              {claudeProfiles.map((p) => (
                <div key={p.id} className={`prompt-item ${editingId === p.id ? 'sel' : ''}`}>
                  <div className="prompt-text">
                    <div className="prompt-title">{p.name}</div>
                    <div className="prompt-preview">{p.path}</div>
                  </div>
                  <div className="prompt-actions">
                    <button className="btn" title="Редагувати" onClick={() => startEdit(p)}>
                      ✎
                    </button>
                    <button className="btn danger" title="Видалити" onClick={() => void remove(p)}>
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="field">
          <label>{editingId ? 'Редагування профілю' : 'Новий профіль'}</label>
          <input value={name} placeholder="Назва" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <div className="row">
            <input
              spellCheck={false}
              value={path}
              placeholder="/шлях/до/.claude"
              onChange={(e) => setPath(e.target.value)}
            />
            <button className="btn" onClick={() => void browseDir()}>
              Огляд…
            </button>
          </div>
          <div className="hint">
            Тека, яку буде передано сесії як CLAUDE_CONFIG_DIR (свій ~/.claude — налаштування,
            акаунт, MCP).
          </div>
        </div>

        <div className="modal-actions">
          {editingId && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={reset}>
              + Новий
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Закрити
          </button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
            {editingId ? 'Зберегти' : 'Додати'}
          </button>
        </div>
      </div>
    </div>
  )
}
