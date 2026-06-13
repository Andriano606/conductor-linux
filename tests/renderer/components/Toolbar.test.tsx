// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Toolbar } from '../../../src/renderer/src/components/Toolbar'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkProject, mkWs, settings, setupRenderer } from '../helpers'

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

  it('truncates a long branch name to 15 chars and hides the full name until hover', async () => {
    api.currentBranch.mockResolvedValue('feature/super-long-branch')
    render(<Toolbar ws={ws} />)
    await waitFor(() => expect(screen.getByText('feature/super-…')).toBeInTheDocument())
    expect(screen.queryByText('feature/super-long-branch')).not.toBeInTheDocument()
  })

  it('reveals the full branch name in a popup on hover', async () => {
    api.currentBranch.mockResolvedValue('feature/super-long-branch')
    render(<Toolbar ws={ws} />)
    const badge = await screen.findByText('feature/super-…')
    fireEvent.mouseEnter(badge.closest('button')!)
    expect(screen.getByText('feature/super-long-branch')).toBeInTheDocument()
    fireEvent.mouseLeave(badge.closest('button')!)
    expect(screen.queryByText('feature/super-long-branch')).not.toBeInTheDocument()
  })

  it('copies the full branch name and flashes a confirmation on click', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    api.currentBranch.mockResolvedValue('feature/super-long-branch')
    render(<Toolbar ws={ws} />)
    const badge = await screen.findByText('feature/super-…')
    fireEvent.click(badge.closest('button')!)
    expect(writeText).toHaveBeenCalledWith('feature/super-long-branch')
    expect(screen.getByText(/Скопійовано/)).toBeInTheDocument()
  })

  it('shows and copies the base branch without its origin/ prefix', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Toolbar ws={mkWs({ id: 'a', baseBranch: 'origin/feature/x' })} />)
    const baseBadge = await screen.findByText('feature/x')
    expect(screen.queryByText('origin/feature/x')).not.toBeInTheDocument()
    fireEvent.click(baseBadge.closest('button')!)
    expect(writeText).toHaveBeenCalledWith('feature/x')
  })

  it('leaves a local base branch (no remote prefix) unchanged', async () => {
    render(<Toolbar ws={mkWs({ id: 'a', baseBranch: 'develop' })} />)
    expect(await screen.findByText('develop')).toBeInTheDocument()
  })

  it('switches tabs via setKind', () => {
    render(<Toolbar ws={ws} />)
    fireEvent.click(screen.getByText('Скрипти'))
    expect(useStore.getState().activeKind).toBe('task')
  })

  it('shows the retry-setup button only on a failed setup with a setup script', () => {
    useStore.setState({ projects: [mkProject({ id: 'p1', setupScript: '/setup.sh' })] })
    const { rerender } = render(<Toolbar ws={ws} />)
    // No setup error → no button.
    expect(screen.queryByText('↻ Setup')).not.toBeInTheDocument()
    rerender(<Toolbar ws={mkWs({ id: 'a', status: 'active', setupStatus: 'error' })} />)
    expect(screen.getByText('↻ Setup')).toBeInTheDocument()
  })

  it('hides the retry-setup button when the project has no setup script', () => {
    useStore.setState({ projects: [mkProject({ id: 'p1', setupScript: '' })] })
    render(<Toolbar ws={mkWs({ id: 'a', status: 'active', setupStatus: 'error' })} />)
    expect(screen.queryByText('↻ Setup')).not.toBeInTheDocument()
  })

  it('re-runs setup and switches to the Scripts tab on click', () => {
    useStore.setState({
      activeId: 'a',
      projects: [mkProject({ id: 'p1', setupScript: '/setup.sh' })]
    })
    render(<Toolbar ws={mkWs({ id: 'a', status: 'active', setupStatus: 'error' })} />)
    fireEvent.click(screen.getByText('↻ Setup'))
    expect(api.rerunSetup).toHaveBeenCalledWith('a')
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
