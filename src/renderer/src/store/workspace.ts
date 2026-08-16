import type { StateCreator } from 'zustand'
import type { LayoutMode, PaneStatus, Profile, WorkspaceTemplate } from '@shared/types'
import { paneLabel } from '../paneLabel'
import {
  freshPane,
  templateDirs,
  templateFromWorkspace,
  workspaceFromTemplate
} from '../templates'
import {
  api,
  isActionable,
  isLive,
  isSnoozed,
  makeWorkspace,
  paneFromProfile,
  shortName,
  uid,
  SNOOZE_MS,
  type DeckWorkspace,
  type PaneView
} from './helpers'
import type { DeckState } from './types'

export interface WorkspaceSlice {
  workspaces: DeckWorkspace[]
  /** Workspaces with their folder taken off, ready to point at another one. */
  templates: WorkspaceTemplate[]
  activeWorkspaceId: string | null
  /** Workspaces whose terminals are mounted (they keep running once visited). */
  mounted: string[]

  addWorkspace: (name?: string, cwd?: string) => string
  duplicateWorkspace: (id: string) => string
  /** Keeps a workspace's panes without its folder; returns the template id. */
  saveTemplate: (workspaceId: string, name: string) => string
  removeTemplate: (id: string) => void
  /**
   * Builds a workspace from a template against `cwd`, having first said out loud
   * which of its folders are missing. Returns '' when nothing was created.
   */
  newWorkspaceFromTemplate: (templateId: string, cwd: string) => Promise<string>
  removeWorkspace: (id: string) => void
  updateWorkspace: (id: string, patch: Partial<DeckWorkspace>) => void
  setActiveWorkspace: (id: string) => void
  moveWorkspace: (id: string, delta: number) => void
  cycleWorkspace: (delta: number) => void

  addPane: (workspaceId: string, profile: Profile, overrides?: Partial<PaneView>) => string
  /**
   * Opens one of the workspace's saved commands as an ordinary shell pane in the
   * workspace folder. Returns the new pane's id, or '' when there is nothing at
   * that id to run. See HD-16.
   */
  runWorkspaceAction: (workspaceId: string, actionId: string) => string
  closePane: (workspaceId: string, paneId: string) => void
  /** Close, asking first when the pane still has a live process. */
  requestClosePane: (workspaceId: string, paneId: string) => Promise<void>
  restartPane: (paneId: string) => void
  killPane: (paneId: string) => void
  updatePane: (paneId: string, patch: Partial<PaneView>) => void
  setPaneStatus: (paneId: string, status: PaneStatus, exitCode?: number | null) => void
  setActivePane: (workspaceId: string, paneId: string) => void
  cyclePane: (delta: number) => void
  /** Focuses the pane that has been waiting longest; returns its id, or null. */
  focusNextWaiting: () => string | null
  /**
   * The pane rang the terminal bell. A raised hand outranks a snooze — Claude
   * Code rings it at permission prompts — so this is also what wakes one.
   */
  ringBell: (paneId: string) => void
  /** Seen it, or un-seen it. Reversible, like all three attention verbs. */
  toggleAcknowledged: (paneId: string) => void
  /** Cycles the snooze: off → until this pane next goes quiet → for an hour → off. */
  cycleSnooze: (paneId: string) => void
  /** Never count this pane. Persisted, unlike the rest of the attention state. */
  toggleMuted: (paneId: string) => void
  movePane: (workspaceId: string, paneId: string, delta: number) => void
  toggleZoom: (workspaceId: string, paneId: string) => void
  setLayout: (workspaceId: string, layout: LayoutMode) => void
  setColumns: (workspaceId: string, columns: number) => void
}

