// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Toolbar } from '../../../src/renderer/src/components/Toolbar'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkWs, settings, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  useStore.setState({ settings: { ...settings, ideCommand: 'code' } })
})

const ws = mkWs({ id: 'a', name: 'feat', status: 'active' })

describe('Toolbar', () => {
  it('shows Run when not running and Stop when running', () => {
    const { rerender } = render(<Toolbar ws={ws} />)
    expect(screen.getByText('▶ Run')).toBeInTheDocument()
    act(() => useStore.getState().setRunning('a', true))
    rerender(<Toolbar ws={ws} />)
    expect(screen.getByText('■ Stop')).toBeInTheDocument()
  })

  it('disables Run while setting up', () => {
    render(<Toolbar ws={mkWs({ id: 'a', status: 'setting_up' })} />)
    expect(screen.getByText('▶ Run')).toBeDisabled()
  })

  it('enables the browser button only while running', () => {
    const { rerender } = render(<Toolbar ws={ws} />)
    expect(screen.getByText(/У браузері/)).toBeDisabled()
    act(() => useStore.getState().setRunning('a', true))
    rerender(<Toolbar ws={ws} />)
    expect(screen.getByText(/У браузері/)).not.toBeDisabled()
  })

  it('disables the IDE button when no IDE command is configured', () => {
    useStore.setState({ settings: { ...settings, ideCommand: '' } })
    render(<Toolbar ws={ws} />)
    expect(screen.getByText(/Відкрити в IDE/)).toBeDisabled()
  })

  it('reads the current branch from the api', async () => {
    api.currentBranch.mockResolvedValue('feature/login')
    render(<Toolbar ws={ws} />)
    await waitFor(() => expect(screen.getByText(/feature\/login/)).toBeInTheDocument())
  })

  it('switches tabs via setKind', () => {
    render(<Toolbar ws={ws} />)
    fireEvent.click(screen.getByText('Скрипти'))
    expect(useStore.getState().activeKind).toBe('task')
  })

  it('archives only after confirmation', async () => {
    useStore.setState({ activeId: 'a' })
    render(<Toolbar ws={ws} />)
    fireEvent.click(screen.getByText('Архівувати'))
    expect(api.archiveWorkspace).not.toHaveBeenCalled()
    await act(async () => {
      useStore.getState().resolveConfirm(true)
    })
    expect(api.archiveWorkspace).toHaveBeenCalledWith('a')
  })
})
