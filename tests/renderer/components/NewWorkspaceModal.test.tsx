// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NewWorkspaceModal } from '../../../src/renderer/src/components/NewWorkspaceModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkProject, mkWs, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  api.listBranches.mockResolvedValue({ branches: ['main', 'dev'], defaultBranch: 'main' })
  // The modal is always opened in the context of a project.
  useStore.setState({ projects: [mkProject({ id: 'p1', name: 'proj' })], newWorkspaceProjectId: 'p1' })
})

const nameInput = (): HTMLElement => screen.getByPlaceholderText('напр. feature/login')
const searchInput = (): HTMLElement => screen.getByPlaceholderText('Пошук гілки…')

describe('NewWorkspaceModal', () => {
  it('loads the project branches on mount and preselects the default', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    expect(api.listBranches).toHaveBeenCalledWith('p1')
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('flags a duplicate name within the project and disables submit', async () => {
    useStore.setState({
      projects: [mkProject({ id: 'p1' })],
      newWorkspaceProjectId: 'p1',
      workspaces: [mkWs({ id: 'a', projectId: 'p1', name: 'dup', branch: 'dup' })]
    })
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(nameInput(), { target: { value: 'dup' } })
    expect(screen.getByText(/вже існує/)).toBeInTheDocument()
    expect(screen.getByText('Створити')).toBeDisabled()
  })

  it('does not flag a name used only in another project', async () => {
    useStore.setState({
      projects: [mkProject({ id: 'p1' })],
      newWorkspaceProjectId: 'p1',
      workspaces: [mkWs({ id: 'a', projectId: 'p2', name: 'dup', branch: 'dup' })]
    })
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(nameInput(), { target: { value: 'dup' } })
    expect(screen.queryByText(/вже існує/)).not.toBeInTheDocument()
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

  it('submits the project id, trimmed name and selected base', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.change(nameInput(), { target: { value: '  newone  ' } })
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createWorkspace).toHaveBeenCalledWith('p1', 'newone', 'main')
  })
})
