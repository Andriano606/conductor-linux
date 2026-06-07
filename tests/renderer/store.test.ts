// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Workspace } from '../../src/shared/types'
import { useStore } from '../../src/renderer/src/store'
import { makeApi, mkProject, mkWs, settings as baseSettings } from './helpers'

const initial = {
  settings: null,
  projects: [],
  workspaces: [],
  activeId: null,
  activeKind: 'claude' as const,
  showSettings: false,
  newWorkspaceProjectId: null,
  showNewProject: false,
  projectSettingsId: null,
  showArchived: false,
  busy: false,
  error: null,
  runningById: {},
  kindById: {},
  confirmRequest: null
}

let api: ReturnType<typeof makeApi>

beforeEach(() => {
  api = makeApi()
  ;(window as unknown as { api: typeof api }).api = api
  useStore.setState({ ...initial })
})

const get = useStore.getState

describe('load', () => {
  it('sets state and selects the first non-archived workspace', async () => {
    const ws: Workspace[] = [
      mkWs({ id: 'arch', status: 'archived' }),
      mkWs({ id: 'live', status: 'active' })
    ]
    api.getSettings.mockResolvedValue(baseSettings)
    api.listProjects.mockResolvedValue([mkProject()])
    api.listWorkspaces.mockResolvedValue(ws)
    await get().load()
    expect(get().projects).toHaveLength(1)
    expect(get().workspaces).toHaveLength(2)
    expect(get().activeId).toBe('live')
    expect(get().showSettings).toBe(false)
  })

  it('selects nothing and opens no modal when there are no workspaces', async () => {
    api.listProjects.mockResolvedValue([])
    api.listWorkspaces.mockResolvedValue([])
    await get().load()
    expect(get().showSettings).toBe(false)
    expect(get().activeId).toBeNull()
  })
})

describe('askConfirm / resolveConfirm', () => {
  it('resolves true when confirmed', async () => {
    const p = get().askConfirm('Sure?')
    expect(get().confirmRequest?.message).toBe('Sure?')
    get().resolveConfirm(true)
    await expect(p).resolves.toBe(true)
    expect(get().confirmRequest).toBeNull()
  })

  it('resolves false when cancelled', async () => {
    const p = get().askConfirm('Sure?')
    get().resolveConfirm(false)
    await expect(p).resolves.toBe(false)
    expect(get().confirmRequest).toBeNull()
  })
})

describe('setActive / setKind', () => {
  it('restores the remembered tab for a workspace (default claude)', () => {
    useStore.setState({ kindById: { a: 'shell' } })
    get().setActive('a')
    expect(get()).toMatchObject({ activeId: 'a', activeKind: 'shell' })
    get().setActive('b')
    expect(get().activeKind).toBe('claude')
  })

  it('records the chosen tab for the active workspace', () => {
    useStore.setState({ activeId: 'a' })
    get().setKind('task')
    expect(get().activeKind).toBe('task')
    expect(get().kindById.a).toBe('task')
  })

  it('does not record a tab when no workspace is active', () => {
    get().setKind('task')
    expect(get().kindById).toEqual({})
  })
})

describe('openNewProject / openNewWorkspace', () => {
  it('opening New-project clears stale busy/error', () => {
    useStore.setState({ busy: true, error: 'old' })
    get().openNewProject(true)
    expect(get()).toMatchObject({ showNewProject: true, busy: false, error: null })
    get().openNewProject(false)
    expect(get().showNewProject).toBe(false)
  })

  it('opening New-workspace records the project id and clears busy/error', () => {
    useStore.setState({ busy: true, error: 'old' })
    get().openNewWorkspace('p1')
    expect(get()).toMatchObject({ newWorkspaceProjectId: 'p1', busy: false, error: null })
    get().openNewWorkspace(null)
    expect(get().newWorkspaceProjectId).toBeNull()
  })
})

describe('createProject', () => {
  it('forwards repo path + scripts and closes the modal on success', async () => {
    await get().createProject('/repo', { setupScript: '/s.sh' })
    expect(api.createProject).toHaveBeenCalledWith('/repo', { setupScript: '/s.sh' })
    expect(get()).toMatchObject({ showNewProject: false, busy: false })
  })
  it('surfaces the error and clears busy on failure', async () => {
    api.createProject.mockRejectedValue(new Error('not a git repo'))
    await get().createProject('/repo')
    expect(get().error).toBe('not a git repo')
    expect(get().busy).toBe(false)
  })
})

