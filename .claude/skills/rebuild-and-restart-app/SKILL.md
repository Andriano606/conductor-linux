---
name: rebuild-and-restart-app
description: Run AFTER finishing work on a feature in conductor-linux. Repackages the AppImage (npm run dist) and restarts the running app so the desktop icon launches the new build. Use whenever a feature/change is done and the user runs the app from the installed icon/AppImage, or asks to "restart the app/icon", "перезапусти білд", "онови іконку", "перебілди застосунок".
---

# Rebuild & restart the app (update the icon)

`npm run build` only refreshes `out/` — it does **not** repackage the AppImage.
The user launches Conductor from the desktop **icon**, which runs the packaged
`dist/Conductor Linux-*.AppImage`. So after finishing a feature you must
**repackage the AppImage and restart the running instance**, otherwise the icon
keeps launching the old code.

## When to run

After a feature/change is complete and verified (tests + `npm run build` green),
and the user runs the app from the icon — or whenever the user asks to restart
the app / update the icon / rebuild the packaged app.

Order: finish the work → [[verify-before-commit]] gates (tests + build) → this
skill (repackage + restart).

## Steps

### 1. Repackage the AppImage
```bash
npm run dist
```
This rebuilds `out/`, rebuilds `node-pty` for Electron, and writes a fresh
`dist/Conductor Linux-<version>.AppImage` (+ `.deb`). Wait for it to finish.

### 2. Restart the running instance

The app runs **outside** the Bash tool's sandbox, in the user's GUI session.
Two gotchas, both handled below:

- **`pkill -f '<AppImage name>'` kills this very script** — the running command
  line contains the same literal string, so pkill matches and kills itself
  (exit 144) before touching the app. **Never** `pkill -f` a pattern that also
  appears in your command. Collect pids with `pgrep` into a variable built from
  concatenated pieces, or kill by explicit pid.
- **The sandbox can't signal the GUI app.** A normal Bash call's `kill` returns
  0 but does nothing to the out-of-sandbox app. Run the kill/relaunch with
  **`dangerouslyDisableSandbox: true`**.

```bash
# Build the match pattern from pieces so this script's own argv can't match it.
pat=$(printf '%s' '.mount_' 'Conduc')

# Kill the running instance (main + helper procs) by pgrep-collected pids.
pids=$(pgrep -f "$pat" | tr '\n' ' ')
[ -n "$pids" ] && kill -9 $pids 2>/dev/null
sleep 2
# Re-kill any orphaned gpu/network helpers left over from the old mount.
left=$(pgrep -f "$pat" | tr '\n' ' ')
[ -n "$left" ] && kill -9 $left 2>/dev/null

# Relaunch the freshly packaged AppImage the way the desktop icon does,
# fully detached so it outlives this shell.
APPIMAGE="$(ls -t "$PWD"/dist/*.AppImage | head -1)"
chmod +x "$APPIMAGE"
setsid "$APPIMAGE" --no-sandbox >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
sleep 6
```
Run that block with `dangerouslyDisableSandbox: true`.

### 3. Verify the new instance is up
```bash
pgrep -af '.mount_'"Conduc" | head -3
```
Confirm a process with a **new** `/tmp/.mount_Conduc<XXXX>/` path is running
(different suffix from the old one). Kill any orphan helpers still pointing at
the **old** mount suffix.

## Notes

- The app self-heals on launch (`restoreSessions` restarts `claude` for every
  live workspace), so a hard restart is safe — in-flight PTYs are memory-only
  and get recreated.
- If the desktop entry/icon image itself changed (`build/icon.png` or the
  `.desktop` file), also run `scripts/install-desktop.sh` to reinstall it.
- Killing the user's running app is an outward, hard-to-reverse action — only do
  it when restarting was explicitly requested or is the clear intent of "rebuild
  and update the icon".
