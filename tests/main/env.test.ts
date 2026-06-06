import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEnv } from '../../src/main/env'
import type { Settings, Workspace } from '../../src/shared/types'

const ws: Workspace = {
  id: 'id-1',
  name: 'feature-x',
  branch: 'feature-x',
  baseBranch: 'main',
  path: '/wt/feature-x',
  port: 3005,
  createdAt: 0,
  status: 'active'
}

const settings: Settings = {
  repoPath: '/repo',
  worktreesDir: '/wt',
  startPort: 3002,
  setupScript: '',
  runScript: '',
  archiveScript: '',
  ideCommand: ''
}

describe('buildEnv', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    // Simulate AppImage leak vars + an unrelated var being present.
    process.env.ARGV0 = 'Conductor Linux-0.1.0'
    process.env.APPIMAGE = '/tmp/app.AppImage'
    process.env.APPDIR = '/tmp/.mount'
    process.env.OWD = '/home/user'
    process.env.CONDUCTOR_TEST_KEEP = 'keep-me'
  })

  afterEach(() => {
    for (const k of ['ARGV0', 'APPIMAGE', 'APPDIR', 'OWD', 'CONDUCTOR_TEST_KEEP']) {
      if (k in saved) process.env[k] = saved[k]
      else delete process.env[k]
    }
  })

  it('injects all four CONDUCTOR_* vars with correct values', () => {
    const env = buildEnv(ws, settings)
    expect(env.CONDUCTOR_WORKSPACE_PATH).toBe('/wt/feature-x')
    expect(env.CONDUCTOR_ROOT_PATH).toBe('/repo')
    expect(env.CONDUCTOR_WORKSPACE_NAME).toBe('feature-x')
    expect(env.CONDUCTOR_PORT).toBe('3005')
  })

  it('exposes the port as a string', () => {
    const env = buildEnv(ws, settings)
    expect(typeof env.CONDUCTOR_PORT).toBe('string')
  })

  it('strips AppImage-runtime leak vars', () => {
    const env = buildEnv(ws, settings)
    expect(env.ARGV0).toBeUndefined()
    expect(env.APPIMAGE).toBeUndefined()
    expect(env.APPDIR).toBeUndefined()
    expect(env.OWD).toBeUndefined()
  })

  it('preserves unrelated existing env vars', () => {
    const env = buildEnv(ws, settings)
    expect(env.CONDUCTOR_TEST_KEEP).toBe('keep-me')
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('does not mutate process.env', () => {
    buildEnv(ws, settings)
    expect(process.env.ARGV0).toBe('Conductor Linux-0.1.0')
    expect(process.env.CONDUCTOR_WORKSPACE_PATH).toBeUndefined()
  })
})