export const createWorkspaceSlice: StateCreator<DeckState, [], [], WorkspaceSlice> = (
  set,
  get
) => ({
  workspaces: [],
  templates: [],
  activeWorkspaceId: null,
  mounted: [],

  addWorkspace: (name, cwd) => {
    const { workspaces, settings, info } = get()
    const dir = cwd || settings.defaultCwd || info?.defaultCwd || ''
    const ws = makeWorkspace(
      name || (cwd ? shortName(cwd) : `Workspace ${workspaces.length + 1}`),
      dir,
      workspaces.length
    )
    set({
      workspaces: [...workspaces, ws],
      activeWorkspaceId: ws.id,
      mounted: [...get().mounted, ws.id]
    })
    return ws.id
  },

  duplicateWorkspace: (id) => {
    const { workspaces } = get()
    const source = workspaces.find((w) => w.id === id)
    if (!source) return ''
    const copy: DeckWorkspace = {
      ...source,
      id: uid('ws'),
      name: `${source.name} copy`,
      zoomedPaneId: null,
      panes: source.panes.map((pane) => freshPane(pane, uid('pane')))
    }
    copy.activePaneId = copy.panes[0]?.id ?? null
    const index = workspaces.findIndex((w) => w.id === id)
    const next = [...workspaces]
    next.splice(index + 1, 0, copy)
    set({ workspaces: next, activeWorkspaceId: copy.id, mounted: [...get().mounted, copy.id] })
    return copy.id
  },

  saveTemplate: (workspaceId, name) => {
    const { workspaces, templates } = get()
    const source = workspaces.find((w) => w.id === workspaceId)
    if (!source) return ''
    const template = templateFromWorkspace(
      source,
      name.trim() || source.name,
      uid('tpl'),
      new Date().toISOString()
    )
    // Saving under a name that is already taken replaces it, so refining a
    // template is re-saving it rather than collecting five near-identical ones.
    set({
      templates: [...templates.filter((t) => t.name !== template.name), template]
    })
    return template.id
  },

  removeTemplate: (id) => set({ templates: get().templates.filter((t) => t.id !== id) }),

  newWorkspaceFromTemplate: async (templateId, cwd) => {
    const template = get().templates.find((t) => t.id === templateId)
    if (!template || !cwd) return ''

    // `resolveCwd()` in the main process swaps a folder that has gone for the
    // user's home. That is the right answer for a pane whose project moved and
    // the wrong one here — a template quietly landing in $HOME looks like it
    // worked — so the folders are checked before a single pane exists.
    const missing = await api.fs.missingDirs(templateDirs(template, cwd))
    if (missing.includes(cwd)) {
      await api.confirm({
        title: 'Folder not found',
        message: `${cwd} is not there.`,
        detail: `“${template.name}” was not created. Pick a folder that exists and try again.`,
        confirmLabel: 'OK'
      })
      return ''
    }
    if (missing.length) {
      const ok = await api.confirm({
        title: 'Missing folders',
        message: `${missing.length} folder${missing.length === 1 ? '' : 's'} “${template.name}” expects ${missing.length === 1 ? 'is' : 'are'} not in ${cwd}.`,
        detail: `${missing.join('\n')}\n\nThose panes would open in ${cwd} instead.`,
        confirmLabel: 'Create workspace anyway'
      })
      if (!ok) return ''
    }

    // HD-2 hooks in here: a template pane with `worktree: true` wants its own
    // worktree of this folder, and it lands in the workspace folder until
    // something creates one and points it there.
    const workspace = workspaceFromTemplate(template, cwd, uid, missing)
    set({
      workspaces: [...get().workspaces, workspace],
      activeWorkspaceId: workspace.id,
      mounted: [...get().mounted, workspace.id]
    })
    return workspace.id
  },

  removeWorkspace: (id) => {
    const { workspaces, activeWorkspaceId } = get()
    const target = workspaces.find((w) => w.id === id)
    target?.panes.forEach((pane) => api.pty.dispose(pane.id))
    const remaining = workspaces.filter((w) => w.id !== id)
    const nextActive =
      activeWorkspaceId === id ? (remaining[0]?.id ?? null) : activeWorkspaceId
    set({
      workspaces: remaining,
      activeWorkspaceId: nextActive,
      mounted: get()
        .mounted.filter((m) => m !== id)
        .concat(nextActive && !get().mounted.includes(nextActive) ? [nextActive] : [])
    })
  },

  updateWorkspace: (id, patch) =>
    set({
      workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w))
    }),

  setActiveWorkspace: (id) => {
    const { mounted } = get()
    set({
      activeWorkspaceId: id,
      mounted: mounted.includes(id) ? mounted : [...mounted, id]
    })
  },

  moveWorkspace: (id, delta) => {
    const workspaces = [...get().workspaces]
    const index = workspaces.findIndex((w) => w.id === id)
    const next = index + delta
    if (index < 0 || next < 0 || next >= workspaces.length) return
    const [item] = workspaces.splice(index, 1)
    workspaces.splice(next, 0, item)
    set({ workspaces })
  },

  cycleWorkspace: (delta) => {
    const { workspaces, activeWorkspaceId } = get()
    if (workspaces.length < 2) return
    const index = workspaces.findIndex((w) => w.id === activeWorkspaceId)
    const next = workspaces[(index + delta + workspaces.length) % workspaces.length]
    get().setActiveWorkspace(next.id)
  },

  addPane: (workspaceId, profile, overrides) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return ''
    const pane = paneFromProfile(profile, overrides?.cwd || profile.cwd || workspace.cwd, overrides)
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, panes: [...w.panes, pane], activePaneId: pane.id, zoomedPaneId: null }
          : w
      )
    })
    return pane.id
  },

  // Nothing special about the pane this makes: the bare `custom` launcher, the
  // workspace folder, the command line through a login shell. A chip is a
  // shortcut for typing it, not a second kind of pane — so it restarts, closes
  // and hands over a transcript like any other.
  runWorkspaceAction: (workspaceId, actionId) => {
    const { workspaces, profiles } = get()
    const workspace = workspaces.find((w) => w.id === workspaceId)
    const action = workspace?.actions?.find((a) => a.id === actionId)
    const custom = profiles.find((p) => p.id === 'custom')
    if (!workspace || !action || !custom) return ''
    return get().addPane(workspaceId, custom, {
      command: action.command,
      args: [],
      viaShell: true,
      cwd: workspace.cwd,
      // Explicit so the pane can never inherit env from whatever profile
      // resolved as `custom` — a chip runs in the workspace's own environment.
      env: undefined,
      name: action.label
    })
  },

  closePane: (workspaceId, paneId) => {
    api.pty.dispose(paneId)
    set({
      workspaces: get().workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panes = w.panes.filter((p) => p.id !== paneId)
        const activePaneId =
          w.activePaneId === paneId ? (panes[panes.length - 1]?.id ?? null) : w.activePaneId
        return {
          ...w,
          panes,
          activePaneId,
          zoomedPaneId: w.zoomedPaneId === paneId ? null : w.zoomedPaneId
        }
      })
    })
  },

  requestClosePane: async (workspaceId, paneId) => {
    const state = get()
    const pane = state.workspaces
      .find((w) => w.id === workspaceId)
      ?.panes.find((p) => p.id === paneId)
    if (!pane) return
    if (isLive(pane) && state.settings.confirmCloseRunning) {
      const profile = state.profiles.find((p) => p.id === pane.profileId)
      const ok = await api.confirm({
        title: 'Close pane',
        message: `${paneLabel(pane, profile)} is still running.`,
        detail: 'The process will be terminated.',
        confirmLabel: 'Close pane'
      })
      if (!ok) return
    }

    // A worktree is this app's own doing, so closing the pane is the moment to
    // offer to undo it. Only a folder git still calls a *linked* worktree is
    // ever offered: `worktree` is persisted state, and a repo that moved on
    // since it was written must not turn this into a prompt to delete someone's
    // main checkout.
    const worktree = pane.worktree ? await api.git.info(pane.worktree) : null
    const remove =
      pane.worktree && worktree?.worktreeOf
        ? await api.confirm({
            title: 'Remove worktree',
            message: 'Also delete the worktree this pane was working in?',
            detail: worktree.dirty
              ? `${worktree.dirty} uncommitted change${worktree.dirty === 1 ? '' : 's'} in ${pane.worktree} will be lost. The branch ${worktree.branch} is kept.`
              : `${pane.worktree} is checked out on ${worktree.branch}. Only the folder goes; the branch is kept.`,
            confirmLabel: 'Delete worktree'
          })
        : false

    get().closePane(workspaceId, paneId)

    // After the pane, so the process that was living in the directory is
    // already on its way out before git tries to take the directory away.
    if (remove && pane.worktree) {
      const result = await api.git.removeWorktree(pane.worktree)
      if (!result.ok) {
        console.warn(`[worktree] ${result.error}`)
        set({
          notice: {
            title: 'Worktree not removed',
            body: `${pane.worktree} is still on disk: ${result.error}`
          }
        })
      }
    }
  },

  restartPane: (paneId) => {
    api.pty.dispose(paneId)
    const { workspaces } = get()
    const owner = workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    if (!owner) return
    set({
      workspaces: workspaces.map((w) =>
        w === owner
          ? {
              ...w,
              panes: w.panes.map((p) =>
                p.id === paneId
                  ? {
                      ...p,
                      epoch: p.epoch + 1,
                      status: 'idle' as PaneStatus,
                      exitCode: null,
                      autostart: true,
                      activity: false,
                      bell: false,
                      // A person starting the pane by hand is not the crash loop
                      // continuing, whatever auto-restart had already spent on it.
                      crashRestarts: 0
                    }
                  : p
              )
            }
          : w
      )
    })
  },

  killPane: (paneId) => api.pty.kill(paneId),

  // A pane lives in exactly one workspace, so only that workspace is rebuilt;
  // every other workspace keeps its identity, which is what keeps a pane event
  // from re-rendering the whole deck.
  updatePane: (paneId, patch) => {
    const { workspaces } = get()
    const owner = workspaces.find((w) => w.panes.some((p) => p.id === paneId))
    if (!owner) return
    set({
      workspaces: workspaces.map((w) =>
        w === owner
          ? { ...w, panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
          : w
      )
    })
  },

  setPaneStatus: (paneId, status, exitCode = null) => get().updatePane(paneId, { status, exitCode }),

  setActivePane: (workspaceId, paneId) =>
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              activePaneId: paneId,
              panes: w.panes.map((p) =>
                p.id === paneId ? { ...p, activity: false, bell: false } : p
              )
            }
          : w
      )
    }),

  cyclePane: (delta) => {
    const { workspaces, activeWorkspaceId } = get()
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!ws || ws.panes.length < 2) return
    const index = ws.panes.findIndex((p) => p.id === ws.activePaneId)
    const next = ws.panes[(index + delta + ws.panes.length) % ws.panes.length]
    get().setActivePane(ws.id, next.id)
  },

  focusNextWaiting: () => {
    const { workspaces, activeWorkspaceId } = get()
    const active = workspaces.find((w) => w.id === activeWorkspaceId)
    const now = Date.now()
    // Oldest first: with six panes, "which one next" has an answer, and it is
    // whichever agent has been sitting at its prompt longest. Muted, snoozed
    // and acknowledged panes are not answers to that question.
    const queue = workspaces
      .flatMap((ws) => ws.panes.map((pane) => ({ ws, pane })))
      .filter(({ pane }) => isActionable(pane, now))
      .sort((a, b) => (a.pane.waitingSince ?? 0) - (b.pane.waitingSince ?? 0))
    // Start just after the pane already in front, and never offer it back, so
    // pressing the key again walks the queue rather than bouncing between two.
    const at = queue.findIndex(
      ({ ws, pane }) => ws.id === active?.id && pane.id === active?.activePaneId
    )
    const next = (at < 0 ? queue : [...queue.slice(at + 1), ...queue.slice(0, at)])[0]
    if (!next) return null
    if (next.ws.id !== activeWorkspaceId) get().setActiveWorkspace(next.ws.id)
    get().setActivePane(next.ws.id, next.pane.id)
    return next.pane.id
  },

  ringBell: (paneId) => {
    const pane = get()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === paneId)
    // `woke` is only news when there was a snooze to cut short; setting it on
    // every bell would flag panes nobody had put off in the first place.
    get().updatePane(paneId, {
      bell: true,
      ...(pane && isSnoozed(pane) ? { snooze: undefined, woke: true } : {})
    })
  },

  toggleAcknowledged: (paneId) => {
    const pane = get()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === paneId)
    if (pane) get().updatePane(paneId, { acknowledged: !pane.acknowledged })
  },

  cycleSnooze: (paneId) => {
    const pane = get()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === paneId)
    if (!pane) return
    const next =
      pane.snooze === undefined ? 'quiet' : pane.snooze === 'quiet' ? Date.now() + SNOOZE_MS : undefined
    // Snoozing is saying "not now", so it also un-flags the bell that said now.
    get().updatePane(paneId, { snooze: next, woke: false })
  },

  toggleMuted: (paneId) => {
    const pane = get()
      .workspaces.flatMap((w) => w.panes)
      .find((p) => p.id === paneId)
    if (pane) get().updatePane(paneId, { attentionMuted: !pane.attentionMuted })
  },

  movePane: (workspaceId, paneId, delta) =>
    set({
      workspaces: get().workspaces.map((w) => {
        if (w.id !== workspaceId) return w
        const panes = [...w.panes]
        const index = panes.findIndex((p) => p.id === paneId)
        const next = index + delta
        if (index < 0 || next < 0 || next >= panes.length) return w
        const [item] = panes.splice(index, 1)
        panes.splice(next, 0, item)
        return { ...w, panes }
      })
    }),

  toggleZoom: (workspaceId, paneId) =>
    set({
      workspaces: get().workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              zoomedPaneId: w.zoomedPaneId === paneId ? null : paneId,
              activePaneId: paneId
            }
          : w
      )
    }),

  setLayout: (workspaceId, layout) => get().updateWorkspace(workspaceId, { layout }),
  setColumns: (workspaceId, columns) =>
    get().updateWorkspace(workspaceId, { columns: Math.min(4, Math.max(1, columns)) })
})
