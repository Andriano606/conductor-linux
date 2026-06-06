import { useStore } from '../store'

// In-app confirmation dialog. Replaces the native window.confirm(), which on
// Linux leaves the BrowserWindow without input focus afterwards — making the
// next modal's fields look "frozen" until you click outside the window.
export function ConfirmModal(): JSX.Element | null {
  const { confirmRequest, resolveConfirm } = useStore()
  if (!confirmRequest) return null

  return (
    <div className="modal-backdrop" onClick={() => resolveConfirm(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
        <h2>Підтвердження</h2>
        <div className="hint" style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>
          {confirmRequest.message}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => resolveConfirm(false)}>
            Скасувати
          </button>
          <button className="btn danger" autoFocus onClick={() => resolveConfirm(true)}>
            Підтвердити
          </button>
        </div>
      </div>
    </div>
  )
}
