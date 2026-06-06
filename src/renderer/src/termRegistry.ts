import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyKind } from '@shared/types'

interface TermEntry {
  wrapper: HTMLDivElement
  term: Terminal
  fit: FitAddon
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

  if (!readOnly) term.onData((d) => window.api.sendInput(id, kind, d))

  e = { wrapper, term, fit }
  terms.set(k, e)

  // Attach atomically in main: returns the buffer snapshot, then live streaming begins.
  window.api.attachPty(id, kind).then((buf) => {
    if (buf) term.write(buf)
  })
  return e
}

/** Route incoming pty data to the matching terminal (creating it if needed). */
export function writeData(id: string, kind: PtyKind, data: string): void {
  ensure(id, kind).term.write(data)
}

/** Mount the given terminal into the host element and size it to fit. */
export function mount(host: HTMLElement, id: string, kind: PtyKind): void {
  const e = ensure(id, kind)
  if (e.wrapper.parentElement !== host) {
    host.replaceChildren(e.wrapper)
  }
  requestAnimationFrame(() => fitAndResize(id, kind))
}

export function fitAndResize(id: string, kind: PtyKind): void {
  const e = terms.get(key(id, kind))
  if (!e || !e.wrapper.isConnected) return
  try {
    e.fit.fit()
    window.api.resizePty(id, kind, e.term.cols, e.term.rows)
    e.term.focus()
  } catch {
    /* element not measurable yet */
  }
}

export function disposeWorkspace(id: string): void {
  for (const kind of ['claude', 'task'] as PtyKind[]) {
    const k = key(id, kind)
    const e = terms.get(k)
    if (e) {
      e.term.dispose()
      e.wrapper.remove()
      terms.delete(k)
    }
  }
}
