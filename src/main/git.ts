import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type {
  DiffRequest,
  DiffResult,
  RepoInfo,
  WorktreeRequest,
  WorktreeResult
} from '@shared/types'
import { runProcess } from './process'
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
/** Patch lines a compare column gets when it does not ask for a number itself. */
const DIFF_LINES = 800
/** And the most it may ask for, however enthusiastic the caller. */
const MAX_DIFF_LINES = 4000
/**
 * Longest patch line kept. A minified bundle is one line several megabytes wide
 * and nobody reads it; the renderer should not have to lay it out to find that out.
 */
const MAX_LINE = 500
/** New files given a diff of their own before the rest are only counted. */
const MAX_UNTRACKED = 25
/**
 * Files a summary names before it folds. "Run the formatter over everything" is
 * a real prompt and it changes every file in the repo; the summary is not where
 * anyone reads that, and the renderer should not lay out a line per file to
 * find it out.
 */
const STAT_LINES = 200
/** git's `diff --no-index` spells the empty side this way on every platform. */
const NULL_PATH = '/dev/null'

interface Ran {
  ok: boolean
  stdout: string
  /** What a failed call had to say for itself, first line, without `fatal:`. */
  error: string
}

async function run(args: string[], cwd: string, timeout = TIMEOUT): Promise<Ran> {
  const git = await runProcess('git', args, {
    cwd,
    env: shellEnv(),
    timeout,
    maxBuffer: 8 * 1024 * 1024
  })
  return {
    ok: git.ok,
    stdout: git.stdout,
    // git's own words where it said any; Node's (ENOENT, the timeout) otherwise.
    error: git.error ? firstLine(git.stderr) || git.error.message : ''
  }
}

interface Capped {
  /** The first `keep` lines of output, joined. */
  text: string
  /** Lines the command produced in total, kept or not. */
  lines: number
  truncated: boolean
}

/**
 * A diff is the one git output with no natural size, and the cap belongs at
 * this end of it: reading it through `execFile` would mean holding all of a
 * 5,000-line patch in the main process and then handing all of it to a renderer
 * that is going to draw the first screenful. So this reads the stream, keeps
 * the lines it was asked for, and counts the rest — the count is what lets the
 * view say how much it is not showing.
 */
function runCapped(args: string[], cwd: string, keep: number): Promise<Capped> {
  return new Promise((done) => {
    const kept: string[] = []
    let lines = 0
    let carry = ''
    let settled = false

    const take = (line: string): void => {
      lines += 1
      if (kept.length < keep) kept.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      if (carry) take(carry)
      done({ text: kept.join('\n'), lines, truncated: lines > kept.length })
    }

    // `--no-index` reports a difference as exit status 1, and a diff that ran
    // out of time has still told us something — so nothing here reads the exit
    // status. Whatever arrived is the answer.
    const child = spawn('git', args, { cwd, env: shellEnv(), timeout: TIMEOUT, windowsHide: true })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const parts = (carry + chunk).split('\n')
      carry = parts.pop() ?? ''
      parts.forEach(take)
    })
    child.on('error', finish)
    child.on('close', finish)
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
  const root = resolve(top.stdout.trim())
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

/**
 * Where this pane's branch left the one it was cut from. `diffStat` above asks
 * "what is uncommitted here", which for an agent that finished and committed is
 * nothing at all — and a column reading "no changes" over a completed task is
 * the one answer the compare view must never give.
 */
async function branchPoint(repo: RepoInfo): Promise<{ base: string; ref: string }> {
  // Not a linked worktree, so there is no fork to measure from. HEAD is the
  // honest answer, and the column then reads as "what is sitting in this folder".
  if (!repo.worktreeOf) return { base: 'HEAD', ref: 'HEAD' }

  const [head, branch] = await Promise.all([
    run(['rev-parse', 'HEAD'], repo.worktreeOf),
    run(['rev-parse', '--abbrev-ref', 'HEAD'], repo.worktreeOf)
  ])
  // By commit rather than by name: the main checkout may be detached, and the
  // merge base is the same either way. The name is only for the header.
  const trunk = head.stdout.trim()
  if (!trunk) return { base: 'HEAD', ref: 'HEAD' }

  const merged = await run(['merge-base', 'HEAD', trunk], repo.root)
  const base = merged.stdout.trim()
  if (!base) return { base: 'HEAD', ref: 'HEAD' }
  const name = branch.stdout.trim()
  return { base, ref: name && name !== 'HEAD' ? name : trunk.slice(0, 7) }
}

/**
 * Keeps a summary readable, and keeps git's own total — the one line nobody
 * would want dropped — even when the list above it is folded away.
 */
function foldStat(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= STAT_LINES) return text
  const dropped = lines.length - STAT_LINES + 1
  return [
    ...lines.slice(0, STAT_LINES - 2),
    ` … and ${dropped} more files`,
    lines[lines.length - 1]
  ].join('\n')
}

