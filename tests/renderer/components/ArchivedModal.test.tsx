// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ArchivedModal } from '../../../src/renderer/src/components/ArchivedModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkWs, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

describe('ArchivedModal', () => {
  it('shows the empty hint when nothing is archived', () => {
    render(<ArchivedModal />)
    expect(screen.getByText('Архів порожній.')).toBeInTheDocument()
  })

  it('lists archived workspaces and restores one', () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'old', status: 'archived' })] })
    render(<ArchivedModal />)
    expect(screen.getByText('old')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Повернути/))
    expect(api.restoreWorkspace).toHaveBeenCalledWith('a')
  })

  it('deletes only after confirmation', async () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'old', status: 'archived' })] })
    render(<ArchivedModal />)
    fireEvent.click(screen.getByText(/Видалити/))
    // A confirmation is pending; nothing deleted yet.
    expect(api.deleteWorkspace).not.toHaveBeenCalled()
    expect(useStore.getState().confirmRequest).not.toBeNull()
    await act(async () => {
      useStore.getState().resolveConfirm(true)
    })
    expect(api.deleteWorkspace).toHaveBeenCalledWith('a')
  })

  it('does not delete when confirmation is cancelled', async () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'old', status: 'archived' })] })
    render(<ArchivedModal />)
    fireEvent.click(screen.getByText(/Видалити/))
    await act(async () => {
      useStore.getState().resolveConfirm(false)
    })
    expect(api.deleteWorkspace).not.toHaveBeenCalled()
  })
})
