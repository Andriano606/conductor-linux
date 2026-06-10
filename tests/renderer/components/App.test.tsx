// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import type { Workspace } from '../../../src/shared/types'

// xterm-backed terminal registry is replaced so no canvas/DOM terminal is built.
vi.mock('../../../src/renderer/src/termRegistry', () => ({
  disposeWorkspace: vi.fn(),
  writeData: vi.fn(),
  mount: vi.fn(),
  fitAndResize: vi.fn(),
  setMenuListener: vi.fn(),
  requestMenuScan: vi.fn()
}))

import { App } from '../../../src/renderer/src/App'
import { disposeWorkspace } from '../../../src/renderer/src/termRegistry'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkWs, settings, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  vi.mocked(disposeWorkspace).mockClear()
})

describe('App', () => {
  it('shows the placeholder when no workspace is active', async () => {
    api.getSettings.mockResolvedValue(settings)
    api.listWorkspaces.mockResolvedValue([])
    render(<App />)
    await waitFor(() => expect(screen.getByText(/Додай проект/)).toBeInTheDocument())
  })

  it('renders the toolbar and terminal host for the active workspace', async () => {
    api.getSettings.mockResolvedValue(settings)
    api.listWorkspaces.mockResolvedValue([mkWs({ id: 'a', name: 'alpha' })])
    const { container } = render(<App />)
    // The toolbar's Run button only renders once a workspace is active.
    await waitFor(() => expect(screen.getByText('▶ Run')).toBeInTheDocument())
    expect(container.querySelector('.term-host')).toBeInTheDocument()
  })

  it('disposes terminals and reassigns active when a workspace is archived', async () => {
    let changed: (ws: Workspace[]) => void = () => {}
    api.onWorkspacesChanged.mockImplementation((cb: (ws: Workspace[]) => void) => {
      changed = cb
      return () => {}
    })
    api.getSettings.mockResolvedValue(settings)
    api.listWorkspaces.mockResolvedValue([
      mkWs({ id: 'a', name: 'alpha' }),
      mkWs({ id: 'b', name: 'beta' })
    ])
    render(<App />)
    await waitFor(() => expect(useStore.getState().activeId).toBe('a'))

    act(() => {
      changed([mkWs({ id: 'b', name: 'beta' }), mkWs({ id: 'a', name: 'alpha', status: 'archived' })])
    })

    expect(disposeWorkspace).toHaveBeenCalledWith('a')
    expect(useStore.getState().activeId).toBe('b')
  })
})
