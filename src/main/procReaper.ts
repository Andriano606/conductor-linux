import { readdirSync, readlinkSync, readFileSync } from 'fs'

// node-pty's group-kill (process.kill(-pid)) only reaps the tracked shell and its
// direct group. Anything that detaches into its OWN process group — a background
// test runner (rspec), the chromedriver/headless-Chrome tree it spawns, a daemon
// double-forked by a setup script — survives that kill, and survives the app being
// closed with the window's X. Those orphans keep ports bound and DB transactions
// open (a stale rspec holding a MySQL metadata lock once wedged a workspace's whole
// setup). This module finds and kills every process still rooted in a workspace's
// worktree, regardless of process group, so teardown/restore/launch can guarantee a
// clean slate.

const DELETED = ' (deleted)'
/** Grace between SIGTERM and the SIGKILL sweep, for procs that exit cleanly. */
const REAP_GRACE_MS = 1500

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * True when a process's /proc/<pid>/cwd symlink target lies within the worktree.
 * Once the worktree directory is removed (e.g. `git worktree remove` while a
 * detached runner is still chdir'd inside it) the kernel appends " (deleted)" to
 * the link target, so strip that suffix before comparing. Boundary-safe: a sibling
 * worktree whose path merely shares a prefix (".../feat" vs ".../feature") is not a
 * match, because we require an exact equality or a "/"-delimited descendant.
 */
export function cwdInsideWorkspace(cwdLink: string, wsPath: string): boolean {
  if (!cwdLink || !wsPath) return false
  const real = cwdLink.endsWith(DELETED) ? cwdLink.slice(0, -DELETED.length) : cwdLink
  return real === wsPath || real.startsWith(wsPath + '/')
}

/**
 * True when a process's raw /proc/<pid>/environ still carries the exact
 * CONDUCTOR_WORKSPACE_PATH we inject in buildEnv(). environ is NUL-delimited, so we
 * match the full `KEY=value\0` token. This catches a process that has since chdir'd
 * out of the worktree (its cwd no longer points inside) yet inherited our env, and
 * the exact-value match guarantees we never touch another workspace's processes.
 */
export function envMarksWorkspace(environ: string, wsPath: string): boolean {
  if (!environ || !wsPath) return false
  return environ.includes(`CONDUCTOR_WORKSPACE_PATH=${wsPath}\0`)
}

/** A /proc reader, injectable so the scan is unit-testable without a real procfs. */
export interface ProcSource {
  list(): string[]
  cwd(pid: number): string | null
  environ(pid: number): string | null
}

/** The real Linux procfs reader; every read is best-effort (procs vanish, races). */
export const procfs: ProcSource = {
  list() {
    try {
      return readdirSync('/proc')
    } catch {
      return []
    }
  },
  cwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  },
  environ(pid) {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      return null
    }
  }
}

/**
 * Every live pid rooted in the workspace, by cwd OR by inherited env marker (see
 * the two predicates). Our own process, its parent and pid<=1 are always excluded
 * so the reaper can never signal Electron itself or init. Linux-only — on a host
 * without /proc the list is empty and callers degrade to a no-op.
 */
export function findWorkspacePids(wsPath: string, src: ProcSource = procfs): number[] {
  if (!wsPath) return []
  const self = process.pid
  const parent = process.ppid
  const pids: number[] = []
  for (const name of src.list()) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid <= 1 || pid === self || pid === parent) continue
    const cwd = src.cwd(pid)
    const byCwd = cwd != null && cwdInsideWorkspace(cwd, wsPath)
    const byEnv = !byCwd && envMarksWorkspace(src.environ(pid) ?? '', wsPath)
    if (byCwd || byEnv) pids.push(pid)
  }
  return pids
}

/**
 * Kill every process rooted in the workspace (see findWorkspacePids): SIGTERM the
 * lot, wait a short grace, then SIGKILL whatever a fresh scan still finds. The
 * re-scan matters — killing a parent can leave just-reparented children that the
 * first pass never saw. Best-effort throughout: vanished or unkillable pids are
 * ignored, and on a host without /proc this is a no-op. Returns the pids signalled
 * in the first pass (useful for logging/tests).
 */
export async function reapWorkspaceProcesses(
  wsPath: string,
  src: ProcSource = procfs
): Promise<number[]> {
  const first = findWorkspacePids(wsPath, src)
  if (first.length === 0) return first
  for (const pid of first) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  await delay(REAP_GRACE_MS)
  for (const pid of findWorkspacePids(wsPath, src)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone or unkillable */
    }
  }
  return first
}
