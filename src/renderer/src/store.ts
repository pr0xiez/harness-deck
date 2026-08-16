import { create } from 'zustand'
import type {
  AppInfo,
  AttentionSettings,
  LayoutMode,
  Pane,
  PaneStatus,
  PersistedState,
  Profile,
  RemoteSettings,
  RepoInfo,
  SavedProfile,
  Settings,
  UpdateState,
  VoiceSettings,
  Workspace,
  WorkspaceTemplate
} from '@shared/types'
import { ACCENTS, MONO_STACK } from './theme'
import { paneLabel } from './paneLabel'
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

// Off, loopback-only, read-only: the server does not exist until each is
// changed by hand. See HD-21.
export const DEFAULT_REMOTE: RemoteSettings = {
  enabled: false,
  lan: false,
  allowTyping: false
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
  remote: DEFAULT_REMOTE,
  // Nothing reaches the network until this is changed by hand.
  updateChannel: 'local',
  broadcastHistory: [],
  broadcastSnippets: []
}

/** How far back ↑ reaches in the broadcast box before prompts are forgotten. */
const BROADCAST_HISTORY = 50

/** The long leg of the snooze cycle. Long enough to be a decision, short enough to forget. */
export const SNOOZE_MS = 60 * 60 * 1000

/** Panes carry a bit of state we never want to write to disk. */
interface StoredPane extends Omit<Pane, 'status' | 'exitCode' | 'activity' | 'bell' | 'processTitle'> {
  autostart?: boolean
}

export interface PaneView extends Pane {
  autostart?: boolean
  /**
   * Never written to disk — the pane exists for one run of one command (the
   * ship pane, HD-18). A persisted copy would autostart on relaunch and run
   * the command again against whatever the folder holds by then, which for a
   * commit-and-push chain is a repo mutation nobody asked for.
   */
  transient?: boolean
  /**
   * Auto-restarts spent on the crash loop the pane is in. Transient on purpose:
   * a pane that comes back with the app is starting fresh, not resuming a loop
   * whose process died before the window closed.
   */
  crashRestarts?: number
  /**
   * When the pane last went quiet — the queue's ordering, oldest first. The
   * three fields below are the same bargain as `crashRestarts`: how you felt
   * about a prompt an hour ago is not something a restart should inherit, so
   * none of them are persisted. Only `attentionMuted` is, on `Pane`.
   */
  waitingSince?: number
  /** Seen it. Cleared the next time the pane goes quiet — a fresh stop is fresh news. */
  acknowledged?: boolean
  /** Not now: until this pane next goes quiet, or until a wall-clock moment. */
  snooze?: 'quiet' | number
  /** The bell cut a snooze short: this pane raised its hand while you were away. */
  woke?: boolean
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
  /**
   * Text waiting for the broadcast box to pick it up — a pane's selection,
   * already fenced. The bar clears it the moment it lands in the box, so the
   * same selection can be sent again and land again.
   */
  pendingInsert: string | null
  /** Every pane waiting for you, across all workspaces, with its last lines. See HD-15. */
  waitingQueue: boolean
  /** Workspace whose setup command and actions are being edited. See HD-16. */
  workspaceDialogFor: string | null
  /** Pane whose ship dialog is open — a worktree pane, always. See HD-18. */
  shipFor: string | null
}

/** A background failure the user was never going to see in a console. */
export interface DeckNotice {
  title: string
  body: string
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
  /** Shown bottom-right until waved off. Never saved. */
  notice: DeckNotice | null

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

