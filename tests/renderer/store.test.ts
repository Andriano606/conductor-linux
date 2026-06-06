// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '../../src/shared/types'
import { useStore } from '../../src/renderer/src/store'
import { makeApi, mkWs, settings as baseSettings } from './helpers'

const initial = {
  settings: null,
  workspaces: [],
  activeId: null,
  activeKind: 'claude' as const,
  showSettings: false,
  showNew: false,
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
    api.getSettings.mockResolvedValue({ ...baseSettings, repoPath: '/repo' })
    api.listWorkspaces.mockResolvedValue(ws)
    await get().load()
    expect(get().workspaces).toHaveLength(2)
    expect(get().activeId).toBe('live')
    expect(get().showSettings).toBe(false)
  })

  it('forces settings open when repoPath is empty', async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, repoPath: '' })
    api.listWorkspaces.mockResolvedValue([])
    await get().load()
    expect(get().showSettings).toBe(true)
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

describe('openNew', () => {
  it('clears stale busy/error when opening', () => {
    useStore.setState({ busy: true, error: 'old' })
    get().openNew(true)
    expect(get()).toMatchObject({ showNew: true, busy: false, error: null })
  })
  it('closes without touching busy/error', () => {
    get().openNew(false)
    expect(get().showNew).toBe(false)
  })
})

describe('createWorkspace', () => {
  it('switches to the task tab and activates the new workspace on success', async () => {
    api.createWorkspace.mockResolvedValue(mkWs({ id: 'new' }))
    await get().createWorkspace('feat', 'main')
    expect(api.createWorkspace).toHaveBeenCalledWith('feat', 'main')
    expect(get()).toMatchObject({
      showNew: false,
      activeId: 'new',
      activeKind: 'task',
      busy: false
    })
    expect(get().kindById.new).toBe('task')
  })

  it('surfaces the error and clears busy on failure', async () => {
    api.createWorkspace.mockRejectedValue(new Error('branch exists'))
    await get().createWorkspace('feat')
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
  it('setRunning / setWorkspaces / clearError', () => {
    get().setRunning('a', true)
    expect(get().runningById.a).toBe(true)
    const ws: Workspace[] = [mkWs({ id: 'x' })]
    get().setWorkspaces(ws)
    expect(get().workspaces).toEqual(ws)
    useStore.setState({ error: 'boom' })
    get().clearError()
    expect(get().error).toBeNull()
  })
})
