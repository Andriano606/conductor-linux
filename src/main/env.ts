import type { Project, Workspace } from '../shared/types'
import { promptVarValues } from '../shared/promptVars'

/**
 * Build the environment for scripts and the Claude session, exposing the same
 * CONDUCTOR_* variables that conductor.build provides. CONDUCTOR_ROOT_PATH comes
 * from the workspace's project (its repository). The dynamic per-workspace vars
 * (port, host, name, branch, base branch) come from the shared promptVarValues so
 * scripts and prompt substitution stay in sync.
 */
export function buildEnv(ws: Workspace, project: Project): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONDUCTOR_WORKSPACE_PATH: ws.path,
    CONDUCTOR_ROOT_PATH: project.repoPath,
    ...promptVarValues(ws, project)
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