  updateSettings: (patch: Partial<Settings>) => void
  updateVoice: (patch: Partial<VoiceSettings>) => void
  updateAttention: (patch: Partial<AttentionSettings>) => void
  /** Files a sent prompt at the front of the broadcast history. */
  rememberBroadcast: (prompt: string) => void
  setUi: (patch: Partial<UiState>) => void
  setNotice: (notice: DeckNotice | null) => void
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
    compare: false,
    pendingInsert: null,
    waitingQueue: false,
    workspaceDialogFor: null,
    shipFor: null
  },
  update: null,
  updateDismissed: null,
  updateError: null,
  updateInstalling: false,
  notice: null,

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
      attention: { ...DEFAULT_ATTENTION, ...saved?.settings?.attention },
      remote: { ...DEFAULT_REMOTE, ...saved?.settings?.remote }
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
    const pane = findPane(get().workspaces, paneId)
    // `woke` is only news when there was a snooze to cut short; setting it on
    // every bell would flag panes nobody had put off in the first place.
    get().updatePane(paneId, {
      bell: true,
      ...(pane && isSnoozed(pane) ? { snooze: undefined, woke: true } : {})
    })
  },

  toggleAcknowledged: (paneId) => {
    const pane = findPane(get().workspaces, paneId)
    if (pane) get().updatePane(paneId, { acknowledged: !pane.acknowledged })
  },

  cycleSnooze: (paneId) => {
    const pane = findPane(get().workspaces, paneId)
    if (!pane) return
    const next =
      pane.snooze === undefined ? 'quiet' : pane.snooze === 'quiet' ? Date.now() + SNOOZE_MS : undefined
    // Snoozing is saying "not now", so it also un-flags the bell that said now.
    get().updatePane(paneId, { snooze: next, woke: false })
  },

  toggleMuted: (paneId) => {
    const pane = findPane(get().workspaces, paneId)
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

  setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),

  setNotice: (notice) => set({ notice })
}))

/**
 * A waiting pane is a running one that has gone quiet, so everything that asks
 * "is there still a process on the end of this?" — close prompts, broadcast
 * targets, the running count — has to count it.
 */
export const isLive = (pane: { status: PaneStatus }): boolean =>
  pane.status === 'running' || pane.status === 'waiting'

/**
 * Is this pane's snooze still in force? "Until next quiet" runs until the quiet
 * handler lifts it; an hour-long one expires on its own, and is re-read rather
 * than cleared on a timer — nothing else in the app is waiting on the moment it
 * lapses, and the next thing that touches the store notices.
 */
export function isSnoozed(pane: PaneView, now: number = Date.now()): boolean {
  if (pane.snooze === undefined) return false
  return pane.snooze === 'quiet' || pane.snooze > now
}

/**
 * The one question every aggregate is really asking: does this pane want you,
 * *and* have you not already said otherwise? The dock badge, the sidebar counts,
 * the title-bar Waiting button, the palette hint and Ctrl+Shift+J all run on
 * this, so muting a pane, snoozing it or acknowledging it takes it out of all
 * five at once.
 *
 * The waiting queue itself is deliberately looser — it still shows what you
 * acknowledged, dimmed — and a pane's own amber header dot is looser still: that
 * is the local truth, and muting is about the aggregates, not about lying to the
 * pane you are looking at.
 */
export function isActionable(pane: PaneView, now: number = Date.now()): boolean {
  return (
    pane.status === 'waiting' &&
    !pane.attentionMuted &&
    !pane.acknowledged &&
    !isSnoozed(pane, now)
  )
}

export const activeWorkspace = (state: DeckState): DeckWorkspace | undefined =>
  state.workspaces.find((w) => w.id === state.activeWorkspaceId)

/** The pane with this id, wherever in the deck it lives. */
export const findPane = (
  workspaces: DeckWorkspace[],
  paneId: string | null | undefined
): PaneView | undefined => workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)

/** The workspace holding the pane with this id. */
export const findPaneWorkspace = (
  workspaces: DeckWorkspace[],
  paneId: string
): DeckWorkspace | undefined => workspaces.find((w) => w.panes.some((p) => p.id === paneId))

export const useActiveWorkspace = (): DeckWorkspace | undefined => useDeck(activeWorkspace)

