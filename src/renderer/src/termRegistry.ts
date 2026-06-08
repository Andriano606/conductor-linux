import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyKind } from '@shared/types'

interface TermEntry {
  wrapper: HTMLDivElement
  term: Terminal
  fit: FitAddon
  // Live streaming is held back until the initial buffer snapshot has been
  // written, so the snapshot can never land after the data that follows it.
  attached: boolean
}

/**
 * Keeps one long-lived xterm instance per (workspace, kind) so scrollback
 * survives switching workspaces/tabs. Terminals are created lazily and their
 * wrapper element is moved into the visible host on activation.
 */
const terms = new Map<string, TermEntry>()

function key(id: string, kind: PtyKind): string {
  return `${id}:${kind}`
}

function ensure(id: string, kind: PtyKind): TermEntry {
  const k = key(id, kind)
  let e = terms.get(k)
  if (e) return e

  const wrapper = document.createElement('div')
  wrapper.className = 'term-mount'

  // The "task" terminal (setup/run/archive output) is read-only so the user
  // can't accidentally kill the running app with Ctrl+C or stray keystrokes.
  const readOnly = kind === 'task'
  const term = new Terminal({
    fontFamily: 'JetBrains Mono, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: !readOnly,
    disableStdin: readOnly,
    scrollback: 10000,
    theme: { background: '#1e1e1e', foreground: '#d7dae0' }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(wrapper)

  // The viewport is lifted above the rendered rows so its scrollbar is grabbable
  // (see styles.css). As a result the viewport's cursor wins over the whole
  // area, and Chromium ignores `cursor` on ::-webkit-scrollbar, so swap it here:
  // a text caret over the rows, the default arrow over the scrollbar strip.
  const viewport = wrapper.querySelector('.xterm-viewport') as HTMLElement | null
  if (viewport) {
    viewport.addEventListener('mousemove', (ev) => {
      const x = ev.clientX - viewport.getBoundingClientRect().left
      const next = x >= viewport.clientWidth ? 'default' : 'text'
      if (viewport.style.cursor !== next) viewport.style.cursor = next
    })
  }

  // Right-click anywhere in the terminal opens a native Copy/Paste menu. The
  // current selection is captured now and sent to main so Copy works on the
  // canvas-rendered selection (which isn't a normal DOM selection).
  wrapper.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    window.api.showTermMenu(id, kind, term.getSelection())
  })

  if (!readOnly) {
    term.onData((d) => window.api.sendInput(id, kind, d))

    // Ctrl+C handling for the interactive terminals (claude + shell):
    //  - If text is selected, Ctrl+C copies it (a real terminal convention) —
    //    this works in every tab, not just Claude.
    //  - Otherwise it interrupts. In the shell that's the normal \x03. In the
    //    Claude terminal a single press interrupts the current generation, but a
    //    quick *double* press is how the `claude` CLI exits — closing the
    //    console out from under the user. We never want Ctrl+C to close Claude,
    //    so we forward a single throttled \x03 that can't reach Claude's
    //    double-tap exit window.
    let lastSigint = 0
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || !ev.ctrlKey || (ev.key !== 'c' && ev.key !== 'C')) {
        return true
      }
      const sel = term.getSelection()
      if (sel) {
        window.api.copyText(sel)
        return false
      }
      if (kind !== 'claude') return true // shell: let xterm emit \x03 normally
      const now = performance.now()
      if (now - lastSigint >= 1000) {
        lastSigint = now
        window.api.sendInput(id, kind, '\x03')
      }
      // Always swallow for Claude: returning true would let xterm emit its own
      // \x03 and bypass the throttle, re-enabling the double-tap exit.
      return false
    })
  } else {
    // View-only terminal (task output): let the user select & copy text, but
    // never send keystrokes to the PTY so the running process is untouched.
    // Selecting with the mouse copies automatically; Ctrl/Cmd+C also copies.
    const copySelection = (): void => {
      const sel = term.getSelection()
      if (sel) window.api.copyText(sel)
    }
    term.onSelectionChange(copySelection)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        copySelection()
      }
      // Swallow every key: nothing reaches stdin, so the process is unaffected.
      return false
    })
  }

  e = { wrapper, term, fit, attached: false }
  terms.set(k, e)

  // Attach atomically in main: returns the buffer snapshot, then live streaming begins.
  window.api.attachPty(id, kind).then((buf) => {
    if (buf) term.write(buf)
    e!.attached = true
    // Flush any live chunks that arrived (and were queued) before the snapshot.
    scheduleFlush()
  })
  return e
}

// Incoming pty chunks are coalesced per terminal and flushed in a single
// term.write() per animation frame. Hundreds of tiny synchronous writes during
// a log burst otherwise thrash the renderer and make the console stutter.
const pending = new Map<string, string>()
let flushScheduled = false

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  requestAnimationFrame(flush)
}

function flush(): void {
  flushScheduled = false
  let requeued = false
  for (const [k, data] of pending) {
    const e = terms.get(k)
    if (!e) {
      pending.delete(k)
      continue
    }
    // Hold the terminal's data until its snapshot has been written (ordering).
    if (!e.attached) {
      requeued = true
      continue
    }
    e.term.write(data)
    pending.delete(k)
  }
  // Some entries still await their snapshot; try again next frame.
  if (requeued) scheduleFlush()
}

/** Route incoming pty data to the matching terminal (creating it if needed). */
export function writeData(id: string, kind: PtyKind, data: string): void {
  ensure(id, kind)
  const k = key(id, kind)
  pending.set(k, (pending.get(k) ?? '') + data)
  scheduleFlush()
}

/** Mount the given terminal into the host element and size it to fit. */
export function mount(host: HTMLElement, id: string, kind: PtyKind): void {
  const e = ensure(id, kind)
  if (e.wrapper.parentElement !== host) {
    host.replaceChildren(e.wrapper)
  }
  // Focus only on activation — fitAndResize must not steal focus on every resize.
  requestAnimationFrame(() => {
    fitAndResize(id, kind)
    // Snap to the latest output whenever a tab/workspace is activated, so the
    // user always lands at the bottom rather than wherever they last scrolled.
    e.term.scrollToBottom()
    e.term.focus()
  })
}

export function fitAndResize(id: string, kind: PtyKind): void {
  const e = terms.get(key(id, kind))
  if (!e || !e.wrapper.isConnected) return
  try {
    // Keep the view pinned to the bottom across a reflow: an xterm resize can
    // otherwise strand the viewport at the top mid-stream ("teleport").
    const b = e.term.buffer.active
    const wasAtBottom = b.viewportY >= b.baseY
    const prevCols = e.term.cols
    const prevRows = e.term.rows
    e.fit.fit()
    if (e.term.cols !== prevCols || e.term.rows !== prevRows) {
      window.api.resizePty(id, kind, e.term.cols, e.term.rows)
    }
    if (wasAtBottom) e.term.scrollToBottom()
  } catch {
    /* element not measurable yet */
  }
}

export function disposeWorkspace(id: string): void {
  for (const kind of ['claude', 'task', 'shell'] as PtyKind[]) {
    const k = key(id, kind)
    const e = terms.get(k)
    if (e) {
      e.term.dispose()
      e.wrapper.remove()
      terms.delete(k)
      pending.delete(k)
    }
  }
}
