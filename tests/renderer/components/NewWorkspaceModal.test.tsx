// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NewWorkspaceModal } from '../../../src/renderer/src/components/NewWorkspaceModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkWs, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  api.listBranches.mockResolvedValue({ branches: ['main', 'dev'], defaultBranch: 'main' })
})

const nameInput = (): HTMLElement => screen.getByPlaceholderText('напр. feature/login')
const searchInput = (): HTMLElement => screen.getByPlaceholderText('Пошук гілки…')

describe('NewWorkspaceModal', () => {
  it('loads branches on mount and preselects the default', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('flags a duplicate name and disables submit', async () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'dup', branch: 'dup' })] })
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(nameInput(), { target: { value: 'dup' } })
    expect(screen.getByText(/вже існує/)).toBeInTheDocument()
    expect(screen.getByText('Створити')).toBeDisabled()
  })

  it('filters the branch list case-insensitively', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(searchInput(), { target: { value: 'DE' } })
    const list = document.querySelector('.branch-list') as HTMLElement
    expect(within(list).getByText('dev')).toBeInTheDocument()
    expect(within(list).queryByText('main')).not.toBeInTheDocument()
  })

  it('Enter in search selects the first filtered branch', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(searchInput(), { target: { value: 'de' } })
    fireEvent.keyDown(searchInput(), { key: 'Enter' })
    // The base label reflects the chosen branch.
    expect(screen.getByText(/Базова гілка/).textContent).toContain('dev')
  })

  it('submits the trimmed name and selected base', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(nameInput(), { target: { value: '  newone  ' } })
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createWorkspace).toHaveBeenCalledWith('newone', 'main')
  })
})
