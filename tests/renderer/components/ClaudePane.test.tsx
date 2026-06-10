// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

// xterm-backed terminal registry is replaced so no canvas/DOM terminal is built.
vi.mock('../../../src/renderer/src/termRegistry', () => ({
  mount: vi.fn(),
  fitAndResize: vi.fn()
}))

import { ClaudePane } from '../../../src/renderer/src/components/ClaudePane'
import { SUBMIT_DELAY_MS } from '../../../src/renderer/src/claudeSend'
import { useStore } from '../../../src/renderer/src/store'
import type { ClaudeMenu } from '../../../src/renderer/src/menuDetect'
import { Api, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})
afterEach(() => vi.useRealTimers())

const ID = 'ws-1'
const textarea = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/Напиши повідомлення/) as HTMLTextAreaElement

const menu = (over: Partial<ClaudeMenu> = {}): ClaudeMenu => ({
  options: [
    { index: 0, label: 'Yes' },
    { index: 1, label: 'No' }
  ],
  selectedIndex: 0,
  multiSelect: false,
  ...over
})

describe('ClaudePane composer', () => {
  it('sends the draft on Enter and clears it', () => {
    vi.useFakeTimers()
    render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'hello claude' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', 'hello claude')
    act(() => vi.advanceTimersByTime(SUBMIT_DELAY_MS))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', '\r')
    expect(textarea().value).toBe('')
    expect(useStore.getState().historyById[ID]).toEqual(['hello claude'])
  })

  it('does not send on Shift+Enter (newline instead)', () => {
    render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'line' } })
    fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })
    expect(api.sendInput).not.toHaveBeenCalled()
    expect(useStore.getState().draftById[ID]).toBe('line')
  })

  it('sends via the ➤ button', () => {
    render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'msg' } })
    fireEvent.click(screen.getByTitle('Надіслати'))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', 'msg')
  })

  it('clears the detected menu when a message is sent', () => {
    useStore.getState().setMenu(ID, menu())
    render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'my own answer' } })
    fireEvent.keyDown(textarea(), { key: 'Enter' })
    expect(useStore.getState().menuById[ID]).toBeNull()
  })

  it('recalls sent messages with ArrowUp/ArrowDown on an empty draft', () => {
    const { pushHistory } = useStore.getState()
    pushHistory(ID, 'first')
    pushHistory(ID, 'second')
    render(<ClaudePane id={ID} />)
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(textarea().value).toBe('second')
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(textarea().value).toBe('first')
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    expect(textarea().value).toBe('second')
    fireEvent.keyDown(textarea(), { key: 'ArrowDown' })
    expect(textarea().value).toBe('')
  })

  it('does not recall history while a draft is being typed', () => {
    useStore.getState().pushHistory(ID, 'old message')
    render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'typing' } })
    fireEvent.keyDown(textarea(), { key: 'ArrowUp' })
    expect(textarea().value).toBe('typing')
  })

  it('keeps the draft per workspace', () => {
    const { rerender } = render(<ClaudePane id={ID} />)
    fireEvent.change(textarea(), { target: { value: 'draft for ws-1' } })
    rerender(<ClaudePane id="ws-2" />)
    expect(textarea().value).toBe('')
    rerender(<ClaudePane id={ID} />)
    expect(textarea().value).toBe('draft for ws-1')
  })
})

describe('ClaudePane menu chips', () => {
  it('renders a chip per option and sends the digit on click', () => {
    useStore.getState().setMenu(ID, menu())
    render(<ClaudePane id={ID} />)
    expect(screen.getByText('Yes')).toBeInTheDocument()
    fireEvent.click(screen.getByText('No'))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', '2')
    // Optimistically cleared; the next screen scan re-adds it if still shown.
    expect(useStore.getState().menuById[ID]).toBeNull()
  })

  it('marks the option under the TUI pointer', () => {
    useStore.getState().setMenu(ID, menu({ selectedIndex: 1 }))
    render(<ClaudePane id={ID} />)
    expect(screen.getByText('No').className).toContain('selected')
    expect(screen.getByText('Yes').className).not.toContain('selected')
  })

  it('hides the chips while Claude is busy', () => {
    useStore.getState().setMenu(ID, menu())
    useStore.getState().setClaudeBusy(ID, true)
    render(<ClaudePane id={ID} />)
    expect(screen.queryByText('Yes')).not.toBeInTheDocument()
  })

  it('walks the pointer with arrows for options past the ninth', () => {
    vi.useFakeTimers()
    const options = Array.from({ length: 11 }, (_, index) => ({ index, label: `Opt ${index + 1}` }))
    useStore.getState().setMenu(ID, menu({ options }))
    render(<ClaudePane id={ID} />)
    fireEvent.click(screen.getByText('Opt 11'))
    // Pointer starts at 0 → ten ↓ presses, then Enter.
    const downs = api.sendInput.mock.calls.filter((c) => c[2] === '\x1b[B')
    expect(downs).toHaveLength(10)
    act(() => vi.advanceTimersByTime(SUBMIT_DELAY_MS))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', '\r')
  })

  it('multi-select: digit toggles without clearing, confirm chip sends Enter', () => {
    useStore.getState().setMenu(ID, menu({ multiSelect: true }))
    render(<ClaudePane id={ID} />)
    fireEvent.click(screen.getByText('Yes'))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', '1')
    expect(useStore.getState().menuById[ID]).not.toBeNull()
    fireEvent.click(screen.getByText(/Підтвердити/))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', '\r')
    expect(useStore.getState().menuById[ID]).toBeNull()
  })
})

describe('ClaudePane key strip', () => {
  it.each([
    ['↑', '\x1b[A'],
    ['↓', '\x1b[B'],
    ['⏎', '\r'],
    ['Esc', '\x1b'],
    ['⇧Tab', '\x1b[Z']
  ])('the %s button sends its key code', (label, code) => {
    render(<ClaudePane id={ID} />)
    fireEvent.click(screen.getByText(label))
    expect(api.sendInput).toHaveBeenCalledWith(ID, 'claude', code)
  })
})
