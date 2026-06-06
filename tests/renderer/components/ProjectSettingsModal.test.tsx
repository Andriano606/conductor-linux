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
  it('prefills the project fields', () => {
    render(<ProjectSettingsModal />)
    expect((screen.getByDisplayValue('proj') as HTMLInputElement).value).toBe('proj')
    expect(screen.getByDisplayValue('/repo')).toBeInTheDocument()
    expect(screen.getByDisplayValue('/s.sh')).toBeInTheDocument()
  })

  it('saves an edited name and script via updateProject', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<ProjectSettingsModal />)
    fireEvent.change(screen.getByDisplayValue('proj'), { target: { value: 'renamed' } })
    await waitFor(() => expect(screen.getByText('Зберегти')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Зберегти'))
    expect(api.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', name: 'renamed', setupScript: '/s.sh' })
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
