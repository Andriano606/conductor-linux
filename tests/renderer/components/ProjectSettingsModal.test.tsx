// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectSettingsModal } from '../../../src/renderer/src/components/ProjectSettingsModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, mkProject, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
  useStore.setState({
    projects: [mkProject({ id: 'p1', name: 'proj', repoPath: '/repo', setupScript: '/s.sh' })],
    projectSettingsId: 'p1'
  })
})

describe('ProjectSettingsModal', () => {
  it('prefills the repo path and scripts (name shown in the heading, not editable)', () => {
    render(<ProjectSettingsModal />)
    expect(screen.getByText(/Налаштування проекту · proj/)).toBeInTheDocument()
    expect(screen.getByDisplayValue('/repo')).toBeInTheDocument()
    expect(screen.getByDisplayValue('/s.sh')).toBeInTheDocument()
  })

  it('has no editable project-name field', () => {
    render(<ProjectSettingsModal />)
    // The only value matching the name should be the (non-input) heading text.
    expect(screen.queryByDisplayValue('proj')).not.toBeInTheDocument()
  })

  it('saves an edited script via updateProject', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<ProjectSettingsModal />)
    fireEvent.change(screen.getByDisplayValue('/s.sh'), { target: { value: '/setup2.sh' } })
    await waitFor(() => expect(screen.getByText('Зберегти')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Зберегти'))
    expect(api.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', repoPath: '/repo', setupScript: '/setup2.sh' })
    )
  })

  it('saves an edited browser host via updateProject', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<ProjectSettingsModal />)
    fireEvent.change(screen.getByPlaceholderText('localhost'), {
      target: { value: 'myapp.local' }
    })
    await waitFor(() => expect(screen.getByText('Зберегти')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Зберегти'))
    expect(api.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', browserHost: 'myapp.local' })
    )
  })

  it('disables saving when the repo path is flagged not-a-git-repo', async () => {
    api.isGitRepo.mockResolvedValue(false)
    render(<ProjectSettingsModal />)
    await waitFor(() => expect(screen.getByText(/це не git-репозиторій/)).toBeInTheDocument())
    expect(screen.getByText('Зберегти')).toBeDisabled()
  })

  it('deletes the project only after confirmation', async () => {
    render(<ProjectSettingsModal />)
    fireEvent.click(screen.getByText(/Видалити проект/))
    expect(api.deleteProject).not.toHaveBeenCalled()
    await act(async () => {
      useStore.getState().resolveConfirm(true)
    })
    expect(api.deleteProject).toHaveBeenCalledWith('p1')
  })
})
