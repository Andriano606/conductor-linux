// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatPending, ChatSnapshot } from '../../../src/shared/types'

import { ChatView } from '../../../src/renderer/src/components/ChatView'
import { setupRenderer, type Api } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

const snap = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  items: [],
  pending: null,
  busy: false,
  seq: 0,
  ...over
})

const questionPending: ChatPending = {
  kind: 'question',
  requestId: 'req-1',
  questions: [
    {
      question: 'Який підхід обрати?',
      header: 'Підхід',
      options: [
        { label: 'Швидкий', description: 'мінімальний фікс' },
        { label: 'Ґрунтовний', description: 'рефакторинг' }
      ],
      multiSelect: false
    }
  ]
}

describe('ChatView', () => {
  it('attaches on mount and renders the transcript', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        items: [
          { id: '1', role: 'user', text: 'зроби фічу', ts: 0 },
          { id: '2', role: 'assistant', text: 'Готово!', ts: 1 },
          { id: '3', role: 'tool', toolName: 'Bash', text: 'npm test', done: true, ts: 2 }
        ],
        seq: 3
      })
    )
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('Готово!')).toBeInTheDocument())
    expect(api.attachChat).toHaveBeenCalledWith('w1')
    expect(screen.getByText('зроби фічу')).toBeInTheDocument()
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('npm test')).toBeInTheDocument()
  })

  it('renders assistant replies as markdown (bold, code, lists)', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        items: [
          {
            id: '1',
            role: 'assistant',
            text: 'Зробив **дві зміни**:\n- виправив `parseUser()`\n\n```js\nconst x = 1\n```',
            ts: 0
          }
        ],
        seq: 1
      })
    )
    const { container } = render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('дві зміни')).toBeInTheDocument())
    expect(screen.getByText('дві зміни').tagName).toBe('STRONG')
    expect(screen.getByText('parseUser()').tagName).toBe('CODE')
    expect(container.querySelector('li')).toHaveTextContent('виправив')
    expect(container.querySelector('pre code')).toHaveTextContent('const x = 1')
    // The literal markdown markers are gone from the rendered text.
    expect(container.querySelector('.chat-md')).not.toHaveTextContent('**')
  })

  it('never injects raw HTML from an assistant reply into the DOM', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        items: [
          { id: '1', role: 'assistant', text: 'до <img src=x onerror="alert(1)"> після', ts: 0 }
        ],
        seq: 1
      })
    )
    const { container } = render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText(/до/)).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders markdown links with target=_blank so main opens the system browser', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        items: [{ id: '1', role: 'assistant', text: 'див. [доку](https://example.com)', ts: 0 }],
        seq: 1
      })
    )
    render(<ChatView id="w1" />)
    const link = await screen.findByRole('link', { name: 'доку' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('keeps user messages literal (no markdown interpretation)', async () => {
    api.attachChat.mockResolvedValue(
      snap({ items: [{ id: '1', role: 'user', text: 'зроби **без** зірочок', ts: 0 }], seq: 1 })
    )
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('зроби **без** зірочок')).toBeInTheDocument())
  })

  it('sends a typed message with Enter and clears the input', async () => {
    api.attachChat.mockResolvedValue(snap())
    render(<ChatView id="w1" />)
    const input = await screen.findByPlaceholderText(/Напиши Claude/)
    await userEvent.type(input, 'привіт{Enter}')
    expect(api.sendChat).toHaveBeenCalledWith('w1', 'привіт')
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('does not send a blank message', async () => {
    api.attachChat.mockResolvedValue(snap())
    render(<ChatView id="w1" />)
    const input = await screen.findByPlaceholderText(/Напиши Claude/)
    await userEvent.type(input, '{Enter}')
    expect(api.sendChat).not.toHaveBeenCalled()
  })

  it('shows question options as buttons and answers on click', async () => {
    api.attachChat.mockResolvedValue(snap({ pending: questionPending, seq: 1 }))
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('Який підхід обрати?')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Швидкий' }))
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'question',
      requestId: 'req-1',
      answers: { 'Який підхід обрати?': 'Швидкий' }
    })
  })

  it('lets the user type a custom answer instead of picking an option', async () => {
    api.attachChat.mockResolvedValue(snap({ pending: questionPending, seq: 1 }))
    render(<ChatView id="w1" />)
    const input = await screen.findByPlaceholderText(/Свій варіант/)
    await userEvent.type(input, 'свій власний підхід{Enter}')
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'question',
      requestId: 'req-1',
      answers: { 'Який підхід обрати?': 'свій власний підхід' }
    })
    expect(api.sendChat).not.toHaveBeenCalled()
  })

  it('collects multi-select answers and submits them joined', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        pending: {
          kind: 'question',
          requestId: 'req-2',
          questions: [
            {
              question: 'Які секції включити?',
              header: 'Секції',
              options: [
                { label: 'Вступ', description: '' },
                { label: 'Висновок', description: '' }
              ],
              multiSelect: true
            }
          ]
        },
        seq: 1
      })
    )
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('Які секції включити?')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Вступ' }))
    await userEvent.click(screen.getByRole('button', { name: 'Висновок' }))
    await userEvent.click(screen.getByRole('button', { name: /Готово/ }))
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'question',
      requestId: 'req-2',
      answers: { 'Які секції включити?': 'Вступ, Висновок' }
    })
  })

  it('walks through multiple questions before submitting all answers', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        pending: {
          kind: 'question',
          requestId: 'req-3',
          questions: [
            {
              question: 'Перше?',
              header: 'A',
              options: [{ label: 'Так', description: '' }, { label: 'Ні', description: '' }],
              multiSelect: false
            },
            {
              question: 'Друге?',
              header: 'B',
              options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }],
              multiSelect: false
            }
          ]
        },
        seq: 1
      })
    )
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('Перше?')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Так' }))
    // Nothing submitted yet — the second question is now shown.
    expect(api.answerChat).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Друге?')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Y' }))
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'question',
      requestId: 'req-3',
      answers: { 'Перше?': 'Так', 'Друге?': 'Y' }
    })
  })

  it('renders permission requests with allow/deny buttons', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        pending: {
          kind: 'permission',
          requestId: 'req-9',
          toolName: 'Bash',
          summary: 'rm -rf node_modules'
        },
        seq: 1
      })
    )
    render(<ChatView id="w1" />)
    await waitFor(() => expect(screen.getByText('rm -rf node_modules')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /Дозволити/ }))
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'permission',
      requestId: 'req-9',
      allow: true,
      message: undefined
    })
  })

  it('denies with the typed explanation', async () => {
    api.attachChat.mockResolvedValue(
      snap({
        pending: { kind: 'permission', requestId: 'req-9', toolName: 'Bash', summary: 'rm x' },
        seq: 1
      })
    )
    render(<ChatView id="w1" />)
    const input = await screen.findByPlaceholderText(/що зробити інакше/)
    await userEvent.type(input, 'не видаляй, заархівуй')
    await userEvent.click(screen.getByRole('button', { name: /Відхилити/ }))
    expect(api.answerChat).toHaveBeenCalledWith('w1', {
      kind: 'permission',
      requestId: 'req-9',
      allow: false,
      message: 'не видаляй, заархівуй'
    })
  })

  describe('input history (стрілки вгору/вниз)', () => {
    const histSnap = (): ChatSnapshot =>
      snap({
        items: [
          { id: '1', role: 'user', text: 'перша команда', ts: 0 },
          { id: '2', role: 'assistant', text: 'ok', ts: 1 },
          // An option-answer summary — must be skipped by history recall.
          { id: '3', role: 'user', text: 'Колір: Синій', answer: true, ts: 2 },
          { id: '4', role: 'user', text: 'друга команда', ts: 3 }
        ],
        seq: 4
      })

    it('recalls older sent messages with ArrowUp and newer with ArrowDown', async () => {
      api.attachChat.mockResolvedValue(histSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.click(input)
      await userEvent.keyboard('{ArrowUp}')
      expect(input.value).toBe('друга команда')
      await userEvent.keyboard('{ArrowUp}')
      // The answer-summary item is skipped — straight to the older message.
      expect(input.value).toBe('перша команда')
      await userEvent.keyboard('{ArrowUp}')
      // Already at the oldest entry — stays there.
      expect(input.value).toBe('перша команда')
      await userEvent.keyboard('{ArrowDown}')
      expect(input.value).toBe('друга команда')
      await userEvent.keyboard('{ArrowDown}')
      // Past the newest entry — back to the (empty) draft.
      expect(input.value).toBe('')
    })

    it('saves the typed draft and restores it after browsing', async () => {
      api.attachChat.mockResolvedValue(histSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.type(input, 'чернетка')
      await userEvent.keyboard('{ArrowUp}')
      expect(input.value).toBe('друга команда')
      await userEvent.keyboard('{ArrowDown}')
      expect(input.value).toBe('чернетка')
    })

    it('sends the recalled message with Enter', async () => {
      api.attachChat.mockResolvedValue(histSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.click(input)
      await userEvent.keyboard('{ArrowUp}{Enter}')
      expect(api.sendChat).toHaveBeenCalledWith('w1', 'друга команда')
      expect(input.value).toBe('')
    })

    it('editing a recalled entry exits history mode and keeps the edit', async () => {
      api.attachChat.mockResolvedValue(histSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.click(input)
      await userEvent.keyboard('{ArrowUp}')
      await userEvent.type(input, '!')
      expect(input.value).toBe('друга команда!')
      // Down does nothing now — we're no longer browsing, it's a fresh draft.
      await userEvent.keyboard('{ArrowDown}')
      expect(input.value).toBe('друга команда!')
    })
  })

  describe('slash commands', () => {
    const cmdSnap = (): ChatSnapshot =>
      snap({
        commands: [{ name: 'compact' }, { name: 'clear' }, { name: 'code-review' }],
        seq: 1
      })

    it('opens a filtered menu while typing a /command', async () => {
      api.attachChat.mockResolvedValue(cmdSnap())
      render(<ChatView id="w1" />)
      const input = await screen.findByPlaceholderText(/Напиши Claude/)
      await userEvent.type(input, '/c')
      expect(screen.getByRole('option', { name: '/compact' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: '/clear' })).toBeInTheDocument()
      await userEvent.type(input, 'o') // → "/co"
      expect(screen.queryByRole('option', { name: '/clear' })).not.toBeInTheDocument()
      expect(screen.getByRole('option', { name: '/code-review' })).toBeInTheDocument()
    })

    it('completes the selected command with Tab without sending', async () => {
      api.attachChat.mockResolvedValue(cmdSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.type(input, '/cl')
      await userEvent.keyboard('{Tab}')
      expect(input.value).toBe('/clear ')
      expect(api.sendChat).not.toHaveBeenCalled()
    })

    it('Enter completes the command, the next Enter sends it', async () => {
      api.attachChat.mockResolvedValue(cmdSnap())
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.type(input, '/comp{Enter}')
      expect(input.value).toBe('/compact ')
      expect(api.sendChat).not.toHaveBeenCalled()
      await userEvent.keyboard('{Enter}')
      expect(api.sendChat).toHaveBeenCalledWith('w1', '/compact')
    })

    it('arrows navigate the menu instead of recalling history', async () => {
      api.attachChat.mockResolvedValue(
        snap({
          items: [{ id: '1', role: 'user', text: 'попереднє повідомлення', ts: 0 }],
          commands: [{ name: 'compact' }, { name: 'clear' }],
          seq: 2
        })
      )
      render(<ChatView id="w1" />)
      const input = (await screen.findByPlaceholderText(
        /Напиши Claude/
      )) as HTMLTextAreaElement
      await userEvent.type(input, '/c')
      await userEvent.keyboard('{ArrowDown}')
      // Draft untouched — the arrow moved the menu selection, not history.
      expect(input.value).toBe('/c')
      // Menu is sorted alphabetically: [clear, compact]; ArrowDown → compact.
      await userEvent.keyboard('{Tab}')
      expect(input.value).toBe('/compact ')
    })

    it('Escape dismisses the menu until the draft changes', async () => {
      api.attachChat.mockResolvedValue(cmdSnap())
      render(<ChatView id="w1" />)
      const input = await screen.findByPlaceholderText(/Напиши Claude/)
      await userEvent.type(input, '/c')
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      await userEvent.type(input, 'o')
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  it('shows the stop button while Claude works and interrupts on click', async () => {
    api.attachChat.mockResolvedValue(snap({ busy: true, seq: 1 }))
    render(<ChatView id="w1" />)
    const stop = await screen.findByTitle(/Перервати/)
    await userEvent.click(stop)
    expect(api.interruptChat).toHaveBeenCalledWith('w1')
  })
})
