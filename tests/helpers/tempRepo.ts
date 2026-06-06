import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** A throwaway git repo for exercising the real git wrappers in git.ts. */
export class TempRepo {
  readonly dir: string

  private constructor(dir: string) {
    this.dir = dir
  }

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8' })
  }

  /** Create an initialized repo with one commit on the default branch. */
  static create(): TempRepo {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-git-'))
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'])
    // Avoid the user's global commit-signing/hooks leaking into the test repo.
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
    const repo = new TempRepo(dir)
    repo.commit('README.md', '# test\n', 'initial commit')
    return repo
  }

  /** Write a file and commit it. */
  commit(file: string, content: string, message: string): void {
    writeFileSync(join(this.dir, file), content)
    this.git('add', file)
    this.git('commit', '-q', '-m', message)
  }

  /** Create a branch (without switching to it). */
  branch(name: string): void {
    this.git('branch', name)
  }

  /** Plain absolute path to a sibling location (for new worktrees). */
  siblingPath(name: string): string {
    return join(this.dir, '..', name)
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/** A directory that is NOT a git repo. */
export function tempPlainDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-plain-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
