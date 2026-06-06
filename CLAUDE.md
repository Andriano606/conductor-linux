# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Linux desktop app (Electron + React + TypeScript) that runs **parallel Claude Code sessions**, each isolated in its own **git worktree** — a Linux clone of conductor.build. You register one or more **projects** (each a target git repo with its own setup/run/archive scripts); within a project you create **workspaces** — a separate checkout of that repo on its own branch, with its own interactive `claude` session and its own port. Worktrees live under `worktreesDir/<project-slug>/<workspace-slug>`.

Prerequisites at runtime: Node 20+, `git`, and the `claude` CLI on `PATH` (auth is inherited from the already-logged-in CLI). Note: much of the UI and inline strings are in Ukrainian.

## Commands

```bash
npm install          # postinstall auto-rebuilds node-pty against Electron's ABI
npm run dev          # run in dev (electron-vite, HMR for renderer)
npm run build        # typecheck + build main/preload/renderer into out/
npm run dist         # build then package AppImage + deb (electron-builder, Linux)
npm run rebuild      # manually rebuild node-pty if you hit native-module ABI errors
```

```bash
npm test             # run the Vitest suite (main + renderer)
```

Correctness gates: `npm run build` (runs `tsc` via electron-vite) for types, and `npm test` (Vitest) for behaviour. No linter or formatter is configured.

## Architecture

Three Electron processes, each a separate electron-vite build target (see `electron.vite.config.ts`). Types are shared via `src/shared/types.ts`; the renderer imports it through the `@shared` alias.

- **main** (`src/main/`) — Node side. Owns all git, filesystem, PTY processes, and persisted state. Pure functions per concern, wired together in `ipc.ts`.
- **preload** (`src/preload/index.ts`) — exposes a single typed `window.api` object over `contextBridge` (contextIsolation on, nodeIntegration off). Every renderer→main call goes through here. The `Api` type is derived from this object and consumed by the renderer.
- **renderer** (`src/renderer/src/`) — React + `zustand` store. No direct Node access; everything via `window.api`.

### The two-layer terminal model (the core trick)

Terminals exist as a buffer in main **and** a live xterm instance in renderer, both keyed by `${workspaceId}:${kind}` where `kind` is one of `claude | task | shell`:

- `src/main/ptyManager.ts` — spawns `node-pty` procs, accumulates output into a per-key ring buffer (capped at `MAX_BUFFER`), and only forwards live data to the renderer when a terminal is `streaming` (flipped on `attach`). `attach()` returns the buffer snapshot atomically, then streaming begins — this is how scrollback survives even when no UI is mounted.
- `src/renderer/src/termRegistry.ts` — keeps one long-lived `xterm` instance per key so scrollback survives tab/workspace switches; the wrapper DOM element is *moved* into the visible host on activation rather than recreated. Only `TerminalView.tsx` mounts/fits it.

The three kinds: `claude` (interactive `claude` session), `shell` (free interactive shell, started lazily on first Terminal-tab open), `task` (read-only — aggregates setup/run/archive script output; the "Скрипти" tab). The `task` terminal is `disableStdin` in xterm so the user can't Ctrl+C the running app.

**Process-group kill** (`killProc` in ptyManager): procs are killed via `process.kill(-pid, ...)` (negative pid = whole group) because node-pty's own `.kill()` only signals the shell, leaving a dev server (and its bound port) alive. This is why Run/Stop and archive actually free ports.

### Workspace lifecycle

`src/main/workspaces.ts` orchestrates everything; `src/main/git.ts` is the only place that shells out to `git`. Status state machine (`WorkspaceStatus`): `setting_up → active → archiving → archived`.

- **Create**: `createWorkspace(projectId, name, baseBranch?)` adds the worktree+branch synchronously under the workspace's **project** (see Projects below) and returns immediately with `setting_up`; `finishSetup` then runs the project's setup script and starts `claude` **in the background** so the UI never blocks. IPC handlers in `ipc.ts` follow this pattern (`void finishSetup(...)`, `notifyWorkspacesChanged()`).
- **Archive**: `beginArchive` (stops run, flips to `archiving`) then background `finishArchive` (archive script → kill PTYs → `git worktree remove --force`). The git **branch is kept** so the workspace can be restored.
- **Restore/Delete**: `restoreWorktree` re-adds the worktree on the existing branch (prunes stale refs first); `deleteArchivedWorkspace` removes worktree + deletes the branch permanently.
- **Self-healing on launch** (`restoreSessions`): a workspace left in a transient state by an interrupted run (`archiving`/`setting_up`) is reconciled to `active` or `archived` based on whether its worktree dir still exists, then `claude` is restarted for every live workspace (PTYs are memory-only and die on quit).

### Projects

A **project** (`Project` in `src/shared/types.ts`) is a registered git repository that workspaces are worktrees of. Each project carries its own `repoPath` and the three scripts (`setupScript`/`runScript`/`archiveScript`), so different repos can have different setup/run/archive behaviour. The sidebar lists projects as groups; each has a `+` (new workspace in that project) and `⚙` (per-project settings, incl. delete). `createProject(repoPath, name?)` validates the path is a git repo; `deleteProject` tears down every workspace under it (kill PTYs → remove worktrees → delete branches) then drops the project. Workspaces carry a `projectId`; every main-side operation resolves the workspace's project via `getProject(ws.projectId)` to find the repo path and scripts.

### State & settings persistence

`src/main/store.ts` is an in-memory object persisted to `app.getPath('userData')/conductor-data.json` on every mutation. It holds the **global** `Settings` (worktrees dir, startPort, IDE command, claude args), the `Project[]`, and the `Workspace[]`. Per-repo concerns (repo path + the three scripts) live on `Project`, **not** `Settings`. `initStore()` runs a one-shot **migration**: a legacy data file whose global settings still hold `repoPath`/scripts (and whose workspaces lack `projectId`) is folded into a single synthesized project, and every orphan workspace is stamped with its id. `nextPort()` hands out the lowest free port from `startPort` (unique across all projects), exposed to scripts as `CONDUCTOR_PORT`.

### Scripts environment

`src/main/env.ts` `buildEnv(ws, project)` builds the env for every spawned shell/script. It injects the conductor-compatible `CONDUCTOR_*` vars (`CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH` = the project's repo path, `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_PORT`) and **deletes AppImage-runtime leak vars** (`ARGV0`, `APPIMAGE`, `APPDIR`, `OWD`). The `ARGV0` deletion is load-bearing: uutils-coreutils multicall binaries read it and abort `mkdir`/`tail`/etc. with "Security violation". `scripts/` holds example `setup.sh`/`run.sh`/`archive.sh` — the app hardcodes no project specifics; each project's scripts do per-workspace work (DB, deps) via the `CONDUCTOR_*` vars.

## Linux-specific gotchas (don't regress these)

- **AppImage runs with `--no-sandbox`** (no access to Chromium's SUID sandbox) — see `scripts/install-desktop.sh`. The env-var stripping above is the companion fix.
- **No native `confirm()`**: native dialogs on Linux left the window unfocused and froze the next modal. Confirmation is an in-app modal driven by `askConfirm`/`resolveConfirm` in the renderer store (`ConfirmModal.tsx`).
- **`fetchQuiet` in git.ts** has a hard 8.5s deadline + SIGKILL so a hung remote/credential prompt can't make the New-workspace branch loader hang forever.
