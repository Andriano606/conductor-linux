import type { Settings, Workspace } from '../shared/types'

/**
 * Build the environment for scripts and the Claude session, exposing the same
 * CONDUCTOR_* variables that conductor.build provides.
 */
export function buildEnv(ws: Workspace, settings: Settings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_ROOT_PATH: settings.repoPath,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_PORT: String(ws.port)
  }
  // The AppImage runtime injects these into our process environment. They leak
  // into spawned shells/scripts and break things — notably ARGV0, which multicall
  // binaries (uutils coreutils) read to pick the applet, so mkdir/tail/dircolors
  // see "Conductor Linux-0.1.0" and abort with a "Security violation".
  delete env.ARGV0
  delete env.APPIMAGE
  delete env.APPDIR
  delete env.OWD
  return env
}
