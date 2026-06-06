import type { Settings, Workspace } from '../shared/types'

/**
 * Build the environment for scripts and the Claude session, exposing the same
 * CONDUCTOR_* variables that conductor.build provides.
 */
export function buildEnv(ws: Workspace, settings: Settings): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_ROOT_PATH: settings.repoPath,
    CONDUCTOR_WORKSPACE_NAME: ws.name,
    CONDUCTOR_PORT: String(ws.port)
  }
}
