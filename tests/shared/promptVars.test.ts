import { describe, expect, it } from 'vitest'
import type { Project, Workspace } from '../../src/shared/types'
import { PROMPT_VARS, promptVarValues, substitutePromptVars } from '../../src/shared/promptVars'

const ws: Workspace = {
  id: 'w1',
  projectId: 'p1',
  name: 'feature-x',
  branch: 'feature-x',
  baseBranch: 'main',
  path: '/wt/proj/feature-x',
  port: 3005,
  createdAt: 0,
  status: 'active',
  sessions: [{ id: 'w1', createdAt: 0 }]
}

const project: Project = {
  id: 'p1',
  name: 'proj',
  repoPath: '/repo',
  setupScript: '',
  runScript: '',
  archiveScript: '',
  createdAt: 0
}

describe('promptVarValues', () => {
  it('resolves every advertised variable from the workspace/project', () => {
    const v = promptVarValues(ws, project)
    // Every entry the autocomplete offers must resolve to a value.
    for (const def of PROMPT_VARS) expect(def.name in v).toBe(true)
    expect(v).toEqual({
      CONDUCTOR_PORT: '3005',
      CONDUCTOR_HOST: 'localhost',
      CONDUCTOR_WORKSPACE_NAME: 'feature-x',
      CONDUCTOR_BRANCH: 'feature-x',
      CONDUCTOR_BASE_BRANCH: 'main'
    })
  })

  it('uses the project browserHost for the host, trimmed', () => {
    expect(promptVarValues(ws, { ...project, browserHost: '  myapp.local ' }).CONDUCTOR_HOST).toBe(
      'myapp.local'
    )
  })

  it('falls back to empty strings (host localhost) without context', () => {
    expect(promptVarValues(undefined, undefined)).toEqual({
      CONDUCTOR_PORT: '',
      CONDUCTOR_HOST: 'localhost',
      CONDUCTOR_WORKSPACE_NAME: '',
      CONDUCTOR_BRANCH: '',
      CONDUCTOR_BASE_BRANCH: ''
    })
  })

  it('reports an empty base branch when the workspace has none', () => {
    expect(promptVarValues({ ...ws, baseBranch: undefined }, project).CONDUCTOR_BASE_BRANCH).toBe('')
  })
})

describe('substitutePromptVars', () => {
  const values = promptVarValues(ws, project)

  it('replaces known tokens with their values', () => {
    expect(substitutePromptVars('run on :$CONDUCTOR_PORT for $CONDUCTOR_BRANCH', values)).toBe(
      'run on :3005 for feature-x'
    )
  })

  it('leaves unknown tokens and lone $ untouched', () => {
    expect(substitutePromptVars('cost $5 and $UNKNOWN_VAR', values)).toBe('cost $5 and $UNKNOWN_VAR')
  })

  it('replaces repeated occurrences', () => {
    expect(substitutePromptVars('$CONDUCTOR_HOST/$CONDUCTOR_HOST', values)).toBe(
      'localhost/localhost'
    )
  })
})
