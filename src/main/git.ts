import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { RepoInfo, WorktreeRequest, WorktreeResult } from '@shared/types'
import { shellEnv } from './shell-env'

/**
 * Git, through the binary rather than a library. Four plumbing commands is the
 * whole of it, and a library would still have to agree with the git the user's
 * panes are already running — so this asks that git directly.
 *
 * Every entry point answers rather than throws: a folder that is not a repo is
 * the normal case, not an error, and the UI hangs off "is there a repo here?"
 */

/** Long enough for `status` on a large tree, short enough to notice a hung git. */
const TIMEOUT = 15_000
/** `worktree add` checks out a whole tree, which on a big repo is not instant. */
const ADD_TIMEOUT = 120_000
/** How many times a branch name may be numbered before we let git complain. */
const MAX_SLOTS = 20

interface Ran {
  ok: boolean
  stdout: string
  /** What a failed call had to say for itself, first line, without `fatal:`. */
  error: string
}

function run(args: string[], cwd: string, timeout = TIMEOUT): Promise<Ran> {
  return new Promise((done) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: shellEnv(), timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        done({
          ok: !err,
          stdout: stdout ?? '',
          error: err ? firstLine(stderr) || err.message : ''
        })
    )
    // No git on PATH at all, or a cwd that went away between the check and the
    // spawn — neither reaches the callback on every platform.
    child.on('error', (err) => done({ ok: false, stdout: '', error: err.message }))
  })
}

function firstLine(text: string): string {
  const line = (text || '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean)
  return (line ?? '').replace(/^fatal:\s*/i, '')
}

function isDir(path: string): boolean {
  try {
    return Boolean(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length
}

/** git speaks forward slashes even on Windows, where the case is not news either. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => {
    const flat = path.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? flat.toLowerCase() : flat
  }
  return norm(a) === norm(b)
}

/**
 * What git knows about a folder, or null when it knows nothing — a workspace
 * pointed at somewhere that is not a repo, or a machine with no git installed,
 * are the same answer as far as the UI is concerned.
 */
export async function info(dir: string): Promise<RepoInfo | null> {
  if (!isDir(dir)) return null

  const top = await run(['rev-parse', '--show-toplevel'], dir)
  const root = top.stdout.trim()
  if (!top.ok || !root) return null

  const [branch, status, common] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    run(['status', '--porcelain'], dir),
    run(['rev-parse', '--git-common-dir'], dir)
  ])

  // `--git-common-dir` is a bare `.git` in a main working tree and an absolute
  // path to that same directory from a linked one, so the folder above it is
  // the main checkout — the one thing removeWorktree may never touch. Resolve
  // it against git's own root rather than `dir`: on macOS a caller's path can
  // be the /tmp symlink of the /private/tmp git just reported.
  const mainRoot = dirname(resolve(root, common.stdout.trim() || '.git'))

  return {
    root,
    // Detached, and `--abbrev-ref` says so literally; the chip shows what git
    // would show rather than inventing a name for it.
    branch: branch.stdout.trim() || 'HEAD',
    dirty: countLines(status.stdout),
    ...(samePath(mainRoot, root) ? {} : { worktreeOf: mainRoot })
  }
}

/**
 * Two panes running the same harness ask for the same branch name, and the
 * second `worktree add` would simply fail. The caller cannot see the repo to
 * know that, so the numbering happens here and the result reports where the
 * worktree actually landed.
 */
async function freeSlot(req: WorktreeRequest): Promise<{ branch: string; path: string }> {
  for (let n = 1; n <= MAX_SLOTS; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const branch = `${req.branch}${suffix}`
    const path = `${req.path}${suffix}`
    if (existsSync(path)) continue
    // Exit status only — no message to read, and nothing to mistranslate.
    const ref = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], req.repo)
    if (!ref.ok) return { branch, path }
  }
  // Out of names. Let git say so rather than inventing a refusal of our own.
  return { branch: req.branch, path: req.path }
}

export async function addWorktree(req: WorktreeRequest): Promise<WorktreeResult> {
  if (!isDir(req.repo)) return { ok: false, error: `${req.repo} is not a folder.` }
  if (!req.branch || !req.path) return { ok: false, error: 'A worktree needs a branch and a path.' }

  const slot = await freeSlot(req)
  // `worktree add` creates the leading directories itself, and the path lives
  // outside the repo so nothing has to be added to .gitignore.
  const added = await run(['worktree', 'add', '-b', slot.branch, slot.path], req.repo, ADD_TIMEOUT)
  return added.ok ? { ok: true, path: slot.path } : { ok: false, error: added.error }
}

export async function removeWorktree(path: string): Promise<WorktreeResult> {
  const repo = await info(path)
  if (!repo) return { ok: false, error: `${path} is not a git worktree.` }
  // The refusal that matters. A main checkout is somebody's actual work, and
  // `--force` would take it out along with everything not yet committed. git
  // declines this too; the app does not rely on that to be the only guard.
  if (!repo.worktreeOf) return { ok: false, error: `${path} is the main working tree.` }

  // From the main repo, and using git's own idea of where the worktree is, so a
  // symlinked path the caller was handed still matches the one git recorded.
  const removed = await run(['worktree', 'remove', '--force', repo.root], repo.worktreeOf)
  return removed.ok ? { ok: true, path } : { ok: false, error: removed.error }
}

/**
 * What a pane has changed, as git summarises it. Empty is the honest answer for
 * a clean tree and for a folder git knows nothing about — HD-3 renders one
 * column per pane and an error string there would read as a diff.
 */
export async function diffStat(dir: string): Promise<string> {
  if (!isDir(dir)) return ''
  const diff = await run(['diff', '--stat'], dir)
  return diff.ok ? diff.stdout.trim() : ''
}
