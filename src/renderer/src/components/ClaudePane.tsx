import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { TerminalView } from './TerminalView'
import { SUBMIT_DELAY_MS, sendRawKey, sendToClaude } from '../claudeSend'

// The composer grows with its content up to ~7 lines, then scrolls.
const MAX_TEXTAREA_PX = 150

// Fallback keys for prompts the chips don't cover (and Esc = interrupt).
const KEYS = [
  { label: '↑', code: '\x1b[A', title: 'Вгору' },
  { label: '↓', code: '\x1b[B', title: 'Вниз' },
  { label: '⏎', code: '\r', title: 'Enter' },
  { label: 'Esc', code: '\x1b', title: 'Перервати / Назад' },
  { label: '⇧Tab', code: '\x1b[Z', title: 'Перемкнути режим (plan / auto-accept)' }
]

/**
 * The Claude tab: a read-only terminal showing the TUI, with all input going
 * through the composer below it. When the TUI draws a select menu, its options
 * are mirrored as clickable chips that send the matching digit to the PTY.
 */
export function ClaudePane({ id }: { id: string }): JSX.Element {
  const { draftById, menuById, claudeBusyById, historyById, setDraft, setMenu, pushHistory } =
    useStore()
  const draft = draftById[id] ?? ''
  const menu = menuById[id] ?? null
  const busy = claudeBusyById[id] ?? false

  const taRef = useRef<HTMLTextAreaElement>(null)
  // Position while walking sent-message history with ArrowUp/Down (null = not walking).
  const histIndex = useRef<number | null>(null)

  useEffect(() => {
    histIndex.current = null
    taRef.current?.focus()
  }, [id])

  // Re-measure on every draft change: typing, history recall, workspace switch.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, MAX_TEXTAREA_PX) + 'px'
  }, [draft, id])

  const focusComposer = (): void => taRef.current?.focus()

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    sendToClaude(id, text)
    pushHistory(id, text)
    setDraft(id, '')
    setMenu(id, null)
    histIndex.current = null
    focusComposer()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
      return
    }
    const history = historyById[id] ?? []
    if (e.key === 'ArrowUp' && (draft === '' || histIndex.current !== null)) {
      if (!history.length) return
      e.preventDefault()
      const next = histIndex.current === null ? history.length - 1 : Math.max(0, histIndex.current - 1)
      histIndex.current = next
      setDraft(id, history[next])
    } else if (e.key === 'ArrowDown' && histIndex.current !== null) {
      e.preventDefault()
      const next = histIndex.current + 1
      if (next >= history.length) {
        histIndex.current = null
        setDraft(id, '')
      } else {
        histIndex.current = next
        setDraft(id, history[next])
      }
    }
  }

  const clickOption = (index: number): void => {
    if (!menu) return
    if (menu.multiSelect) {
      // Digits toggle checkboxes; the menu stays up until Enter confirms, and
      // the next screen scan refreshes the checkbox states on the chips.
      sendRawKey(id, String(index + 1))
      focusComposer()
      return
    }
    if (index < 9) {
      // The TUI selects-and-confirms instantly on a digit press.
      sendRawKey(id, String(index + 1))
    } else {
      // Ten or more options: a digit press is ambiguous (the TUI acts on the
      // first digit), so walk the pointer there with arrows and confirm.
      const delta = index - menu.selectedIndex
      const code = delta >= 0 ? '\x1b[B' : '\x1b[A'
      for (let i = 0; i < Math.abs(delta); i++) sendRawKey(id, code)
      setTimeout(() => sendRawKey(id, '\r'), SUBMIT_DELAY_MS)
    }
    // Optimistic: the settle re-scan re-shows chips if a menu is still on screen.
    setMenu(id, null)
    focusComposer()
  }

  const confirmMultiSelect = (): void => {
    sendRawKey(id, '\r')
    setMenu(id, null)
    focusComposer()
  }

  // Click in the terminal: let xterm finish (text selection must work), then
  // return focus to the composer — the terminal is output-only.
  const onPaneMouseUp = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.term-host')) {
      requestAnimationFrame(focusComposer)
    }
  }

  // Buttons and chips use onMouseDown preventDefault so clicks never blur the composer.
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="claude-pane" onMouseUp={onPaneMouseUp}>
      <TerminalView id={id} kind="claude" />
      {menu && !busy && (
        <div className="menu-chips">
          {menu.options.map((o) => (
            <button
              key={o.index}
              className={`chip ${o.index === menu.selectedIndex ? 'selected' : ''}`}
              title={o.label}
              onMouseDown={keepFocus}
              onClick={() => clickOption(o.index)}
            >
              {o.label}
            </button>
          ))}
          {menu.multiSelect && (
            <button className="chip confirm" onMouseDown={keepFocus} onClick={confirmMultiSelect}>
              ✓ Підтвердити (Enter)
            </button>
          )}
        </div>
      )}
      <div className="composer">
        <div className="composer-row">
          <textarea
            ref={taRef}
            value={draft}
            rows={1}
            placeholder="Напиши повідомлення для Claude… (Enter — надіслати, Shift+Enter — новий рядок)"
            onChange={(e) => {
              histIndex.current = null
              setDraft(id, e.target.value)
            }}
            onKeyDown={onKeyDown}
          />
          <button
            className="send-btn"
            title="Надіслати"
            disabled={!draft.trim()}
            onMouseDown={keepFocus}
            onClick={send}
          >
            ➤
          </button>
        </div>
        <div className="key-strip">
          {KEYS.map((k) => (
            <button
              key={k.label}
              className="key-btn"
              title={k.title}
              onMouseDown={keepFocus}
              onClick={() => sendRawKey(id, k.code)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
