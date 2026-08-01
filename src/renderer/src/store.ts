import { create } from 'zustand'
import type {
  AppInfo,
  AttentionSettings,
  LayoutMode,
  Pane,
  PaneStatus,
  PersistedState,
  Profile,
  RepoInfo,
  SavedProfile,
  Settings,
  UpdateState,
  VoiceSettings,
  Workspace,
  WorkspaceTemplate
} from '@shared/types'
import { ACCENTS, MONO_STACK } from './theme'
import {
  freshPane,
  templateDirs,
  templateFromWorkspace,
  workspaceFromTemplate
} from './templates'

const api = window.harness

export const DEFAULT_VOICE: VoiceSettings = {
  provider: 'openrouter',
  baseUrl: '',
  model: '',
  language: '',
  prompt: '',
  submit: false,
  autoStop: true
}

export const DEFAULT_ATTENTION: AttentionSettings = {
  quietMs: 2500,
  notify: true,
  badge: true
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: MONO_STACK,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 8000,
  copyOnSelect: false,
  confirmCloseRunning: true,
  autoStartPanes: true,
  defaultCwd: '',
  bellNotifications: true,
  sidebarCollapsed: false,
  voice: DEFAULT_VOICE,
  attention: DEFAULT_ATTENTION,
  // Nothing reaches the network until this is changed by hand.
  updateChannel: 'local',
  broadcastHistory: [],
  broadcastSnippets: []
}

/** How far back ↑ reaches in the broadcast box before prompts are forgotten. */
const BROADCAST_HISTORY = 50

/** Panes carry a bit of state we never want to write to disk. */
interface StoredPane extends Omit<Pane, 'status' | 'exitCode' | 'activity' | 'bell' | 'processTitle'> {
  autostart?: boolean
}

export interface PaneView extends Pane {
  autostart?: boolean
  /**
   * Auto-restarts spent on the crash loop the pane is in. Transient on purpose:
   * a pane that comes back with the app is starting fresh, not resuming a loop
   * whose process died before the window closed.
   */
  crashRestarts?: number
}

export interface DeckWorkspace extends Workspace {
  panes: PaneView[]
}

interface UiState {
  palette: boolean
  settings: boolean
  help: boolean
  broadcast: boolean
  profileMenu: boolean
  paneMenuFor: string | null
  /** Pane whose edit dialog is open. */
  paneDialogFor: string | null
  /** Workspace being saved as a template. */
  templateSaveFor: string | null
  /** The "new workspace from template" picker. */
  templatePicker: boolean
  /** The workspace-wide find bar. */
  findAll: boolean
  /** The side-by-side diff over the active workspace's worktree panes. See HD-3. */
  compare: boolean
}

interface DeckState {
  hydrated: boolean
  info: AppInfo | null
  profiles: Profile[]
  workspaces: DeckWorkspace[]
  /** Workspaces with their folder taken off, ready to point at another one. */
  templates: WorkspaceTemplate[]
  activeWorkspaceId: string | null
  /** Workspaces whose terminals are mounted (they keep running once visited). */
  mounted: string[]
  /** What git says about the folders on screen, keyed by folder. Never saved. */
  repos: Record<string, RepoInfo | null>
  settings: Settings
  ui: UiState
  update: UpdateState | null
  /** Version whose toast the user waved off; the title bar still offers it. */
  updateDismissed: string | null
  /** Why the last install attempt did not get off the ground. */
  updateError: string | null
  updateInstalling: boolean

  hydrate: () => Promise<void>
  refreshProfiles: () => Promise<void>
  /** Re-reads git for one folder. Called on window focus and when a pane falls quiet. */
  refreshRepo: (dir: string) => Promise<void>
  /** Keeps a launcher in the harness menu; an existing id is edited in place. */
  saveLauncher: (profile: SavedProfile) => Promise<void>
  removeLauncher: (id: string) => Promise<void>

  setUpdate: (update: UpdateState) => void
  checkForUpdate: () => Promise<void>
  /** Confirms if panes are live, then hands over to the installer. */
  installUpdate: () => Promise<void>
  dismissUpdate: () => void
  showUpdate: () => void

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
  closePane: (workspaceId: string, paneId: string) => void
  /** Close, asking first when the pane still has a live process. */
  requestClosePane: (workspaceId: string, paneId: string) => Promise<void>
  restartPane: (paneId: string) => void
  killPane: (paneId: string) => void
  updatePane: (paneId: string, patch: Partial<PaneView>) => void
  setPaneStatus: (paneId: string, status: PaneStatus, exitCode?: number | null) => void
  setActivePane: (workspaceId: string, paneId: string) => void
  cyclePane: (delta: number) => void
  /** Focuses the next pane that has gone quiet; returns its id, or null. */
  focusNextWaiting: () => string | null
  movePane: (workspaceId: string, paneId: string, delta: number) => void
  toggleZoom: (workspaceId: string, paneId: string) => void
  setLayout: (workspaceId: string, layout: LayoutMode) => void
  setColumns: (workspaceId: string, columns: number) => void

