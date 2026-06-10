// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SUBMIT_DELAY_MS,
  buildClaudePayload,
  sendRawKey,
  sendToClaude
} from '../../src/renderer/src/claudeSend'
import { Api, setupRenderer } from './helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('buildClaudePayload', () => {
  it('passes single-line text through unchanged', () => {
    expect(buildClaudePayload('hello')).toBe('hello')
  })

  it('wraps multiline text in a bracketed paste', () => {
    expect(buildClaudePayload('a\nb')).toBe('\x1b[200~a\nb\x1b[201~')
  })
})

describe('sendToClaude', () => {
  it('sends the text, then Enter after the submit delay', () => {
    sendToClaude('ws', 'hello')
    expect(api.sendInput).toHaveBeenCalledWith('ws', 'claude', 'hello')
    expect(api.sendInput).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SUBMIT_DELAY_MS)
    expect(api.sendInput).toHaveBeenCalledWith('ws', 'claude', '\r')
    expect(api.sendInput).toHaveBeenCalledTimes(2)
  })

  it('sends multiline text as one bracketed paste', () => {
    sendToClaude('ws', 'line 1\nline 2')
    expect(api.sendInput).toHaveBeenCalledWith('ws', 'claude', '\x1b[200~line 1\nline 2\x1b[201~')
  })

  it('does nothing for blank text', () => {
    sendToClaude('ws', '   \n  ')
    vi.advanceTimersByTime(SUBMIT_DELAY_MS)
    expect(api.sendInput).not.toHaveBeenCalled()
  })
})

describe('sendRawKey', () => {
  it('forwards the raw key sequence to the claude PTY', () => {
    sendRawKey('ws', '\x1b[A')
    expect(api.sendInput).toHaveBeenCalledWith('ws', 'claude', '\x1b[A')
  })
})
