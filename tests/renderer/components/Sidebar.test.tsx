// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Sidebar } from '../../../src/renderer/src/components/Sidebar'
import { useStore } from '../../../src/renderer/src/store'
import { mkWs, setupRenderer } from '../helpers'

beforeEach(() => setupRenderer())

describe('Sidebar', () => {
  it('lists only non-archived workspaces with an archived count badge', () => {
    useStore.setState({
      workspaces: [
        mkWs({ id: 'a', name: 'alpha', status: 'active' }),
        mkWs({ id: 'b', name: 'beta', status: 'active' }),
        mkWs({ id: 'c', name: 'gamma', status: 'archived' })
      ]
    })
    render(<Sidebar />)
    expect(screen.getByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.queryByText('gamma')).not.toBeInTheDocument()
    expect(screen.getByText(/Архів \(1\)/)).toBeInTheDocument()
  })

  it('shows the empty hint when there are no live workspaces', () => {
    render(<Sidebar />)
    expect(screen.getByText(/Немає воркспейсів/)).toBeInTheDocument()
  })

  it('selecting a workspace sets it active', () => {
    useStore.setState({ workspaces: [mkWs({ id: 'a', name: 'alpha' })] })
    render(<Sidebar />)
    fireEvent.click(screen.getByText('alpha'))
    expect(useStore.getState().activeId).toBe('a')
  })

  it('header buttons open the modals', () => {
    render(<Sidebar />)
    fireEvent.click(screen.getByText('+ Новий воркспейс'))
    expect(useStore.getState().showNew).toBe(true)
    fireEvent.click(screen.getByTitle('Налаштування'))
    expect(useStore.getState().showSettings).toBe(true)
    fireEvent.click(screen.getByText(/🗄 Архів/))
    expect(useStore.getState().showArchived).toBe(true)
  })
})
