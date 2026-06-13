import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startBranchWatch, stopAllBranchWatches, stopBranchWatch } from '../../src/main/branchWatcher'

let dir: string
const headPath = (): string => join(dir, 'HEAD')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-head-'))
  writeFileSync(headPath(), 'ref: refs/heads/main\n')
})

afterEach(() => {
  stopAllBranchWatches()
  rmSync(dir, { recursive: true, force: true })
})

/** Poll until `cond` is true or the deadline passes (fs.watch is async). */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20))
}

describe('branchWatcher', () => {
  it('fires onChange (debounced) when HEAD is rewritten', async () => {
    const onChange = vi.fn()
    startBranchWatch('w1', dir, onChange)
    writeFileSync(headPath(), 'ref: refs/heads/feature\n')
    await waitFor(() => onChange.mock.calls.length > 0)
    expect(onChange).toHaveBeenCalled()
  })

  it('ignores writes to sibling files (only HEAD matters)', async () => {
    const onChange = vi.fn()
    startBranchWatch('w2', dir, onChange)
    writeFileSync(join(dir, 'ORIG_HEAD'), 'deadbeef\n')
    await new Promise((r) => setTimeout(r, 400))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stops firing after stopBranchWatch', async () => {
    const onChange = vi.fn()
    startBranchWatch('w3', dir, onChange)
    stopBranchWatch('w3')
    writeFileSync(headPath(), 'ref: refs/heads/other\n')
    await new Promise((r) => setTimeout(r, 400))
    expect(onChange).not.toHaveBeenCalled()
  })
})
