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
    fireEvent.click(screen.getByText('🗑 Видалити'))
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
    fireEvent.click(screen.getByText('🗑 Видалити'))
    await act(async () => {
      useStore.getState().resolveConfirm(false)
    })
    expect(api.deleteWorkspace).not.toHaveBeenCalled()
  })

  it('has no "delete all" button when the archive is empty', () => {
    render(<ArchivedModal />)
    expect(screen.queryByText('🗑 Видалити всі')).not.toBeInTheDocument()
  })

  it('deletes every archived workspace after confirming "delete all"', async () => {
    useStore.setState({
      workspaces: [
        mkWs({ id: 'a', name: 'old-a', status: 'archived' }),
        mkWs({ id: 'b', name: 'old-b', status: 'archived' }),
        mkWs({ id: 'c', name: 'live', status: 'active' })
      ]
    })
    render(<ArchivedModal />)
    fireEvent.click(screen.getByText('🗑 Видалити всі'))
    expect(api.deleteWorkspace).not.toHaveBeenCalled()
    await act(async () => {
      useStore.getState().resolveConfirm(true)
    })
    expect(api.deleteWorkspace).toHaveBeenCalledWith('a')
    expect(api.deleteWorkspace).toHaveBeenCalledWith('b')
    // The active workspace is untouched.
    expect(api.deleteWorkspace).not.toHaveBeenCalledWith('c')
    expect(api.deleteWorkspace).toHaveBeenCalledTimes(2)
  })

  it('does not delete all when confirmation is cancelled', async () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'old', status: 'archived' })] })
    render(<ArchivedModal />)
    fireEvent.click(screen.getByText('🗑 Видалити всі'))
    await act(async () => {
      useStore.getState().resolveConfirm(false)
    })
    expect(api.deleteWorkspace).not.toHaveBeenCalled()
  })
})
