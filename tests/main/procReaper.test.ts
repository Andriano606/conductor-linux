import { describe, expect, it } from 'vitest'
import {
  cwdInsideWorkspace,
  envMarksWorkspace,
  findWorkspacePids,
  type ProcSource
} from '../../src/main/procReaper'

const WS = '/wt/proj/feature-x'

describe('cwdInsideWorkspace', () => {
  it('matches the worktree root itself', () => {
    expect(cwdInsideWorkspace(WS, WS)).toBe(true)
  })

  it('matches a descendant directory', () => {
    expect(cwdInsideWorkspace(`${WS}/tmp/selenium`, WS)).toBe(true)
  })

  it('matches a removed worktree (kernel "(deleted)" suffix)', () => {
    expect(cwdInsideWorkspace(`${WS} (deleted)`, WS)).toBe(true)
    expect(cwdInsideWorkspace(`${WS}/tmp (deleted)`, WS)).toBe(true)
  })

  it('does not match a sibling sharing a path prefix', () => {
    expect(cwdInsideWorkspace('/wt/proj/feature-xyz', WS)).toBe(false)
    expect(cwdInsideWorkspace('/wt/proj/feature', WS)).toBe(false)
  })

  it('does not match an unrelated path', () => {
    expect(cwdInsideWorkspace('/tmp', WS)).toBe(false)
  })

  it('handles empty inputs safely', () => {
    expect(cwdInsideWorkspace('', WS)).toBe(false)
    expect(cwdInsideWorkspace(WS, '')).toBe(false)
  })
})

describe('envMarksWorkspace', () => {
  it('matches when CONDUCTOR_WORKSPACE_PATH equals the worktree (NUL-delimited)', () => {
    const env = `PATH=/usr/bin\0CONDUCTOR_WORKSPACE_PATH=${WS}\0HOME=/home/u\0`
    expect(envMarksWorkspace(env, WS)).toBe(true)
  })

  it('matches even when the marker is the final token', () => {
    expect(envMarksWorkspace(`FOO=1\0CONDUCTOR_WORKSPACE_PATH=${WS}\0`, WS)).toBe(true)
  })

  it('does not match another workspace whose path shares a prefix', () => {
    const env = `CONDUCTOR_WORKSPACE_PATH=${WS}-2\0`
    expect(envMarksWorkspace(env, WS)).toBe(false)
  })

  it('does not match when the marker is absent', () => {
    expect(envMarksWorkspace('PATH=/usr/bin\0HOME=/home/u\0', WS)).toBe(false)
  })

  it('handles empty inputs safely', () => {
    expect(envMarksWorkspace('', WS)).toBe(false)
  })
})

/** Build a ProcSource from a fixture map of pid → {cwd, environ}. */
function fakeProc(map: Record<number, { cwd?: string; environ?: string }>): ProcSource {
  return {
    list: () => Object.keys(map),
    cwd: (pid) => map[pid]?.cwd ?? null,
    environ: (pid) => map[pid]?.environ ?? null
  }
}

describe('findWorkspacePids', () => {
  it('finds processes by cwd and by env marker, unioned', () => {
    const src = fakeProc({
      100: { cwd: WS }, // by cwd (root)
      101: { cwd: `${WS}/tmp` }, // by cwd (descendant)
      102: { cwd: '/elsewhere', environ: `CONDUCTOR_WORKSPACE_PATH=${WS}\0` }, // chdir'd away, by env
      103: { cwd: `${WS} (deleted)` }, // removed worktree
      200: { cwd: '/other' }, // unrelated
      201: { cwd: '/wt/proj/feature-xyz' } // prefix sibling — must be excluded
    })
    const pids = findWorkspacePids(WS, src).sort((a, b) => a - b)
    expect(pids).toEqual([100, 101, 102, 103])
  })

  it('never returns our own pid, its parent, or pid<=1', () => {
    const src = fakeProc({
      1: { cwd: WS },
      [process.pid]: { cwd: WS },
      [process.ppid]: { cwd: WS }
    })
    expect(findWorkspacePids(WS, src)).toEqual([])
  })

  it('ignores non-numeric /proc entries', () => {
    const src: ProcSource = {
      list: () => ['self', 'cpuinfo', '100'],
      cwd: (pid) => (pid === 100 ? WS : null),
      environ: () => null
    }
    expect(findWorkspacePids(WS, src)).toEqual([100])
  })

  it('returns [] for an empty workspace path', () => {
    expect(findWorkspacePids('', fakeProc({ 100: { cwd: WS } }))).toEqual([])
  })

  it('tolerates unreadable cwd/environ (vanished or foreign procs)', () => {
    const src = fakeProc({ 100: {}, 101: { cwd: WS } })
    expect(findWorkspacePids(WS, src)).toEqual([101])
  })
})
