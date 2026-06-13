import { watch, type FSWatcher } from 'fs'

/**
 * Per-workspace filesystem watchers on a worktree's git HEAD. The toolbar only
 * *pulls* the live branch on switch/focus, so a manual `git branch -m` or
 * `git checkout` in the terminal would otherwise show up with a delay. Watching
 * the worktree's gitdir for HEAD writes lets main *push* a reconcile the instant
 * the branch changes. Keyed by workspace id.
 */
const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Watch a worktree's gitdir and fire `onChange` whenever HEAD is rewritten
 * (branch switch/rename). `gitDir` is the worktree's own git directory (see
 * git.ts `worktreeGitDir`). Debounced, because git writes HEAD via a HEAD.lock
 * rename, producing a short burst of events. Idempotent — replaces any existing
 * watcher for the id.
 */
export function startBranchWatch(id: string, gitDir: string, onChange: () => void): void {
  stopBranchWatch(id)
  try {
    const w = watch(gitDir, (_event, filename) => {
      // Watching the dir yields events for HEAD, HEAD.lock, index, … — only HEAD
      // matters. A null filename (rare on Linux) can't be filtered, so let it pass.
      if (filename && filename !== 'HEAD') return
      clearTimeout(timers.get(id))
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          onChange()
        }, 150)
      )
    })
    // A removed worktree (archive) yanks the dir out from under us — drop quietly.
    w.on('error', () => stopBranchWatch(id))
    watchers.set(id, w)
  } catch {
    /* gitdir missing / not a worktree yet — nothing to watch */
  }
}

/** Stop and forget a workspace's HEAD watcher (no-op if none). */
export function stopBranchWatch(id: string): void {
  watchers.get(id)?.close()
  watchers.delete(id)
  clearTimeout(timers.get(id))
  timers.delete(id)
}

/** Tear down every HEAD watcher (on quit). */
export function stopAllBranchWatches(): void {
  for (const id of [...watchers.keys()]) stopBranchWatch(id)
}
