// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsModal } from '../../../src/renderer/src/components/SettingsModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, settings, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

describe('SettingsModal', () => {
  it('confirms a valid git repo and saves', async () => {
    useStore.setState({ settings: { ...settings, repoPath: '/repo', worktreesDir: '/wt' } })
    api.isGitRepo.mockResolvedValue(true)
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText(/git-репозиторій знайдено/)).toBeInTheDocument())
    const save = screen.getByText('Зберегти')
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    expect(api.setSettings).toHaveBeenCalled()
  })

  it('flags a non-git repo and disables saving', async () => {
    useStore.setState({ settings: { ...settings, repoPath: '/not-a-repo', worktreesDir: '/wt' } })
    api.isGitRepo.mockResolvedValue(false)
    render(<SettingsModal />)
    await waitFor(() => expect(screen.getByText(/це не git-репозиторій/)).toBeInTheDocument())
    expect(screen.getByText('Зберегти')).toBeDisabled()
  })

  it('disables saving when the port is out of range', () => {
    useStore.setState({ settings: { ...settings, repoPath: '/repo', worktreesDir: '/wt' } })
    render(<SettingsModal />)
    fireEvent.change(screen.getByDisplayValue('3002'), { target: { value: '80' } })
    expect(screen.getByText('Зберегти')).toBeDisabled()
  })

  it('hides Cancel on first run (no repo configured yet)', () => {
    // settings null → form repoPath '' → first-run, no escape hatch.
    render(<SettingsModal />)
    expect(screen.queryByText('Скасувати')).not.toBeInTheDocument()
  })
})
