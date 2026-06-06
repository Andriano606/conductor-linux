// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SettingsModal } from '../../../src/renderer/src/components/SettingsModal'
import { useStore } from '../../../src/renderer/src/store'
import { Api, settings, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

describe('SettingsModal', () => {
  it('saves the global settings', () => {
    useStore.setState({ settings: { ...settings, worktreesDir: '/wt' } })
    render(<SettingsModal />)
    const save = screen.getByText('Зберегти')
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    expect(api.setSettings).toHaveBeenCalled()
  })

  it('disables saving when the worktrees dir is empty', () => {
    useStore.setState({ settings: { ...settings, worktreesDir: '' } })
    render(<SettingsModal />)
    expect(screen.getByText('Зберегти')).toBeDisabled()
  })

  it('disables saving when the port is out of range', () => {
    useStore.setState({ settings: { ...settings, worktreesDir: '/wt' } })
    render(<SettingsModal />)
    fireEvent.change(screen.getByDisplayValue('3002'), { target: { value: '80' } })
    expect(screen.getByText('Зберегти')).toBeDisabled()
  })

  it('edits the IDE command and claude args fields', () => {
    useStore.setState({ settings: { ...settings, worktreesDir: '/wt' } })
    render(<SettingsModal />)
    const ide = screen.getByPlaceholderText('code')
    fireEvent.change(ide, { target: { value: 'cursor' } })
    expect((ide as HTMLInputElement).value).toBe('cursor')
  })
})
