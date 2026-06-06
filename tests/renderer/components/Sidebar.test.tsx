// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Sidebar } from '../../../src/renderer/src/components/Sidebar'
import { useStore } from '../../../src/renderer/src/store'
import { mkProject, mkWs, setupRenderer } from '../helpers'

beforeEach(() => setupRenderer())

describe('Sidebar', () => {
  it('groups live workspaces under their project with an archived count badge', () => {
    useStore.setState({
      projects: [mkProject({ id: 'p1', name: 'proj-one' })],
      workspaces: [
        mkWs({ id: 'a', projectId: 'p1', name: 'alpha', status: 'active' }),
        mkWs({ id: 'b', projectId: 'p1', name: 'beta', status: 'active' }),
        mkWs({ id: 'c', projectId: 'p1', name: 'gamma', status: 'archived' })
      ]
    })
    render(<Sidebar />)
    expect(screen.getByText('proj-one')).toBeInTheDocument()
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.queryByText('gamma')).not.toBeInTheDocument()
    expect(screen.getByText(/Архів \(1\)/)).toBeInTheDocument()
  })

  it('shows the empty hint when there are no projects', () => {
    render(<Sidebar />)
    expect(screen.getByText(/Немає проектів/)).toBeInTheDocument()
  })

  it('shows a per-project empty hint when a project has no workspaces', () => {
    useStore.setState({ projects: [mkProject({ id: 'p1', name: 'proj-one' })] })
    render(<Sidebar />)
    expect(screen.getByText(/Немає воркспейсів/)).toBeInTheDocument()
  })

  it('selecting a workspace sets it active', () => {
    useStore.setState({
      projects: [mkProject({ id: 'p1' })],
      workspaces: [mkWs({ id: 'a', projectId: 'p1', name: 'alpha' })]
    })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('alpha'))
    expect(useStore.getState().activeId).toBe('a')
  })

  it('the New-project, gear and archive buttons open their targets', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Новий проект'))
    expect(useStore.getState().showNewProject).toBe(true)
    fireEvent.click(screen.getByTitle('Налаштування'))
    expect(useStore.getState().showSettings).toBe(true)
    fireEvent.click(screen.getByText(/🗄 Архів/))
    expect(useStore.getState().showArchived).toBe(true)
  })

  it('the project + and ⚙ buttons open new-workspace and project settings', () => {
    useStore.setState({ projects: [mkProject({ id: 'p1', name: 'proj-one' })] })
    render(<Sidebar />)
    const header = screen.getByText('proj-one').closest('.project-header') as HTMLElement
    fireEvent.click(within(header).getByTitle('Новий воркспейс у цьому проекті'))
    expect(useStore.getState().newWorkspaceProjectId).toBe('p1')
    fireEvent.click(within(header).getByTitle('Налаштування проекту'))
    expect(useStore.getState().projectSettingsId).toBe('p1')
  })
})