/** Lines up the `|` column across stat lines git produced one call at a time. */
function align(rows: string[]): string[] {
  const split = rows.map((row) => {
    const at = row.lastIndexOf(' | ')
    return at < 0 ? [row, ''] : [row.slice(0, at), row.slice(at + 3)]
  })
  const width = Math.max(...split.map(([name]) => name.length))
  return split.map(([name, rest]) => (rest ? `${name.padEnd(width)} | ${rest}` : name))
}

/**
 * git will not put an untracked file into a range diff at any price, and an
 * agent that wrote three new modules and did not commit them has changed
 * everything while `git diff` says nothing. So they are asked about one at a
 * time, against the null device, and get a block of their own — `--no-index`
 * means git still decides what is binary and how many lines it grew by.
 */
async function newFile(path: string, root: string, keep: number): Promise<Capped & { stat: string }> {
  const [stat, patch] = await Promise.all([
    run(['diff', '--no-index', '--stat', '--', NULL_PATH, path], root),
    runCapped(['diff', '--no-index', '--', NULL_PATH, path], root, keep)
  ])
  // ` /dev/null => src/new.ts | 42 +++` — the source side is what a block
  // captioned "new files" already says, so it comes off.
  const line = (stat.stdout.split('\n')[0] ?? '').replace(`${NULL_PATH} => `, '')
  return { ...patch, stat: line.trimEnd() }
}

/**
 * One compare column's worth of git. Everything answers rather than throws, and
 * a folder git knows nothing about comes back with an `error` rather than an
 * empty diff — the two look identical in a column otherwise.
 */
export async function diffRange(req: DiffRequest): Promise<DiffResult> {
  const dir = req?.dir ?? ''
  const blank: DiffResult = {
    dir,
    root: '',
    branch: '',
    base: '',
    baseRef: '',
    stat: '',
    patch: '',
    patchLines: 0,
    truncated: false,
    untracked: 0
  }

  const repo = await info(dir)
  if (!repo) return { ...blank, error: `${dir || 'That folder'} is not a git repository.` }

  const { base, ref } = await branchPoint(repo)
  const keep = Math.max(1, Math.min(req.limit || DIFF_LINES, MAX_DIFF_LINES))

  const [tracked, patch, others] = await Promise.all([
    run(['diff', '--stat', base], repo.root),
    runCapped(['diff', base], repo.root, keep),
    // `-z`, because without it git quotes any path with an accent in it and the
    // quoted form is not a path anything can be asked to diff.
    run(['ls-files', '--others', '--exclude-standard', '-z'], repo.root)
  ])

  const untracked = others.stdout.split('\0').filter(Boolean)
  // Each new file is capped on its own and the composition is cut again below,
  // so the worst case held here is a couple of dozen screenfuls, not a repo.
  const news = await Promise.all(
    untracked.slice(0, MAX_UNTRACKED).map((path) => newFile(path, repo.root, keep))
  )

  const shown = news.map((n) => n.stat).filter(Boolean)
  const rest = untracked.length - shown.length
  const block = shown.length
    ? [
        ...align(shown),
        ` ${shown.length} new file${shown.length === 1 ? '' : 's'}, not yet added to git${
          rest > 0 ? `, and ${rest} more` : ''
        }`
      ].join('\n')
    : ''

  const parts = [patch, ...news]
  const lines = parts
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n')
    .split('\n')

  return {
    ...blank,
    root: repo.root,
    branch: repo.branch,
    base,
    baseRef: ref,
    stat: [tracked.ok ? foldStat(tracked.stdout.trimEnd()) : '', block].filter(Boolean).join('\n\n'),
    patch: lines.slice(0, keep).join('\n'),
    patchLines: parts.reduce((total, part) => total + part.lines, 0),
    truncated: parts.some((part) => part.truncated) || lines.length > keep,
    untracked: untracked.length
  }
}