describe('saveProject / deleteProject', () => {
  it('saveProject calls the api and closes the project settings modal', async () => {
    useStore.setState({ projectSettingsId: 'p1' })
    const p = mkProject({ id: 'p1', name: 'renamed' })
    await get().saveProject(p)
    expect(api.updateProject).toHaveBeenCalledWith(p)
    expect(get().projectSettingsId).toBeNull()
  })
  it('deleteProject calls the api and closes the modal', async () => {
    useStore.setState({ projectSettingsId: 'p1' })
    await get().deleteProject('p1')
    expect(api.deleteProject).toHaveBeenCalledWith('p1')
    expect(get().projectSettingsId).toBeNull()
  })
  it('deleteProject sets error on failure', async () => {
    api.deleteProject.mockRejectedValue(new Error('busy'))
    await get().deleteProject('p1')
    expect(get().error).toBe('busy')
  })
})

describe('createWorkspace', () => {
  it('switches to the task tab and activates the new workspace on success', async () => {
    api.createWorkspace.mockResolvedValue(mkWs({ id: 'new' }))
    await get().createWorkspace('p1', 'feat', 'main')
    expect(api.createWorkspace).toHaveBeenCalledWith('p1', 'feat', 'main', undefined)
    expect(get()).toMatchObject({
      newWorkspaceProjectId: null,
      activeId: 'new',
      activeKind: 'task',
      busy: false
    })
    expect(get().kindById.new).toBe('task')
  })

  it('surfaces the error and clears busy on failure', async () => {
    api.createWorkspace.mockRejectedValue(new Error('branch exists'))
    await get().createWorkspace('p1', 'feat')
    expect(get().error).toBe('branch exists')
    expect(get().busy).toBe(false)
  })
})

describe('runActive', () => {
  it('optimistically flips to running on the task tab', async () => {
    useStore.setState({ activeId: 'a' })
    await get().runActive()
    expect(api.runWorkspace).toHaveBeenCalledWith('a')
    expect(get()).toMatchObject({ activeKind: 'task', error: null })
    expect(get().runningById.a).toBe(true)
    expect(get().kindById.a).toBe('task')
  })

  it('rolls running back and sets error on failure', async () => {
    useStore.setState({ activeId: 'a' })
    api.runWorkspace.mockRejectedValue(new Error('no run script'))
    await get().runActive()
    expect(get().runningById.a).toBe(false)
    expect(get().error).toBe('no run script')
  })

  it('is a no-op without an active workspace', async () => {
    await get().runActive()
    expect(api.runWorkspace).not.toHaveBeenCalled()
  })
})

describe('stopActive', () => {
  it('calls the api and sets error on failure', async () => {
    useStore.setState({ activeId: 'a' })
    await get().stopActive()
    expect(api.stopWorkspace).toHaveBeenCalledWith('a')
    api.stopWorkspace.mockRejectedValue(new Error('fail'))
    await get().stopActive()
    expect(get().error).toBe('fail')
  })
})

describe('archiveActive', () => {
  it('switches to the task tab and calls the api', async () => {
    useStore.setState({ activeId: 'a' })
    await get().archiveActive()
    expect(api.archiveWorkspace).toHaveBeenCalledWith('a')
    expect(get().activeKind).toBe('task')
    expect(get().kindById.a).toBe('task')
  })
  it('sets error on failure', async () => {
    useStore.setState({ activeId: 'a' })
    api.archiveWorkspace.mockRejectedValue(new Error('busy'))
    await get().archiveActive()
    expect(get().error).toBe('busy')
  })
})

describe('restoreWorkspace', () => {
  it('activates the restored workspace and closes the archived modal', async () => {
    useStore.setState({ showArchived: true })
    await get().restoreWorkspace('a')
    expect(api.restoreWorkspace).toHaveBeenCalledWith('a')
    expect(get()).toMatchObject({ activeId: 'a', activeKind: 'task', showArchived: false })
    expect(get().kindById.a).toBe('task')
  })
  it('sets error on failure', async () => {
    api.restoreWorkspace.mockRejectedValue(new Error('gone'))
    await get().restoreWorkspace('a')
    expect(get().error).toBe('gone')
  })
})

describe('deleteWorkspace', () => {
  it('calls the api and sets error on failure', async () => {
    await get().deleteWorkspace('a')
    expect(api.deleteWorkspace).toHaveBeenCalledWith('a')
    api.deleteWorkspace.mockRejectedValue(new Error('nope'))
    await get().deleteWorkspace('a')
    expect(get().error).toBe('nope')
  })
})

describe('plain setters', () => {
  it('setRunning / setProjects / setWorkspaces / clearError', () => {
    get().setRunning('a', true)
    expect(get().runningById.a).toBe(true)
    get().setProjects([mkProject({ id: 'px' })])
    expect(get().projects).toHaveLength(1)
    const ws: Workspace[] = [mkWs({ id: 'x' })]
    get().setWorkspaces(ws)
    expect(get().workspaces).toEqual(ws)
    useStore.setState({ error: 'boom' })
    get().clearError()
    expect(get().error).toBeNull()
  })
})
