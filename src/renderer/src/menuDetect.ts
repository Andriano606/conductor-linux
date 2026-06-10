/**
 * Detects Claude CLI select menus (permission prompts, AskUserQuestion, plan
 * approval…) on the rendered terminal screen, so the UI can offer the options
 * as clickable buttons. Works on the text xterm has already parsed into its
 * buffer — no ANSI stripping needed. Pure module: no React, no xterm imports;
 * the buffer is typed structurally so tests can feed plain objects.
 */

/** One option of a detected menu; the TUI digit for it is String(index + 1). */
export interface MenuOption {
  index: number
  label: string
}

export interface ClaudeMenu {
  options: MenuOption[]
  /** Option the TUI pointer (❯) is currently on. */
  selectedIndex: number
  /** Checkbox menu: digits toggle options and Enter confirms the set. */
  multiSelect: boolean
}

/** Structural subset of xterm's IBufferLine. */
export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** Structural subset of xterm's IBuffer. */
export interface BufferLike {
  baseY: number
  getLine(y: number): BufferLineLike | undefined
}

/**
 * Read the live screen (the last `rows` rows) as logical lines: a row marked
 * isWrapped is the continuation of a long line, so it is glued back onto the
 * previous one — this is how long menu options that wrap stay one option.
 * Trailing blank lines are dropped; at most the last `maxScan` lines returned.
 */
export function collectLogicalLines(buf: BufferLike, rows: number, maxScan = 30): string[] {
  const lines: string[] = []
  for (let y = buf.baseY; y < buf.baseY + rows; y++) {
    const line = buf.getLine(y)
    if (!line) break
    const text = line.translateToString(true)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.slice(-maxScan)
}

// A menu option row: optional ❯ pointer, a 1-2 digit number, a dot, the label.
const OPTION = /^(❯\s*)?(\d{1,2})\.\s+(.+)$/
// Rows that are only box-drawing frame (after edge trim) carry no content.
const FRAME_ONLY = /^[\s│┃╭╮╰╯─━]*$/
// Key hints the TUI prints under a menu ("↑/↓ to select · enter to confirm…").
const HINT = /esc|enter|tab|↑|↓|·/i
// Dimmed hint suffix on an option label, e.g. "No, and tell Claude… (esc)".
const DIM_HINT = /\s*\((esc|tab)\)\s*$/i
// Checkbox prefix of multi-select options: [ ] / [x] / [✔].
const CHECKBOX = /^\[[ x✔✓]\]\s*/

/** Strip box borders the TUI draws around its dialogs. */
function clean(line: string): string {
  const c = line.replace(/^[\s│┃]+/, '').replace(/[\s│┃]+$/, '')
  return FRAME_ONLY.test(c) ? '' : c
}

/**
 * Find a select menu in the screen lines, or null. Deliberately strict to keep
 * false positives (numbered lists in Claude's prose) out: the block must sit at
 * the bottom of the screen, number sequentially from 1, and carry exactly one
 * ❯ pointer on an option row — prose lists never have the pointer.
 */
export function detectMenu(lines: string[]): ClaudeMenu | null {
  const cleaned = lines.map(clean)

  // The bottom-most option row…
  let end = -1
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (OPTION.test(cleaned[i])) {
      end = i
      break
    }
  }
  if (end < 0) return null

  // …must only have blanks/key-hints below it (the menu is the active prompt,
  // not something that already scrolled up behind new output).
  const tail = cleaned.slice(end + 1)
  if (tail.length > 6 || !tail.every((l) => !l || HINT.test(l))) return null

  // Expand the contiguous block of option rows upward.
  let start = end
  while (start > 0 && OPTION.test(cleaned[start - 1])) start--

  const rows = cleaned.slice(start, end + 1).map((l) => {
    const m = l.match(OPTION) as RegExpMatchArray
    return { pointer: !!m[1], num: Number(m[2]), label: m[3].trim() }
  })

  if (rows.length < 2) return null
  if (rows.some((r, i) => r.num !== i + 1)) return null
  if (rows.filter((r) => r.pointer).length !== 1) return null

  let labels = rows.map((r) =>
    r.label.replace(DIM_HINT, '').replace(/\s{2,}/g, ' ').trim()
  )
  const multiSelect = labels.every((l) => CHECKBOX.test(l))
  if (multiSelect) labels = labels.map((l) => l.replace(CHECKBOX, ''))

  return {
    options: labels.map((label, index) => ({ index, label })),
    selectedIndex: rows.findIndex((r) => r.pointer),
    multiSelect
  }
}
