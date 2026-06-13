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

### The Claude tab: a structured chat, not a terminal

The `claude` tab does **not** run the Claude TUI in a PTY. `src/main/claudeChat.ts` spawns `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio` (plus `settings.claudeArgs`) per **chat session** and speaks NDJSON over stdio:

> **Multiple sessions per workspace.** A workspace owns a `sessions: ChatSession[]` array (see Projects/State below); each `ChatSession` is an independent `claude` process. Everything in claudeChat.ts/IPC/chatStore is keyed by an **opaque session id** (the `id` arg of `chat:attach/send/answer/interrupt`, the `entries` Map, `chats/<id>.json`, `claude:busy`/`chat:event` payloads) — it just used to equal the workspace id. The per-session knobs (`claudeSessionId`, `claudeModel`, `claudeEffort`, `claudePermissionMode`) live on `ChatSession`, not `Workspace`. On migration the first session reuses the workspace id so existing transcripts/resume ids keep working. The renderer renders a session tab strip (`SessionTabs.tsx`) above `ChatView` with the active session per workspace tracked in `activeSessionByWorkspace`; `+` calls `createChatSession`, `×` (hidden when only one) calls `closeChatSession` (refused for the last), double-click renames. Workspace-level lifecycle (finishSetup/restoreSessions/archive/delete) loops over `ws.sessions`; the sidebar busy dot lights when **any** session is busy.

