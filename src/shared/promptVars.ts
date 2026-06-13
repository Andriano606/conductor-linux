// Variables a custom prompt (and every spawned script) can reference. They are
// the app's CONDUCTOR_* environment variables resolved for a workspace context:
// substituted into a prompt's text when it is inserted into the chat, and
// injected verbatim into script/Claude environments by buildEnv (src/main/env.ts).

import type { Project, Workspace } from './types'

export interface PromptVar {
  /** Token name without the leading $ (e.g. "CONDUCTOR_PORT"). */
  name: string
  /** One-line human description shown in the `$` autocomplete and the hint. */
  description: string
}

/** The variables offered in the prompt editor's `$` autocomplete. */
export const PROMPT_VARS: PromptVar[] = [
  { name: 'CONDUCTOR_PORT', description: 'Порт поточного воркспейса' },
  { name: 'CONDUCTOR_HOST', description: 'Хост для браузера (домен проекту або localhost)' },
  { name: 'CONDUCTOR_WORKSPACE_NAME', description: 'Назва воркспейса' },
  { name: 'CONDUCTOR_BRANCH', description: 'Поточна гілка воркспейса' },
  { name: 'CONDUCTOR_BASE_BRANCH', description: 'Оригінальна (базова) гілка' }
]

/**
 * Resolve the CONDUCTOR_* variable values for a workspace/project context. Used
 * both by buildEnv (the script/Claude env) and by the prompt-insert substitution,
 * so the two never drift. Missing context yields empty strings (host → localhost).
 */
export function promptVarValues(ws?: Workspace, project?: Project): Record<string, string> {
  return {
    CONDUCTOR_PORT: ws ? String(ws.port) : '',
    CONDUCTOR_HOST: project?.browserHost?.trim() || 'localhost',
    CONDUCTOR_WORKSPACE_NAME: ws?.name ?? '',
    CONDUCTOR_BRANCH: ws?.branch ?? '',
    CONDUCTOR_BASE_BRANCH: ws?.baseBranch ?? ''
  }
}

/**
 * Replace every $TOKEN occurrence with its value; unknown tokens are left
 * untouched so unrelated `$` text in a prompt survives intact.
 */
export function substitutePromptVars(text: string, values: Record<string, string>): string {
  return text.replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, name: string) =>
    name in values ? values[name] : m
  )
}