/** Strips transient fields and hands the result to the main process. */
export function serialize(state: DeckState): PersistedState {
  return {
    version: 1,
    activeWorkspaceId: state.activeWorkspaceId,
    settings: state.settings,
    templates: state.templates,
    workspaces: state.workspaces.map((ws) => {
      // A transient pane (the ship pane) is one run of one command; writing it
      // to disk would make relaunch run the command again.
      const kept = ws.panes.filter((p) => !p.transient)
      return {
        ...ws,
        zoomedPaneId: null,
        activePaneId: kept.some((p) => p.id === ws.activePaneId)
          ? ws.activePaneId
          : (kept[kept.length - 1]?.id ?? null),
        panes: kept.map(
          ({
            id,
            profileId,
            command,
            args,
            cwd,
            viaShell,
            name,
            env,
            setup,
            worktree,
            autoRestart,
            readOnly,
            attentionMuted
          }) => ({
            id,
            profileId,
            command,
            args,
            cwd,
            viaShell,
            name,
            env,
            // Kept for the same reason as `worktree`: a restart re-runs the setup,
            // and a pane that forgot it would put the agent in a tree nothing has
            // installed into since the app was last quit.
            setup,
            // Kept, or a restart would forget that this folder is ours to remove.
            worktree,
            autoRestart,
            readOnly,
            // The build pane that goes quiet all day is still that pane tomorrow.
            // Snoozes and acknowledgements are not: those expire with the session.
            attentionMuted,
            status: 'idle' as PaneStatus,
            exitCode: null,
            epoch: 0
          })
        )
      }
    })
  }
}

/** What a quiet subscriber is told: the event, and the pane it was about. */
export interface QuietPaneEvent {
  id: string
  quiet: boolean
  pane: PaneView
}

const quietSubscribers = new Set<(event: QuietPaneEvent) => void>()

/**
 * Also told when a pane falls quiet. Three things want that moment — the
 * toolbar's git refresh, the attention state above, and HD-20's checkpoints —
 * and each one subscribing to the bridge separately would mean three copies of
 * the "is this the transition or a repeat?" rule. `startAttention` owns the rule
 * and hands on what survived it.
 */
export function onQuietPane(handler: (event: QuietPaneEvent) => void): () => void {
  quietSubscribers.add(handler)
  return () => quietSubscribers.delete(handler)
}

/**
 * The single subscription to `pty:quiet`, started once from main.tsx.
 *
 * Output *stopping* is the signal worth having: the agent has hit a prompt, an
 * approval gate, or finished. The main process owns the clock; all that is left
 * here is turning it into a status the UI can route on — and, for a window
 * nobody is looking at, one notification per pane per stop.
 */
export function startAttention(): () => void {
  return api.pty.onQuiet(({ id, quiet }) => {
    const state = useDeck.getState()
    const pane = findPane(state.workspaces, id)
    // An exit is the newer truth — a dead pane is not waiting for you — and
    // the guard doubles as the once-per-transition rule for the notification.
    if (!pane || pane.status !== (quiet ? 'running' : 'waiting')) return

    // Read before the transition lifts it: "until next quiet" ends *at* this
    // quiet, which is exactly the moment the pane becomes news again. An
    // hour-long one that has not yet run out still holds.
    const stillSnoozed = quiet && pane.snooze !== 'quiet' && isSnoozed(pane)
    if (quiet) {
      state.updatePane(id, {
        status: 'waiting',
        exitCode: null,
        waitingSince: Date.now(),
        // A fresh stop is fresh news, so having been seen last time counts for
        // nothing — and a hand raised during the last stop has been answered.
        acknowledged: false,
        woke: false,
        snooze: pane.snooze === 'quiet' ? undefined : pane.snooze
      })
    } else {
      state.setPaneStatus(id, 'running')
    }

    if (quiet && state.settings.attention.notify && !document.hasFocus()) {
      // Muted and snoozed panes reach no aggregate, and a notification is the
      // loudest aggregate there is.
      if (!pane.attentionMuted && !stillSnoozed) {
        new Notification('Harness Deck', {
          body: `${pane.name || pane.processTitle || pane.command} is waiting for you`
        })
      }
    }

    for (const handler of [...quietSubscribers]) handler({ id, quiet, pane })
  })
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