- Output events (`stream_event` text deltas, `assistant` messages, `user` tool results, `result`) become a structured transcript (`ChatItem[]`, capped at 500) that `ChatView.tsx` renders with its own input box. Busy = between sending a user message and the `result` event (emitted on the same `claude:busy` channel the old marker hack used).
- `--permission-prompt-tool stdio` makes the CLI send `control_request`/`can_use_tool` for tool permissions **and** the AskUserQuestion tool — even under `--dangerously-skip-permissions` (questions still come through). These become `ChatPending` entries: AskUserQuestion options render as buttons in the input area (the text field doubles as the free-form "свій варіант"; answers go back as `updatedInput.answers` keyed by question text), permissions render as Дозволити/Відхилити (deny message = typed text).
- The renderer mirror (`chatStore.ts`) syncs via a snapshot (`chat:attach`) + sequenced `chat:event` increments; a seq gap triggers a re-attach, events racing an attach are buffered.
- The init event's `session_id` is persisted on the session (`ChatSession.claudeSessionId`, via the `onChatSessionId` sink → `updateSessionSessionId`) and used as `--resume` after app restarts/lazy restarts (a resume that dies before init falls back to a fresh session once, with a visible info notice).
- The visible transcript is persisted too: debounced saves to `userData/chats/<sessionId>.json` (flushed on turn end/exit/kill), reloaded on first touch. Archive keeps the file (restore shows the old history and resumes the conversation); only permanent workspace/project deletion (or closing a session) removes it via `deleteChatHistory`.
- Slash commands: at spawn the chat sends an `initialize` control request; the response provides the command list **with descriptions/argument hints** (plus the available `models`), which feeds the autocomplete immediately (the bare `slash_commands` from the init event is only a fallback). The menu shows the CLI's own commands **plus a small registry of app-owned local commands** merged in by `setCommands` (a CLI command of the same name always shadows a local one). Every typed `/command` the CLI owns goes to it as a plain user message; output that arrives only in the `result` event (`/usage`, `/context`) is rendered as the assistant reply via the `turnHadText` fallback, and a TUI-only command the CLI rejects (`"… isn't available in this environment."`, matched by `UNAVAILABLE_RE`) is shown as a plain "недоступна" notice rather than echoed as a reply.
- **Local commands** (`LOCAL_COMMANDS` in `claudeChat.ts`) fill the gap left by the headless CLI not registering interactive TUI commands. `/model`, `/effort` and `/plan` ship today: each declares `choices(e)` (empty ⇒ the command is hidden — `/model` needs the `models` list, `/effort` needs a model that `supportsEffort`, `/plan` is always offered) and an `apply` that persists the choice (`claudeModel`/`claudeEffort`/`claudePermissionMode` on the `ChatSession`, via the `onChatParams` sink → `updateSessionClaudeParams`) and reapplies it as a CLI flag on the next spawn (`--model`/`--effort`/`--permission-mode`, appended after `claudeArgs` so a runtime choice wins). A typed `/model sonnet` applies inline; a bare `/model` opens an option picker that reuses the AskUserQuestion UI (a queue entry with a `local` handler — `answerChat` routes it in-app instead of to the CLI).
  - **Two apply styles.** `/model` and `/effort` only take effect at process start, so their `apply` **restarts the session resuming the conversation** (`restartSession`) and is flagged `requiresIdle` — refused mid-turn (while busy). `/plan` switches the permission mode **live** with a `set_permission_mode` control request (no restart, so it is allowed mid-turn). Adding another local command = pushing one `{name, description, argumentHint, choices, apply, applyArg?, requiresIdle?}` entry.
  - **/plan UX.** A bare `/plan` opens a two-option picker whose "off" option is context-aware (`✅ Звичайний режим` in default, `✅ Вимкнути режим планування` while planning); picking a mode `apply`s it, and picking the one already in effect is a no-op (`applyPermissionMode` early-returns when the mode is unchanged, so re-answering can't spam the transcript). The inline form (`/plan plan`, `/plan default`) goes through `applyArg`, which **toggles**: re-issuing the command matching the current mode flips to the other, so entering the same command twice flips back. (`applyParam` for /model and /effort has the same no-op-when-unchanged guard to avoid needless restarts.)
  - **Persistence across restart/restore.** The mode (`claudePermissionMode`) is persisted like model/effort and passed back as `--permission-mode` on every (re)spawn (restoreSessions on app launch, finishSetup after archive→restore). Because a `--resume` doesn't reliably honor that flag, `enforcePermissionMode` *also* re-asserts it with a `set_permission_mode` control request right after the initialize handshake — so the resumed session always lands in the persisted mode and our picker's "current" marker never lies.
  - **ExitPlanMode auto-sync.** Approving the `ExitPlanMode` permission (Claude's "here's the plan") exits plan mode on the CLI side, so `answerChat` mirrors that: when that specific tool is allowed and our tracked mode is still `plan`, it `setPermissionMode(…, 'default')` — keeping the picker's "current" marker and the persisted respawn flag honest so the session doesn't silently re-enter plan after a restart. The raw `tool_name` (not the display name) is kept on the queue entry (`rawToolName`) to detect it.
- `detectCommandDrift` persists the presented command names in the chat file and, on the next `initialize`, reports commands added/removed by a CLI upgrade — so the command set never changes silently. An init event whose `session_id` differs from the current one means the CLI reset the conversation (`/clear`) — the transcript is dropped to match. The autocomplete menu (in `ChatView`) sorts commands alphabetically like the TUI.

### The two-layer terminal model (task/shell tabs)

Real terminals exist as a buffer in main **and** a live xterm instance in renderer, both keyed by `${workspaceId}:${kind}` where `kind` is `task | shell`:

- `src/main/ptyManager.ts` — spawns `node-pty` procs, accumulates output into a per-key ring buffer (capped at `MAX_BUFFER`), and only forwards live data to the renderer when a terminal is `streaming` (flipped on `attach`). `attach()` returns the buffer snapshot atomically, then streaming begins — this is how scrollback survives even when no UI is mounted.
- `src/renderer/src/termRegistry.ts` — keeps one long-lived `xterm` instance per key so scrollback survives tab/workspace switches; the wrapper DOM element is *moved* into the visible host on activation rather than recreated. Only `TerminalView.tsx` mounts/fits it.

`shell` is a free interactive shell (started lazily on first Terminal-tab open); `task` is read-only — it aggregates setup/run/archive script output (the "Скрипти" tab) and is `disableStdin` in xterm so the user can't Ctrl+C the running app.

**Process-group kill** (`killProc` in ptyManager): procs are killed via `process.kill(-pid, ...)` (negative pid = whole group) because node-pty's own `.kill()` only signals the shell, leaving a dev server (and its bound port) alive. This is why Run/Stop and archive actually free ports.

### Workspace lifecycle

`src/main/workspaces.ts` orchestrates everything; `src/main/git.ts` is the only place that shells out to `git`. Status state machine (`WorkspaceStatus`): `setting_up → active → archiving → archived`.

- **Create**: `createWorkspace(projectId, name, baseBranch?)` adds the worktree+branch synchronously under the workspace's **project** (see Projects below) and returns immediately with `setting_up`; `finishSetup` then runs the project's setup script and starts `claude` **in the background** so the UI never blocks. IPC handlers in `ipc.ts` follow this pattern (`void finishSetup(...)`, `notifyWorkspacesChanged()`).
- **Archive**: `beginArchive` (stops run, flips to `archiving`) then background `finishArchive` (archive script → kill PTYs → `git worktree remove --force`). The git **branch is kept** so the workspace can be restored.
- **Restore/Delete**: `restoreWorktree` re-adds the worktree on the existing branch (prunes stale refs first); `deleteArchivedWorkspace` removes worktree + deletes the branch permanently.
- **Self-healing on launch** (`restoreSessions`): a workspace left in a transient state by an interrupted run (`archiving`/`setting_up`) is reconciled to `active` or `archived` based on whether its worktree dir still exists, then the Claude chat session is restarted for every live workspace (processes are memory-only and die on quit; the conversation itself resumes via the persisted `claudeSessionId`).

### Projects

A **project** (`Project` in `src/shared/types.ts`) is a registered git repository that workspaces are worktrees of. Each project carries its own `repoPath` and the three scripts (`setupScript`/`runScript`/`archiveScript`), so different repos can have different setup/run/archive behaviour. The sidebar lists projects as groups; each has a `+` (new workspace in that project) and `⚙` (per-project settings, incl. delete). `createProject(repoPath, name?)` validates the path is a git repo; `deleteProject` tears down every workspace under it (kill PTYs → remove worktrees → delete branches) then drops the project. Workspaces carry a `projectId`; every main-side operation resolves the workspace's project via `getProject(ws.projectId)` to find the repo path and scripts.

### State & settings persistence

`src/main/store.ts` is an in-memory object persisted to `app.getPath('userData')/conductor-data.json` on every mutation. It holds the **global** `Settings` (worktrees dir, startPort, IDE command, claude args), the `Project[]`, and the `Workspace[]`. Per-repo concerns (repo path + the three scripts) live on `Project`, **not** `Settings`. `initStore()` runs one-shot **migrations**: a legacy data file whose global settings still hold `repoPath`/scripts (and whose workspaces lack `projectId`) is folded into a single synthesized project with every orphan workspace stamped with its id; and a workspace with no `sessions` array has its Claude state (`claudeSessionId`/model/effort/permission-mode) folded into one `ChatSession` whose id reuses the workspace id (so `chats/<wsId>.json` keeps working). Session CRUD lives here too (`findSession`, `addSession`, `removeSession`, `renameSession`, `updateSessionSessionId`, `updateSessionClaudeParams`). `nextPort()` hands out the lowest free port from `startPort` (unique across all projects), exposed to scripts as `CONDUCTOR_PORT`.

### Scripts environment

`src/main/env.ts` `buildEnv(ws, project)` builds the env for every spawned shell/script. It injects the conductor-compatible `CONDUCTOR_*` vars (`CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH` = the project's repo path, `CONDUCTOR_WORKSPACE_NAME`, `CONDUCTOR_PORT`) and **deletes AppImage-runtime leak vars** (`ARGV0`, `APPIMAGE`, `APPDIR`, `OWD`). The `ARGV0` deletion is load-bearing: uutils-coreutils multicall binaries read it and abort `mkdir`/`tail`/etc. with "Security violation". `scripts/` holds example `setup.sh`/`run.sh`/`archive.sh` — the app hardcodes no project specifics; each project's scripts do per-workspace work (DB, deps) via the `CONDUCTOR_*` vars.

## Linux-specific gotchas (don't regress these)

- **AppImage runs with `--no-sandbox`** (no access to Chromium's SUID sandbox) — see `scripts/install-desktop.sh`. The env-var stripping above is the companion fix.
- **No native `confirm()`**: native dialogs on Linux left the window unfocused and froze the next modal. Confirmation is an in-app modal driven by `askConfirm`/`resolveConfirm` in the renderer store (`ConfirmModal.tsx`).
- **`fetchQuiet` in git.ts** has a hard 8.5s deadline + SIGKILL so a hung remote/credential prompt can't make the New-workspace branch loader hang forever.
