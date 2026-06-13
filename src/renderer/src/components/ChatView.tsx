import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatItem, ChatPending, ChatQuestion } from '@shared/types'
import { useChatStore } from '../chatStore'

/**
 * The Claude tab: our own chat UI over the structured stream-json session.
 * Claude's messages render as a transcript; the bottom input sends commands.
 * When Claude asks a clarifying question its options appear as buttons in the
 * input area, and the text field doubles as the free-form "свій варіант";
 * permission requests render as Дозволити/Відхилити.
 */
export function ChatView({ id }: { id: string }): JSX.Element {
  const chat = useChatStore((s) => s.byId[id])
  const attach = useChatStore((s) => s.attach)

  const [draft, setDraft] = useState('')
  // Sequential answering of a multi-question AskUserQuestion call.
  const [qIndex, setQIndex] = useState(0)
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({})
  const [multiSel, setMultiSel] = useState<string[]>([])
  // Arrow-key recall of previously sent messages: the index into `history`
  // while browsing (null = not browsing) and the draft saved on entry so
  // stepping past the newest entry restores what was being typed.
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const savedDraftRef = useRef('')
  // Slash-command autocomplete: selection inside the popup, and whether the
  // user dismissed it with Esc (until the draft changes again).
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void attach(id)
  }, [id, attach])

  const pending = chat?.pending ?? null
  const busy = chat?.busy ?? false
  const items = chat?.items ?? []

  // What the user actually typed and sent, oldest → newest. Option-answer
  // summaries (answer: true) are not recallable commands, so they're skipped;
  // consecutive duplicates collapse like shell history.
  const history = useMemo(
    () =>
      items
        .filter((it) => it.role === 'user' && !it.answer)
        .map((it) => it.text)
        .filter((t, i, a) => i === 0 || t !== a[i - 1]),
    [items]
  )

  const exitHistory = (): void => {
    setHistIndex(null)
    savedDraftRef.current = ''
  }

  // Slash-command menu, terminal-style: opens while the draft is exactly a
  // "/command" token being typed (no args/whitespace yet), filters as you
  // type. Selection completes into the input; sending stays an explicit Enter.
  const commands = chat?.commands ?? []
  const slashQuery =
    !pending && !slashDismissed && /^\/[\w:-]*$/.test(draft) ? draft.slice(1) : null
  const slashMatches = useMemo(
    () =>
      slashQuery === null
        ? []
        : commands
            .filter((c) => c.name.startsWith(slashQuery))
            // Alphabetical, like the terminal — so the full list scans predictably.
            .sort((a, b) => a.name.localeCompare(b.name)),
    [slashQuery, commands]
  )
  const menuOpen = slashMatches.length > 0
  const slashCur = Math.min(slashSel, slashMatches.length - 1)
  useEffect(() => setSlashSel(0), [slashQuery])

  const completeSlash = (cmd: string): void => {
    // The trailing space ends the command token, which also closes the menu.
    setDraft(`/${cmd} `)
    setHistIndex(null)
    inputRef.current?.focus()
  }

  /** Keys while the slash menu is open. Returns true when consumed. */
  const handleSlashKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const n = slashMatches.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashSel((slashCur + 1) % n)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashSel((slashCur - 1 + n) % n)
      return true
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      // An exactly-typed command falls through so Enter sends it.
      if (e.key === 'Enter' && draft === `/${slashMatches[slashCur].name}`) return false
      e.preventDefault()
      completeSlash(slashMatches[slashCur].name)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlashDismissed(true)
      return true
    }
    return false
  }

  // A new pending request restarts the local answering state.
  useEffect(() => {
    setQIndex(0)
    setQAnswers({})
    setMultiSel([])
    exitHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId, id])

  // A recalled entry should read like freshly typed text — caret at the end
  // (a controlled-value swap otherwise leaves it wherever it was).
  useEffect(() => {
    if (histIndex === null) return
    const el = inputRef.current
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  }, [histIndex, draft])

  // Keep the transcript pinned to the bottom unless the user scrolled away.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, pending, busy])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40
  }

  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    window.api.sendChat(id, text)
    setDraft('')
    exitHistory()
  }

  /**
   * Terminal-style history recall. Up steps to older sent messages, Down to
   * newer ones and finally back to the saved draft. Only triggers when the
   * caret is on the first (Up) / last (Down) line, so arrows still navigate
   * inside a multiline draft. Returns true when the key was consumed.
   */
  const handleHistory = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget
    if (e.key === 'ArrowUp') {
      if (!history.length) return false
      const onFirstLine = !draft.slice(0, el.selectionStart ?? 0).includes('\n')
      if (!onFirstLine) return false
      e.preventDefault()
      const idx = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1)
      if (histIndex === null) savedDraftRef.current = draft
      setHistIndex(idx)
      setDraft(history[idx])
      return true
    }
    // ArrowDown
    if (histIndex === null) return false
    const onLastLine = !draft.slice(el.selectionEnd ?? draft.length).includes('\n')
    if (!onLastLine) return false
    e.preventDefault()
    if (histIndex < history.length - 1) {
      setHistIndex(histIndex + 1)
      setDraft(history[histIndex + 1])
    } else {
      setDraft(savedDraftRef.current)
      exitHistory()
    }
    return true
  }

  const finishQuestion = (p: Extract<ChatPending, { kind: 'question' }>, answers: Record<string, string>): void => {
    window.api.answerChat(id, { kind: 'question', requestId: p.requestId, answers })
  }

  /** Record the answer for the current question; submit after the last one. */
  const answerCurrent = (value: string): void => {
    if (pending?.kind !== 'question') return
    const qs = pending.questions
    const q = qs[qIndex]
    if (!q) return
    const next = { ...qAnswers, [q.question]: value }
    setDraft('')
    exitHistory()
    if (qIndex + 1 < qs.length) {
      setQAnswers(next)
      setQIndex(qIndex + 1)
      setMultiSel([])
    } else {
      finishQuestion(pending, next)
    }
  }

  const answerPermission = (allow: boolean): void => {
    if (pending?.kind !== 'permission') return
    window.api.answerChat(id, {
      kind: 'permission',
      requestId: pending.requestId,
      allow,
      message: allow ? undefined : draft.trim() || undefined
    })
    setDraft('')
    exitHistory()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && handleSlashKeys(e)) return
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && handleHistory(e)) return
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (pending?.kind === 'question') {
      if (draft.trim()) answerCurrent(draft.trim())
    } else if (pending?.kind === 'permission') {
      answerPermission(false)
    } else {
      send()
    }
  }

  const placeholder =
    pending?.kind === 'question'
      ? 'Свій варіант відповіді… (Enter — надіслати)'
      : pending?.kind === 'permission'
        ? 'Поясни, що зробити інакше… (Enter — відхилити з коментарем)'
        : 'Напиши Claude… (Enter — надіслати, Shift+Enter — новий рядок)'

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {items.length === 0 && !busy && (
          <div className="chat-empty">
            Це чат із Claude для цього воркспейсу. Напиши команду внизу — відповіді, дії
            інструментів і питання Claude з'являться тут.
          </div>
        )}
        {items.map((it) => (
          <ChatItemView key={it.id} item={it} />
        ))}
        {busy && <div className="chat-typing" aria-label="Claude працює"><span /><span /><span /></div>}
      </div>

      <div className="chat-inputarea">
        {menuOpen && (
          <div className="chat-slash-menu" role="listbox">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === slashCur}
                className={`slash-item ${i === slashCur ? 'sel' : ''}`}
                ref={i === slashCur ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined}
                onMouseEnter={() => setSlashSel(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => completeSlash(c.name)}
              >
                <span className="slash-name">
                  /{c.name}
                  {c.argumentHint ? <span className="slash-args"> {c.argumentHint}</span> : null}
                </span>
                {c.description && <span className="slash-desc">{c.description}</span>}
              </button>
            ))}
            <div className="slash-hint">↑↓ — вибір · Tab/Enter — підставити · Esc — закрити</div>
          </div>
        )}
        {pending?.kind === 'question' && (
          <QuestionPanel
            questions={pending.questions}
            qIndex={qIndex}
            multiSel={multiSel}
            onToggleMulti={(label) =>
              setMultiSel((sel) =>
                sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]
              )
            }
            onPick={(label) => answerCurrent(label)}
            onSubmitMulti={() => answerCurrent(multiSel.join(', '))}
          />
        )}
        {pending?.kind === 'permission' && (
          <div className="chat-pending">
            <div className="chat-pending-title">
              Claude просить дозвіл: <b>{pending.toolName}</b>
            </div>
            {pending.summary && <code className="chat-pending-summary">{pending.summary}</code>}
            <div className="chat-options">
              <button className="opt-btn allow" onClick={() => answerPermission(true)}>
                ✓ Дозволити
              </button>
              <button className="opt-btn deny" onClick={() => answerPermission(false)}>
                ✗ Відхилити
              </button>
            </div>
          </div>
        )}
        <div className="chat-inputrow">
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value)
              // Manual editing turns the recalled entry into a new draft and
              // re-arms the dismissed slash menu.
              setHistIndex(null)
              setSlashDismissed(false)
            }}
            onKeyDown={onKeyDown}
          />
          {busy && (
            <button
              className="chat-stop"
              title="Перервати поточну відповідь"
              onClick={() => window.api.interruptChat(id)}
            >
              ■
            </button>
          )}
          {pending?.kind === 'permission' ? null : (
            <button
              className="chat-send"
              title={pending ? 'Надіслати свій варіант' : 'Надіслати'}
              disabled={!draft.trim()}
              onClick={() => (pending?.kind === 'question' ? answerCurrent(draft.trim()) : send())}
            >
              ➤
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function QuestionPanel({
  questions,
  qIndex,
  multiSel,
  onToggleMulti,
  onPick,
  onSubmitMulti
}: {
  questions: ChatQuestion[]
  qIndex: number
  multiSel: string[]
  onToggleMulti: (label: string) => void
  onPick: (label: string) => void
  onSubmitMulti: () => void
}): JSX.Element | null {
  const q = questions[qIndex]
  if (!q) return null
  return (
    <div className="chat-pending">
      <div className="chat-pending-title">
        {q.header && <span className="chat-q-header">{q.header}</span>}
        {q.question}
        {questions.length > 1 && (
          <span className="chat-q-counter">
            {qIndex + 1}/{questions.length}
          </span>
        )}
      </div>
      <div className="chat-options">
        {q.options.map((o) =>
          q.multiSelect ? (
            <button
              key={o.label}
              className={`opt-btn ${multiSel.includes(o.label) ? 'selected' : ''}`}
              title={o.description}
              onClick={() => onToggleMulti(o.label)}
            >
              {o.label}
            </button>
          ) : (
            <button
              key={o.label}
              className="opt-btn"
              title={o.description}
              onClick={() => onPick(o.label)}
            >
              {o.label}
            </button>
          )
        )}
        {q.multiSelect && (
          <button className="opt-btn confirm" disabled={!multiSel.length} onClick={onSubmitMulti}>
            ✓ Готово
          </button>
        )}
      </div>
    </div>
  )
}

function ChatItemView({ item }: { item: ChatItem }): JSX.Element {
  switch (item.role) {
    case 'user':
      return <div className="chat-msg user">{item.text}</div>
    case 'assistant':
      // Claude's replies are Markdown. react-markdown renders straight to React
      // elements (raw HTML in the text is dropped, never injected), so the
      // formatting is safe; user/info items stay literal pre-wrapped text.
      return (
        <div className="chat-msg assistant chat-md">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // _blank routes the click through setWindowOpenHandler in main,
              // which opens the system browser — a plain navigation would
              // replace our renderer page with the linked site.
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />
            }}
          >
            {item.text}
          </Markdown>
        </div>
      )
    case 'tool':
      return (
        <div className={`chat-tool ${item.done ? (item.isError ? 'err' : 'ok') : 'run'}`}>
          <span className="chat-tool-status">
            {item.done ? (item.isError ? '✗' : '✓') : <span className="chat-tool-spin" />}
          </span>
          <span className="chat-tool-name">{item.toolName}</span>
          {item.text && <code className="chat-tool-summary">{item.text}</code>}
        </div>
      )
    default:
      return <div className="chat-info">{item.text}</div>
  }
}
