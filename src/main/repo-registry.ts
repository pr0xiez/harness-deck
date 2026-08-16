import { resolve } from 'node:path'
import type { PersistedState } from '@shared/types'
import { WORKTREE_DIR } from '@shared/worktree'

/**
 * Which directories git may be asked about. The renderer names folders in every
 * git call, and nothing stops a compromised one from naming folders the user
 * never opened — so the main process keeps its own list, fed only by things the
 * main process itself decided, never by a bare renderer-supplied path. That
 * means: state hydrated at startup, a directory the OS picker returned, a root
 * git itself resolved from an already-open directory, and a worktree
 * `git:addWorktree` created. Notably NOT a source: `pty:ensure`'s
 * `PaneSpec.cwd` — a pane may spawn wherever the renderer asks, but that alone
 * never widens this registry, or the renderer could grant itself git access to
 * any folder on disk by spawning a pane in it. See issues #48/#49.
 *
 * Membership is exact. An open repo does not open its parents or its
 * subdirectories — git itself walks up from whatever folder it is handed, so
 * the handlers that need "the repo above this pane" get it by asking git about
 * the pane's own folder, not by loosening the match here.
 */

const open = new Set<string>()

/** Mirrors samePath in git.ts: one slash flavour, no trailing separator, and on
 * Windows one case — `C:\x\y` and `C:/x/y` are the same directory there. */
function normalize(dir: string): string {
  const flat = resolve(dir)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
  return process.platform === 'win32' ? flat.toLowerCase() : flat
}

export function openDir(dir: string | undefined | null): void {
  // Not merely tidiness: resolve('') is the process cwd, which nobody opened.
  if (typeof dir !== 'string' || !dir) return
  open.add(normalize(dir))
}

export function isOpenDir(dir: string): boolean {
  if (typeof dir !== 'string' || !dir) return false
  return open.has(normalize(dir))
}

/**
 * Whether a path follows the app's own worktree convention — some segment is
 * exactly `.harness-deck` (see worktreePath in shared/worktree.ts). A worktree
 * the app created always does, wherever the repo lives.
 */
export function isAppWorktree(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  return normalize(path).split('/').includes(WORKTREE_DIR)
}

/**
 * The startup grant: every folder the saved layout points a workspace or pane
 * at is one the user put there. A pane's worktree only counts when it follows
 * the convention — loadState scrubs those anyway, and this does not rely on it.
 */
export function seedRegistry(state: PersistedState | null): void {
  for (const workspace of state?.workspaces ?? []) {
    openDir(workspace.cwd)
    for (const pane of workspace.panes ?? []) {
      openDir(pane.cwd)
      if (pane.worktree && isAppWorktree(pane.worktree)) openDir(pane.worktree)
    }
  }
}

export function resetRegistry(): void {
  open.clear()
}
