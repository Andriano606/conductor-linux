// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { PromptLibraryModal } from '../../../src/renderer/src/components/PromptLibraryModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

const contentArea = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/Текст промту/) as HTMLTextAreaElement

describe('PromptLibraryModal', () => {
  it('lists saved prompts and inserts the raw content (substitution happens upstream)', () => {
    useStore.setState({
      customPrompts: [
        { id: 'a', title: 'Deploy', content: 'deploy to $CONDUCTOR_HOST', createdAt: 0, updatedAt: 0 }
      ]
    })
    const onInsert = vi.fn()
    render(<PromptLibraryModal onInsert={onInsert} onClose={() => {}} />)
    expect(screen.getByText('Deploy')).toBeInTheDocument()
    fireEvent.click(screen.getByText('➤ Вставити'))
    expect(onInsert).toHaveBeenCalledWith('deploy to $CONDUCTOR_HOST')
  })

  it('creates a new prompt from the form', () => {
    render(<PromptLibraryModal onInsert={() => {}} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Назва'), { target: { value: 'My prompt' } })
    fireEvent.change(contentArea(), { target: { value: 'do the thing', selectionStart: 12 } })
    fireEvent.click(screen.getByText('Додати'))
    expect(api.createCustomPrompt).toHaveBeenCalledWith('My prompt', 'do the thing')
  })

  it('shows the variable hint', () => {
    render(<PromptLibraryModal onInsert={() => {}} onClose={() => {}} />)
    expect(screen.getByText(/\$CONDUCTOR_PORT/)).toBeInTheDocument()
    expect(screen.getByText(/Введи/)).toBeInTheDocument()
  })

  it('opens the $ autocomplete and inserts the chosen variable token', () => {
    render(<PromptLibraryModal onInsert={() => {}} onClose={() => {}} />)
    // Type a lone "$" with the caret right after it.
    fireEvent.change(contentArea(), { target: { value: '$', selectionStart: 1 } })
    const menu = document.querySelector('.prompt-var-menu') as HTMLElement
    expect(menu).toBeTruthy()
    // Pick the workspace-name variable.
    fireEvent.click(within(menu).getByText('$CONDUCTOR_WORKSPACE_NAME'))
    expect(contentArea().value).toBe('$CONDUCTOR_WORKSPACE_NAME')
  })

  it('filters the variable menu by the typed partial', () => {
    render(<PromptLibraryModal onInsert={() => {}} onClose={() => {}} />)
    fireEvent.change(contentArea(), { target: { value: '$port', selectionStart: 5 } })
    const menu = document.querySelector('.prompt-var-menu') as HTMLElement
    expect(within(menu).getByText('$CONDUCTOR_PORT')).toBeInTheDocument()
    expect(within(menu).queryByText('$CONDUCTOR_BRANCH')).not.toBeInTheDocument()
  })
})