  updateSettings: (patch: Partial<Settings>) => void
  updateVoice: (patch: Partial<VoiceSettings>) => void
  updateAttention: (patch: Partial<AttentionSettings>) => void
  /** Files a sent prompt at the front of the broadcast history. */
  rememberBroadcast: (prompt: string) => void
  setUi: (patch: Partial<UiState>) => void
}

let idCounter = 0
const uid = (prefix: string): string => {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`
}

const shortName = (cwd: string): string => {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd || 'Workspace'
}

function paneFromProfile(profile: Profile, cwd: string, overrides: Partial<PaneView> = {}): PaneView {
  return {
    id: uid('pane'),
    profileId: profile.id,
    command: profile.command,
    args: [...profile.args],
    viaShell: profile.viaShell,
    cwd,
    env: profile.env,
    // A saved launcher can be deleted while panes opened from it are still
    // running, so the pane keeps the label rather than looking it up later.
    ...(profile.id.startsWith('custom:') ? { name: profile.name } : {}),
    status: 'idle',
    exitCode: null,
    epoch: 0,
    autostart: true,
    ...overrides
  }
}

function makeWorkspace(name: string, cwd: string, index: number): DeckWorkspace {
  return {
    id: uid('ws'),
    name,
    cwd,
    accent: ACCENTS[index % ACCENTS.length],
    panes: [],
    activePaneId: null,
    layout: 'grid',
    columns: 2,
    zoomedPaneId: null
  }
}

export const useDeck = create<DeckState>((set, get) => ({
  hydrated: false,
  info: null,
  profiles: [],
  workspaces: [],
  templates: [],
  activeWorkspaceId: null,
  mounted: [],
  repos: {},
  settings: DEFAULT_SETTINGS,
  ui: {
    palette: false,
    settings: false,
    help: false,
    broadcast: false,
    profileMenu: false,
    paneMenuFor: null,
    paneDialogFor: null,
    templateSaveFor: null,
    templatePicker: false,
    findAll: false,
    compare: false
  },
  update: null,
  updateDismissed: null,
  updateError: null,
  updateInstalling: false,

  hydrate: async () => {
    const [info, profiles, saved] = await Promise.all([
      api.info(),
      api.profiles.list(),
      api.loadState()
    ])

    const defaultCwd = saved?.settings?.defaultCwd || info.defaultCwd
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      ...saved?.settings,
      defaultCwd,
      // Nested, so a state file written before a field existed still gets it.
      voice: { ...DEFAULT_VOICE, ...saved?.settings?.voice },
      attention: { ...DEFAULT_ATTENTION, ...saved?.settings?.attention }
    }

    let workspaces: DeckWorkspace[] = (saved?.workspaces ?? []).map((ws) => ({
      ...ws,
      zoomedPaneId: null,
      panes: (ws.panes as StoredPane[]).map((pane) => ({
        ...pane,
        status: 'idle' as PaneStatus,
        exitCode: null,
        epoch: 0,
        activity: false,
        bell: false,
        autostart: settings.autoStartPanes
      }))
    }))

    if (!workspaces.length) {
      const first = makeWorkspace(shortName(defaultCwd), defaultCwd, 0)
      const preferred =
        profiles.find((p) => p.id === 'agent:claude' && p.available) ??
        profiles.find((p) => p.kind === 'agent' && p.available) ??
        profiles.find((p) => p.id === 'shell:default')
      if (preferred) {
        const pane = paneFromProfile(preferred, defaultCwd)
        first.panes = [pane]
        first.activePaneId = pane.id
      }
      workspaces = [first]
    }

    const activeWorkspaceId =
      workspaces.find((w) => w.id === saved?.activeWorkspaceId)?.id ?? workspaces[0]?.id ?? null

    set({
      hydrated: true,
      info,
      profiles,
      workspaces,
      // A state file written before templates existed simply has none.
      templates: saved?.templates ?? [],
      settings,
      activeWorkspaceId,
      mounted: activeWorkspaceId ? [activeWorkspaceId] : []
    })
  },

  refreshProfiles: async () => set({ profiles: await api.profiles.list() }),

  // Keyed by folder rather than by workspace, so a workspace whose folder
  // changed while the call was in flight gets the answer to the question it is
  // now asking, and a stale one lands harmlessly on the folder it was about.
  refreshRepo: async (dir) => {
    if (!dir) return
    const repo = await api.git.info(dir)
    set({ repos: { ...get().repos, [dir]: repo } })
  },

  // Both hand back the whole merged list, detected launchers included.
  saveLauncher: async (profile) => set({ profiles: await api.profiles.saveCustom(profile) }),

  removeLauncher: async (id) => set({ profiles: await api.profiles.removeCustom(id) }),

  setUpdate: (update) => set({ update }),

  checkForUpdate: async () => set({ update: await api.update.check(), updateError: null }),

  installUpdate: async () => {
    const { update, updateInstalling, settings, workspaces } = get()
    if (!update?.available || updateInstalling) return
    const running = workspaces.reduce((total, ws) => total + ws.panes.filter(isLive).length, 0)
    if (running && settings.confirmCloseRunning) {
      const ok = await api.confirm({
        title: 'Install update',
        message: `${running} pane${running === 1 ? ' is' : 's are'} still running.`,
        detail: 'Harness Deck closes to install, then reopens. Their processes will be terminated.',
        confirmLabel: 'Restart & install'
      })
      if (!ok) return
    }
    set({ updateInstalling: true, updateError: null })
    const result = await api.update.install()
    // On success the app is quitting, so only a failure needs handling here.
    if (!result.ok) {
      set({ updateInstalling: false, updateError: result.error || 'The installer did not start.' })
    }
  },

  dismissUpdate: () =>
    set({ updateDismissed: get().update?.available?.version ?? null, updateError: null }),

  showUpdate: () => set({ updateDismissed: null }),

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
        message: `${pane.name || pane.processTitle || profile?.name || pane.command} is still running.`,
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
      if (!result.ok) console.warn(`[worktree] ${result.error}`)
    }
  },

  restartPane: (paneId) => {
    api.pty.dispose(paneId)
    set({
      workspaces: get().workspaces.map((w) => ({
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
      }))
    })
  },

  killPane: (paneId) => api.pty.kill(paneId),

  updatePane: (paneId, patch) =>
    set({
      workspaces: get().workspaces.map((w) => ({
        ...w,
        panes: w.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p))
      }))
    }),

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
    const flat = workspaces.flatMap((ws) => ws.panes.map((pane) => ({ ws, pane })))
    // Start just after the focused pane, so pressing it again walks the queue
    // rather than landing on the same pane every time.
    const from =
      flat.findIndex(({ ws, pane }) => ws.id === active?.id && pane.id === active?.activePaneId) + 1
    const ordered = [...flat.slice(from), ...flat.slice(0, from)]
    const next = ordered.find(({ pane }) => pane.status === 'waiting')
    if (!next) return null
    if (next.ws.id !== activeWorkspaceId) get().setActiveWorkspace(next.ws.id)
    get().setActivePane(next.ws.id, next.pane.id)
    return next.pane.id
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
    get().updateWorkspace(workspaceId, { columns: Math.min(4, Math.max(1, columns)) }),

  updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

  updateVoice: (patch) =>
    set({ settings: { ...get().settings, voice: { ...get().settings.voice, ...patch } } }),

  updateAttention: (patch) =>
    set({ settings: { ...get().settings, attention: { ...get().settings.attention, ...patch } } }),

  rememberBroadcast: (prompt) => {
    const text = prompt.trim()
    if (!text) return
    const { settings } = get()
    // Re-sending an old prompt moves it back to the top rather than doubling it.
    const broadcastHistory = [text, ...settings.broadcastHistory.filter((p) => p !== text)]
    set({ settings: { ...settings, broadcastHistory: broadcastHistory.slice(0, BROADCAST_HISTORY) } })
  },

  setUi: (patch) => set({ ui: { ...get().ui, ...patch } })
}))

/**
 * A waiting pane is a running one that has gone quiet, so everything that asks
 * "is there still a process on the end of this?" — close prompts, broadcast
 * targets, the running count — has to count it.
 */
export const isLive = (pane: { status: PaneStatus }): boolean =>
  pane.status === 'running' || pane.status === 'waiting'

export const activeWorkspace = (state: DeckState): DeckWorkspace | undefined =>
  state.workspaces.find((w) => w.id === state.activeWorkspaceId)

export const useActiveWorkspace = (): DeckWorkspace | undefined => useDeck(activeWorkspace)

/** Strips transient fields and hands the result to the main process. */
export function serialize(state: DeckState): PersistedState {
  return {
    version: 1,
    activeWorkspaceId: state.activeWorkspaceId,
    settings: state.settings,
    templates: state.templates,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      zoomedPaneId: null,
      panes: ws.panes.map(
        ({
          id,
          profileId,
          command,
          args,
          cwd,
          viaShell,
          name,
          env,
          worktree,
          autoRestart,
          readOnly
        }) => ({
          id,
          profileId,
          command,
          args,
          cwd,
          viaShell,
          name,
          env,
          // Kept, or a restart would forget that this folder is ours to remove.
          worktree,
          autoRestart,
          readOnly,
          status: 'idle' as PaneStatus,
          exitCode: null,
          epoch: 0
        })
      )
    }))
  }
}

let saveTimer: number | undefined
let lastSnapshot = ''

/** Debounced persistence — called on every store change once hydrated. */
export function startPersistence(): () => void {
  return useDeck.subscribe((state) => {
    if (!state.hydrated) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const payload = serialize(state)
      const snapshot = JSON.stringify(payload)
      if (snapshot === lastSnapshot) return
      lastSnapshot = snapshot
      api.saveState(payload)
    }, 400)
  })
}
