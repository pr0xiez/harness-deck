import { beforeEach, describe, expect, it } from 'vitest'
import type { PersistedState } from '@shared/types'
import { isAppWorktree, isOpenDir, openDir, resetRegistry, seedRegistry } from './repo-registry'

/**
 * The registry is what stands between a renderer-supplied path and a git
 * process, so the questions worth asking are all about paths trying to pass
 * for one another: a trailing slash, a folder inside an open one, an empty
 * string that would resolve to the process cwd. See issues #48/#49.
 */

beforeEach(() => {
  resetRegistry()
})

describe('openDir and isOpenDir', () => {
  it('answers for a directory it was told about, and no other', () => {
    openDir('/home/dev/project')

    expect(isOpenDir('/home/dev/project')).toBe(true)
    expect(isOpenDir('/home/dev/elsewhere')).toBe(false)
  })

  it('does not let a trailing separator or a doubled slash make a second directory', () => {
    openDir('/home/dev/project/')
    openDir('/home/dev//other')

    expect(isOpenDir('/home/dev/project')).toBe(true)
    expect(isOpenDir('/home/dev/project/')).toBe(true)
    expect(isOpenDir('/home/dev/other')).toBe(true)
  })

  /** Exact-only on purpose: opening a repo is not opening the disk around it. */
  it('refuses a folder inside an open one, and the folder above it', () => {
    openDir('/home/dev/project')

    expect(isOpenDir('/home/dev/project/src')).toBe(false)
    expect(isOpenDir('/home/dev')).toBe(false)
  })

  it('opens nothing at all when handed nothing', () => {
    openDir('')
    openDir(undefined)
    openDir(null)

    // resolve('') is the process cwd, which is exactly what must not happen.
    expect(isOpenDir(process.cwd())).toBe(false)
    expect(isOpenDir('')).toBe(false)
  })

  /**
   * The scenario the review flagged on #49: `pty:ensure` receives a
   * renderer-controlled `PaneSpec.cwd` and spawns a process there, but must
   * not treat that as the app "opening" the folder — the fix in
   * `src/main/index.ts` is that its handler never calls `openDir` on
   * `spec.cwd` at all. This pins the module-level half of that guarantee:
   * merely being a directory something would spawn in — as opposed to one
   * `openDir` was actually called with — is not enough to grant it, no matter
   * what else is legitimately open at the same time.
   */
  it('a directory that only ever appears as a pane cwd stays refused, even once other directories are legitimately open', () => {
    openDir('/home/dev/my-open-repo')

    // Stands in for `pty:ensure({ cwd: '/home/dev/other-client-repo' })`: a
    // pane may spawn there, but nothing here was ever told to open it.
    expect(isOpenDir('/home/dev/other-client-repo')).toBe(false)
  })
})

describe('isAppWorktree', () => {
  it('recognises a path with a .harness-deck segment in it', () => {
    expect(isAppWorktree('/src/.harness-deck/app/hd/review')).toBe(true)
    expect(isAppWorktree('C:/Users/dev/.harness-deck/deck/hd/x')).toBe(true)
  })

  it('rejects everything else, including a folder merely named after the app', () => {
    expect(isAppWorktree('/src/app')).toBe(false)
    expect(isAppWorktree('/home/dev/harness-deck')).toBe(false)
    expect(isAppWorktree('')).toBe(false)
  })
})

describe('seedRegistry', () => {
  const state = {
    version: 1,
    workspaces: [
      {
        id: 'w1',
        cwd: '/src/deck',
        panes: [
          { id: 'p1', cwd: '/src/deck/api', worktree: '/src/.harness-deck/deck/hd/api' },
          { id: 'p2', cwd: '/src/deck', worktree: '/home/dev/other-project' }
        ]
      }
    ],
    activeWorkspaceId: 'w1'
  } as unknown as PersistedState

  it('opens the folders the saved layout points workspaces and panes at', () => {
    seedRegistry(state)

    expect(isOpenDir('/src/deck')).toBe(true)
    expect(isOpenDir('/src/deck/api')).toBe(true)
  })

  it('opens a pane worktree only when it follows the convention', () => {
    seedRegistry(state)

    expect(isOpenDir('/src/.harness-deck/deck/hd/api')).toBe(true)
    // loadState scrubs these, but a first run seeds from whatever is on disk —
    // the seed does not get to be the one path around the check.
    expect(isOpenDir('/home/dev/other-project')).toBe(false)
  })

  it('has nothing to do on a first run, when there is no state', () => {
    seedRegistry(null)

    expect(isOpenDir(process.cwd())).toBe(false)
  })
})
