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
const scriptInputs = (): HTMLElement[] =>
  screen.getAllByPlaceholderText('/шлях/до/скрипта.sh') as HTMLElement[]

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

  it('renders the three script fields', () => {
    render(<NewProjectModal />)
    expect(screen.getByText('Setup-скрипт')).toBeInTheDocument()
    expect(screen.getByText('Run-скрипт')).toBeInTheDocument()
    expect(screen.getByText('Archive-скрипт')).toBeInTheDocument()
    expect(scriptInputs()).toHaveLength(3)
  })

  it('flags a non-git folder and disables submit', async () => {
    api.isGitRepo.mockResolvedValue(false)
    render(<NewProjectModal />)
    fireEvent.change(pathInput(), { target: { value: '/home/me/plain' } })
    await waitFor(() => expect(screen.getByText(/це не git-репозиторій/)).toBeInTheDocument())
    expect(screen.getByText('Створити')).toBeDisabled()
  })

  it('submits the trimmed path and the entered scripts', async () => {
    api.isGitRepo.mockResolvedValue(true)
    render(<NewProjectModal />)
    fireEvent.change(pathInput(), { target: { value: '/home/me/cool-app' } })
    fireEvent.change(scriptInputs()[0], { target: { value: '/s.sh' } })
    fireEvent.change(scriptInputs()[1], { target: { value: '/r.sh' } })
    await waitFor(() => expect(screen.getByText('Створити')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Створити'))
    expect(api.createProject).toHaveBeenCalledWith('/home/me/cool-app', {
      setupScript: '/s.sh',
      runScript: '/r.sh',
      archiveScript: ''
    })
  })
})
