import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addWorktree, diffStat, info, removeWorktree } from './git'

/**
 * These drive a real git against real repositories under the system temp
 * directory. A stub would only prove that this file agrees with itself: the
 * questions worth asking — what `--git-common-dir` reports from inside a linked
 * worktree, whether git will delete a main checkout — are questions about git.
 *
 * Every repo is made in `beforeEach` and removed in `afterEach`, whether the
 * expectation held or not.
 */

function gitInstalled(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** No git on the machine is not a failing test suite — there is nothing to ask. */
const describeGit = gitInstalled() ? describe : describe.skip

let base = ''
let root = ''

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** Where the app puts a worktree: beside the repo, never inside it. */
function worktreeFor(branch: string): string {
  return join(base, '.harness-deck', 'repo', ...branch.split('/'))
}

beforeEach(() => {
  // Resolved, because macOS hands out a /var symlink for the temp directory and
  // git reports the /private path back — comparing the two would fail for a
  // reason that has nothing to do with the code under test.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hd-git-')))
  root = join(base, 'repo')
  mkdirSync(root)

  git(['init'], root)
  // `init -b` is newer than the oldest git worth supporting, and the default
  // branch name is a user setting — so name it outright.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], root)
  git(['config', 'user.email', 'test@harness.deck'], root)
  git(['config', 'user.name', 'Harness Deck Test'], root)
  // A developer machine with commit signing on would otherwise ask for a key.
  git(['config', 'commit.gpgsign', 'false'], root)

  writeFileSync(join(root, 'shared.txt'), 'base\n')
  git(['add', '-A'], root)
  git(['commit', '-m', 'init'], root)
})

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

describeGit('info', () => {
  it('says nothing about a folder that is not a repo', async () => {
    expect(await info(base)).toBeNull()
  })

  it('says nothing about a folder that is not there', async () => {
    expect(await info(join(base, 'never-existed'))).toBeNull()
  })

  it('reports the root, the branch and a clean tree', async () => {
    expect(await info(root)).toEqual({ root, branch: 'main', dirty: 0 })
  })

  it('counts what is uncommitted, tracked or not', async () => {
    writeFileSync(join(root, 'shared.txt'), 'edited\n')
    writeFileSync(join(root, 'new.txt'), 'untracked\n')

    expect((await info(root))?.dirty).toBe(2)
  })

  it('answers for a subdirectory with the repo above it', async () => {
    const sub = join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })

    expect((await info(sub))?.root).toBe(root)
  })

  it('does not mistake a main working tree for a linked one', async () => {
    expect((await info(root))?.worktreeOf).toBeUndefined()
  })
})

describeGit('addWorktree', () => {
  it('checks the repo out beside itself, on a branch of its own', async () => {
    const path = worktreeFor('hd/claude-code')
    const result = await addWorktree({ repo: root, branch: 'hd/claude-code', path })

    expect(result).toEqual({ ok: true, path })
    expect(readFileSync(join(path, 'shared.txt'), 'utf8')).toBe('base\n')
    expect(await info(path)).toEqual({
      root: path,
      branch: 'hd/claude-code',
      dirty: 0,
      worktreeOf: root
    })
  })

  /** HD-2 exists for this one: two agents, one task, two directories. */
  it('gives two panes trees that cannot see each other', async () => {
    const a = await addWorktree({
      repo: root,
      branch: 'hd/agent-a',
      path: worktreeFor('hd/agent-a')
    })
    const b = await addWorktree({
      repo: root,
      branch: 'hd/agent-b',
      path: worktreeFor('hd/agent-b')
    })
    expect(a.path).toBeTruthy()
    expect(b.path).toBeTruthy()
    expect(a.path).not.toBe(b.path)

    writeFileSync(join(a.path!, 'shared.txt'), 'agent a\n')
    writeFileSync(join(b.path!, 'shared.txt'), 'agent b\n')

    expect(readFileSync(join(a.path!, 'shared.txt'), 'utf8')).toBe('agent a\n')
    expect(readFileSync(join(b.path!, 'shared.txt'), 'utf8')).toBe('agent b\n')
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('base\n')
  })

  it('numbers a second request for a name that is already taken', async () => {
    const path = worktreeFor('hd/claude-code')
    const first = await addWorktree({ repo: root, branch: 'hd/claude-code', path })
    const second = await addWorktree({ repo: root, branch: 'hd/claude-code', path })

    expect(first.path).toBe(path)
    expect(second.ok).toBe(true)
    expect(second.path).toBe(`${path}-2`)
    expect((await info(second.path!))?.branch).toBe('hd/claude-code-2')
  })

  it('reports a repo that is not a folder rather than throwing', async () => {
    const result = await addWorktree({
      repo: join(base, 'nowhere'),
      branch: 'hd/x',
      path: worktreeFor('hd/x')
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not a folder')
  })

  it('reports a git refusal in-band', async () => {
    const result = await addWorktree({ repo: base, branch: 'hd/x', path: worktreeFor('hd/x') })

    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

describeGit('removeWorktree', () => {
  it('refuses the main working tree, and leaves it where it is', async () => {
    const result = await removeWorktree(root)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('main working tree')
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('base\n')
  })

  it('refuses the main working tree even asked from inside a subdirectory', async () => {
    const sub = join(root, 'src')
    mkdirSync(sub)

    expect((await removeWorktree(sub)).ok).toBe(false)
    expect(existsSync(join(root, 'shared.txt'))).toBe(true)
  })

  it('removes a linked worktree, uncommitted work and all', async () => {
    const path = worktreeFor('hd/claude-code')
    await addWorktree({ repo: root, branch: 'hd/claude-code', path })
    writeFileSync(join(path, 'shared.txt'), 'half a thought\n')

    const result = await removeWorktree(path)

    expect(result).toEqual({ ok: true, path })
    expect(existsSync(path)).toBe(false)
    // The branch survives: the work on it is the whole point of the pane.
    expect((await info(root))?.dirty).toBe(0)
    expect(existsSync(join(root, 'shared.txt'))).toBe(true)
  })

  it('reports a folder that was never a worktree', async () => {
    const result = await removeWorktree(base)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not a git worktree')
    expect(existsSync(base)).toBe(true)
  })
})

describeGit('diffStat', () => {
  it('is empty for a clean tree', async () => {
    expect(await diffStat(root)).toBe('')
  })

  it('names the file that changed', async () => {
    writeFileSync(join(root, 'shared.txt'), 'edited\n')

    expect(await diffStat(root)).toContain('shared.txt')
  })

  it('is empty for a folder git knows nothing about', async () => {
    expect(await diffStat(base)).toBe('')
    expect(await diffStat(join(base, 'never-existed'))).toBe('')
  })
})
