// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionTabs } from '../../../src/renderer/src/components/SessionTabs'
import { useStore } from '../../../src/renderer/src/store'
import { mkWs, setupRenderer, type Api } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

describe('SessionTabs', () => {
  it('renders one auto-numbered tab per session plus an add button', () => {
    const ws = mkWs({ id: 'w', sessions: [
      { id: 's1', createdAt: 0 },
      { id: 's2', createdAt: 0 }
    ] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    expect(screen.getByText('Сесія 1')).toBeInTheDocument()
    expect(screen.getByText('Сесія 2')).toBeInTheDocument()
    expect(screen.getByTitle('Нова сесія Claude')).toBeInTheDocument()
  })

  it('uses a custom title when set', () => {
    const ws = mkWs({ id: 'w', sessions: [{ id: 's1', createdAt: 0, title: 'refactor' }] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    expect(screen.getByText('refactor')).toBeInTheDocument()
  })

  it('hides the close button when only one session remains', () => {
    const ws = mkWs({ id: 'w', sessions: [{ id: 's1', createdAt: 0 }] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    expect(screen.queryByTitle('Закрити сесію')).not.toBeInTheDocument()
  })

  it('clicking a tab selects that session', () => {
    const ws = mkWs({ id: 'w', sessions: [
      { id: 's1', createdAt: 0 },
      { id: 's2', createdAt: 0 }
    ] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    fireEvent.click(screen.getByText('Сесія 2'))
    expect(useStore.getState().activeSessionByWorkspace['w']).toBe('s2')
  })

  it('the add button creates a session and selects it', async () => {
    api.createSession.mockResolvedValueOnce({ id: 'fresh', createdAt: 0 })
    const ws = mkWs({ id: 'w', sessions: [{ id: 's1', createdAt: 0 }] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    fireEvent.click(screen.getByTitle('Нова сесія Claude'))
    expect(api.createSession).toHaveBeenCalledWith('w')
    await waitFor(() => expect(useStore.getState().activeSessionByWorkspace['w']).toBe('fresh'))
  })

  it('closing the active session selects a sibling and calls closeSession', () => {
    const ws = mkWs({ id: 'w', sessions: [
      { id: 's1', createdAt: 0 },
      { id: 's2', createdAt: 0 }
    ] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    const closeButtons = screen.getAllByTitle('Закрити сесію')
    fireEvent.click(closeButtons[0]) // close s1 (active)
    expect(useStore.getState().activeSessionByWorkspace['w']).toBe('s2')
    expect(api.closeSession).toHaveBeenCalledWith('s1')
  })

  it('double-click opens a rename input that commits on Enter', () => {
    const ws = mkWs({ id: 'w', sessions: [{ id: 's1', createdAt: 0 }] })
    render(<SessionTabs ws={ws} activeSessionId="s1" />)
    fireEvent.doubleClick(screen.getByText('Сесія 1'))
    const input = screen.getByDisplayValue('') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bugfix' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.renameSession).toHaveBeenCalledWith('s1', 'bugfix')
  })

  it('shows a busy spinner on a working session', () => {
    useStore.setState({ claudeBusyById: { s2: true } })
    const ws = mkWs({ id: 'w', sessions: [
      { id: 's1', createdAt: 0 },
      { id: 's2', createdAt: 0 }
    ] })
    const { container } = render(<SessionTabs ws={ws} activeSessionId="s1" />)
    expect(container.querySelector('.session-tab-spin')).toBeInTheDocument()
  })
})
