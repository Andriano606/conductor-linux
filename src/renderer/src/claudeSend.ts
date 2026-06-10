/**
 * Writes composer input into the Claude PTY. The TUI stays the source of
 * truth — we only emulate what a user would type.
 */

/**
 * Delay between the text and the submitting \r, so the TUI's input loop gets a
 * tick to process the text (slash-command prefixes included) before Enter.
 */
export const SUBMIT_DELAY_MS = 50

/**
 * Multiline text is wrapped in a bracketed paste (the claude TUI keeps DEC 2004
 * paste mode on), so embedded newlines don't submit each line separately.
 */
export function buildClaudePayload(text: string): string {
  return text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text
}

/** Send a composer message: the text, then Enter shortly after. */
export function sendToClaude(id: string, text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  window.api.sendInput(id, 'claude', buildClaudePayload(trimmed))
  setTimeout(() => window.api.sendInput(id, 'claude', '\r'), SUBMIT_DELAY_MS)
}

/** Send a raw key sequence (menu digits, arrows, Esc…) to the Claude PTY. */
export function sendRawKey(id: string, code: string): void {
  window.api.sendInput(id, 'claude', code)
}
