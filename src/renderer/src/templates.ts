import type { Pane, PaneStatus, TemplatePane, Workspace, WorkspaceTemplate } from '@shared/types'
import { agentLaunch } from '@shared/agent-session'

/**
 * Everything a template is, as plain data transformation. It lives beside the
 * store rather than inside it because the store reaches for `window.harness` on
 * import, and the relative-cwd round trip is exactly the part worth testing
 * without a window in the room.
 */

/** The store's pane and workspace views, structurally — this file imports neither. */
type CopyablePane = Pane & { autostart?: boolean }
type CopyableWorkspace = Omit<Workspace, 'panes'> & { panes: CopyablePane[] }

/** Path pieces, separator-agnostic: the renderer sees Windows and unix paths alike. */
const segments = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean)

/**
 * Compared case-insensitively. A folder picked from the dialog and one typed by
 * hand disagree about case on both Windows and macOS, and treating them as
 * different folders would silently drop every pane's subfolder.
 */
const sameSegment = (a: string, b: string): boolean =>
  a === b || a.toLowerCase() === b.toLowerCase()

/**
 * A pane folder as a template stores it: relative to the workspace folder, and
 * empty for the folder itself. A pane pointed somewhere outside the workspace
 * has nothing that can travel to another repo, so it comes back to the root
 * rather than carrying an absolute path off the machine it was made on.
 */
export function relativeCwd(base: string, cwd: string): string {
  if (!base || !cwd) return ''
  const from = segments(base)
  const to = segments(cwd)
  if (to.length < from.length) return ''
  for (let i = 0; i < from.length; i += 1) if (!sameSegment(from[i], to[i])) return ''
  return to.slice(from.length).join('/')
}

/** The way back, in whichever separator the new workspace folder already uses. */
export function joinCwd(base: string, relative: string): string {
  const parts = segments(relative)
  if (!parts.length) return base
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${parts.join(separator)}`
}

/**
 * A pane about to appear in another workspace: the same launcher, none of the
 * live state. Duplicating a workspace and instantiating a template differ only
 * in where the folders come from, so this is the part they share.
 */
export function freshPane(pane: CopyablePane, id: string): CopyablePane {
  return {
    ...pane,
    id,
    ...(agentLaunch(pane) ? { sessionGeneration: `copy:${id}` } : {}),
    status: 'idle' as PaneStatus,
    exitCode: null,
    epoch: 0,
    activity: false,
    bell: false,
    processTitle: undefined,
    autostart: true
  }
}

export function templateFromWorkspace(
  workspace: CopyableWorkspace,
  name: string,
  id: string,
  createdAt: string
): WorkspaceTemplate {
  return {
    id,
    name,
    accent: workspace.accent,
    layout: workspace.layout,
    columns: workspace.columns,
    createdAt,
    // Neither names a folder, so both travel intact — the whole point of a
    // template is arriving at another repo ready to work, and an agent that has
    // to discover there is no node_modules is not that. See HD-16.
    ...(workspace.setupCommand ? { setupCommand: workspace.setupCommand } : {}),
    ...(workspace.actions?.length ? { actions: workspace.actions.map((a) => ({ ...a })) } : {}),
    panes: workspace.panes.map((pane) => {
      const stored: TemplatePane = {
        profileId: pane.profileId,
        command: pane.command,
        args: [...pane.args],
        // A worktree pane's folder is this workspace's alone. Recording the path
        // would aim two workspaces at one directory, so the template keeps only
        // the fact that the pane wanted one.
        cwd: pane.worktree ? '' : relativeCwd(workspace.cwd, pane.cwd)
      }
      if (pane.viaShell) stored.viaShell = true
      if (pane.env) stored.env = { ...pane.env }
      if (pane.name) stored.name = pane.name
      if (pane.openRouter) stored.openRouter = { ...pane.openRouter }
      if (pane.worktree) stored.worktree = true
      return stored
    })
  }
}

/**
 * Every folder the template is about to need, the workspace folder first. The
 * main process is asked which of these are missing before a single pane exists:
 * `resolveCwd()` swaps a folder that has gone for `homedir()` at spawn time,
 * which is right for a project that moved and wrong for a template that never
 * landed.
 */
export function templateDirs(template: WorkspaceTemplate, cwd: string): string[] {
  return [...new Set([cwd, ...template.panes.map((pane) => joinCwd(cwd, pane.cwd))])]
}

export function workspaceFromTemplate(
  template: WorkspaceTemplate,
  cwd: string,
  uid: (prefix: string) => string,
  missing: readonly string[] = []
): CopyableWorkspace {
  const panes = template.panes.map((pane) => {
    const dir = joinCwd(cwd, pane.cwd)
    const built: CopyablePane = {
      id: '',
      profileId: pane.profileId,
      command: pane.command,
      args: [...pane.args],
      // Landing in the workspace folder is visible in the pane header; landing
      // in $HOME, which is what spawning against a missing folder would do, is
      // not. The caller has already said so out loud by the time we get here.
      cwd: missing.includes(dir) ? cwd : dir,
      status: 'idle',
      exitCode: null,
      epoch: 0
    }
    if (pane.viaShell) built.viaShell = true
    if (pane.env) built.env = { ...pane.env }
    if (pane.name) built.name = pane.name
    if (pane.openRouter) built.openRouter = { ...pane.openRouter }
    return freshPane(built, uid('pane'))
  })

  return {
    id: uid('ws'),
    name: template.name,
    cwd,
    accent: template.accent,
    layout: template.layout,
    columns: template.columns,
    // Copied rather than shared, the way a pane's args and env are: editing the
    // new workspace's actions must not rewrite the template they came from.
    ...(template.setupCommand ? { setupCommand: template.setupCommand } : {}),
    ...(template.actions?.length ? { actions: template.actions.map((a) => ({ ...a })) } : {}),
    panes,
    activePaneId: panes[0]?.id ?? null,
    zoomedPaneId: null
  }
}
