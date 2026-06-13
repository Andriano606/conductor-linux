// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { NewWorkspaceModal } from '../../../src/renderer/src/components/NewWorkspaceModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkProject, mkWs, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  api.listBranches.mockResolvedValue({
    branches: ['main', 'dev', 'origin/main', 'origin/remote-only'],
    existingBranches: ['main', 'dev', 'remote-only'],
    checkedOut: ['main'],
    defaultBranch: 'main'
  })
  // The modal is always opened in the context of a project.
  useStore.setState({ projects: [mkProject({ id: 'p1', name: 'proj' })], newWorkspaceProjectId: 'p1' })
})

const nameInput = (): HTMLElement => screen.getByPlaceholderText('напр. feature/login')
const searchInput = (): HTMLElement => screen.getByPlaceholderText('Пошук гілки…')

describe('NewWorkspaceModal', () => {
  it('loads the project branches on mount and preselects the default', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    // Two-phase load: an instant local read (no fetch) then a background refresh.
    expect(api.listBranches).toHaveBeenCalledWith('p1', false)
    expect(api.listBranches).toHaveBeenCalledWith('p1', true)
    expect(screen.getByText('main')).toBeInTheDocument()
  })

  it('seeds the name with a suggestion not already taken in the project', async () => {
    // Occupy every suggested name except 'sofia' with existing workspaces.
    const taken = ['lisbon', 'porto', 'kyiv', 'oslo', 'tokyo', 'cairo', 'lima', 'dakar', 'hanoi']
    useStore.setState({
      projects: [mkProject({ id: 'p1' })],
      newWorkspaceProjectId: 'p1',
      workspaces: taken.map((b, i) => mkWs({ id: `w${i}`, projectId: 'p1', name: b, branch: b }))
    })
    render(<NewWorkspaceModal />)
    // The only free suggestion must be chosen.
    expect((nameInput() as HTMLInputElement).value).toBe('sofia')
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
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
    expect(api.createWorkspace).toHaveBeenCalledWith('p1', 'newone', 'main', false)
  })

  it('keeps submit disabled until branches finish loading', async () => {
    // Hold the branch list pending so the modal stays in its loading state.
    let resolve!: (v: {
      branches: string[]
      existingBranches: string[]
      checkedOut: string[]
      defaultBranch: string
    }) => void
    api.listBranches.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<NewWorkspaceModal />)
    // Even with a valid name typed, the button is disabled while loading.
    fireEvent.change(nameInput(), { target: { value: 'newone' } })
    expect(screen.getByText('Створити')).toBeDisabled()

    resolve({
      branches: ['main', 'dev'],
      existingBranches: ['main', 'dev'],
      checkedOut: [],
      defaultBranch: 'main'
    })
    await waitFor(() => expect(screen.getByText('Створити')).not.toBeDisabled())
  })
})

describe('NewWorkspaceModal — existing branch', () => {
  const toggle = (): HTMLElement => screen.getByText(/Використати існуючу гілку/)

  it('deactivates the name field and submits the selected branch with no base', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.click(toggle())
    // The name input stays in the DOM (stable layout) but is disabled and cleared.
    const nameField = screen.getByPlaceholderText(/не використовується/) as HTMLInputElement
    expect(nameField).toBeDisabled()
    expect(nameField.value).toBe('')
    // Pick a branch and submit — the branch alone drives the workspace.
    fireEvent.click(within(document.querySelector('.branch-list') as HTMLElement).getByText('dev'))
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createWorkspace).toHaveBeenCalledWith('p1', 'dev', undefined, true)
  })

  it('offers plain branch names only — origin-only ones included, no remote-tracking refs', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.click(toggle())
    const list = document.querySelector('.branch-list') as HTMLElement
    expect(within(list).queryByText('origin/main')).not.toBeInTheDocument()
    expect(within(list).queryByText('origin/remote-only')).not.toBeInTheDocument()
    // A teammate's branch that exists only on origin is selectable by plain name.
    expect(within(list).getByText('remote-only')).toBeInTheDocument()
  })

  it('submits an origin-only branch by its plain name', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.click(toggle())
    const list = document.querySelector('.branch-list') as HTMLElement
    fireEvent.click(within(list).getByText('remote-only'))
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createWorkspace).toHaveBeenCalledWith('p1', 'remote-only', undefined, true)
  })

  it('disables a branch checked out in another worktree (e.g. the main repo)', async () => {
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.click(toggle())
    // 'main' is in checkedOut → blocked with its own tag, not selectable.
    const items = Array.from(document.querySelectorAll('.branch-item')) as HTMLElement[]
    const mainItem = items.find((el) => el.textContent?.startsWith('main')) as HTMLElement
    expect(mainItem.className).toContain('disabled')
    expect(mainItem.textContent).toContain('вилучена в іншому worktree')
    fireEvent.click(mainItem)
    expect(mainItem.className).not.toContain('selected')
    // The auto-picked selection skipped the checked-out 'main' to the first free branch.
    expect(document.querySelector('.branch-current')?.textContent).toContain('dev')
  })

  it('disables a branch that already backs a workspace and prevents selecting it', async () => {
    useStore.setState({
      projects: [mkProject({ id: 'p1' })],
      newWorkspaceProjectId: 'p1',
      workspaces: [mkWs({ id: 'a', projectId: 'p1', name: 'dev', branch: 'dev' })]
    })
    render(<NewWorkspaceModal />)
    await waitFor(() => expect(screen.getByText('dev')).toBeInTheDocument())
    fireEvent.click(toggle())
    const items = Array.from(document.querySelectorAll('.branch-item')) as HTMLElement[]
    const devItem = items.find((el) => el.textContent?.startsWith('dev')) as HTMLElement
    expect(devItem.className).toContain('disabled')
    // Clicking the taken branch does not select it.
    fireEvent.click(devItem)
    expect(devItem.className).not.toContain('selected')
  })
})
