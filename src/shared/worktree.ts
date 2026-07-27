/**
 * Where a pane's worktree goes, and what its branch is called. Shared because
 * the rule has to be one rule: the menu creates the worktree, and anything that
 * rebuilds a workspace later has to arrive at the same answer.
 */

/** Branches this app makes all live under one prefix, so they are easy to spot. */
export const BRANCH_PREFIX = 'hd'

/** Worktrees live under this, beside the repo rather than inside it. */
export const WORKTREE_DIR = '.harness-deck'

/** A branch name git will take, from whatever the pane happens to be called. */
export function worktreeBranch(paneName: string): string {
  const slug =
    paneName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pane'
  return `${BRANCH_PREFIX}/${slug}`
}

/**
 * `<repo>/../.harness-deck/<repo-name>/<branch>`. Outside the repo on purpose:
 * an agent that walks its own tree must not find a second copy of the project,
 * and nothing has to be added to .gitignore to keep it out of the way.
 *
 * Joined by hand rather than through node's `path` — the renderer decides this
 * and has no node — reading the separator off the root git reported.
 */
export function worktreePath(repoRoot: string, branch: string): string {
  const sep = repoRoot.includes('\\') ? '\\' : '/'
  const parts = repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/)
  const name = parts.pop() || 'repo'
  return [...parts, WORKTREE_DIR, name, ...branch.split('/')].join(sep)
}
