// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NewProjectModal } from '../../../src/renderer/src/components/NewProjectModal'
import { Api, setupRenderer } from '../helpers'

let api: Api
beforeEach(() => {
  api = setupRenderer()
})

const pathInput = (): HTMLElement => screen.getByPlaceholderText('/шлях/до/репозиторію')

describe('NewProjectModal', () => {
  it('confirms a git repo and enables submit', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<NewProjectModal />)
    fireEvent.change(pathInput(), { target: { value: '/home/me/cool-app' } })
    await waitFor(() => expect(screen.getByText(/git-репозиторій знайдено/)).toBeInTheDocument())
    expect(screen.getByText('Створити')).not.toBeDisabled()
  })

  it('has no project-name field — the name comes from the folder', () => {
    render(<NewProjectModal />)
    expect(screen.queryByPlaceholderText('напр. my-app')).not.toBeInTheDocument()
  })

  it('flags a non-git folder and disables submit', async () => {
    api.isGitRepo.mockResolvedValue(false)
    render(<NewProjectModal />)
    fireEvent.change(pathInput(), { target: { value: '/home/me/plain' } })
    await waitFor(() => expect(screen.getByText(/це не git-репозиторій/)).toBeInTheDocument())
    expect(screen.getByText('Створити')).toBeDisabled()
  })

  it('submits the trimmed path without an explicit name', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<NewProjectModal />)
    fireEvent.change(pathInput(), { target: { value: '/home/me/cool-app' } })
    await waitFor(() => expect(screen.getByText('Створити')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createProject).toHaveBeenCalledWith('/home/me/cool-app')
  })
})
