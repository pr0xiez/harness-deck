import { create } from 'zustand'
import type {
  AppInfo,
  AttentionSettings,
  LayoutMode,
  Pane,
  PaneStatus,
  PersistedState,
  Profile,
  Settings,
  UpdateState,
  VoiceSettings,
  Workspace
} from '@shared/types'
import { ACCENTS, MONO_STACK } from './theme'

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
  broadcastHistory: [],
  broadcastSnippets: []
}

/** Panes carry a bit of state we never want to write to disk. */
interface StoredPane extends Omit<Pane, 'status' | 'exitCode' | 'activity' | 'bell' | 'processTitle'> {
  autostart?: boolean
}

export interface PaneView extends Pane {
  autostart?: boolean
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
}

interface DeckState {
  hydrated: boolean
  info: AppInfo | null
  profiles: Profile[]
  workspaces: DeckWorkspace[]
  activeWorkspaceId: string | null
  /** Workspaces whose terminals are mounted (they keep running once visited). */
  mounted: string[]
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

  setUpdate: (update: UpdateState) => void
  checkForUpdate: () => Promise<void>
  /** Confirms if panes are live, then hands over to the installer. */
  installUpdate: () => Promise<void>
  dismissUpdate: () => void
  showUpdate: () => void

  addWorkspace: (name?: string, cwd?: string) => string
  duplicateWorkspace: (id: string) => string
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
  movePane: (workspaceId: string, paneId: string, delta: number) => void
  toggleZoom: (workspaceId: string, paneId: string) => void
  setLayout: (workspaceId: string, layout: LayoutMode) => void
  setColumns: (workspaceId: string, columns: number) => void

  updateSettings: (patch: Partial<Settings>) => void
  updateVoice: (patch: Partial<VoiceSettings>) => void
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
  activeWorkspaceId: null,
  mounted: [],
  settings: DEFAULT_SETTINGS,
  ui: {
    palette: false,
    settings: false,
    help: false,
    broadcast: false,
    profileMenu: false,
    paneMenuFor: null
  },
  update: null,
  updateDismissed: null,
  updateError: null,
  updateInstalling: false,

  hydrate: async () => {
    const [info, profiles, saved] = await Promise.all([
      api.info(),
      api.listProfiles(),
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
      settings,
      activeWorkspaceId,
      mounted: activeWorkspaceId ? [activeWorkspaceId] : []
    })
  },

  refreshProfiles: async () => set({ profiles: await api.listProfiles() }),

  setUpdate: (update) => set({ update }),

  checkForUpdate: async () => set({ update: await api.update.check(), updateError: null }),

  installUpdate: async () => {
    const { update, updateInstalling, settings, workspaces } = get()
    if (!update?.available || updateInstalling) return
    const running = workspaces.reduce(
      (total, ws) => total + ws.panes.filter((p) => p.status === 'running').length,
      0
    )
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
      panes: source.panes.map((pane) => ({
        ...pane,
        id: uid('pane'),
        status: 'idle' as PaneStatus,
        exitCode: null,
        epoch: 0,
        activity: false,
        bell: false,
        processTitle: undefined,
        autostart: true
      }))
    }
    copy.activePaneId = copy.panes[0]?.id ?? null
    const index = workspaces.findIndex((w) => w.id === id)
    const next = [...workspaces]
    next.splice(index + 1, 0, copy)
    set({ workspaces: next, activeWorkspaceId: copy.id, mounted: [...get().mounted, copy.id] })
    return copy.id
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
    const pane = paneFromProfile(profile, overrides?.cwd || workspace.cwd, overrides)
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
    if (pane.status === 'running' && state.settings.confirmCloseRunning) {
      const profile = state.profiles.find((p) => p.id === pane.profileId)
      const ok = await api.confirm({
        title: 'Close pane',
        message: `${pane.name || pane.processTitle || profile?.name || pane.command} is still running.`,
        detail: 'The process will be terminated.',
        confirmLabel: 'Close pane'
      })
      if (!ok) return
    }
    get().closePane(workspaceId, paneId)
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
                bell: false
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

  setUi: (patch) => set({ ui: { ...get().ui, ...patch } })
}))

export const activeWorkspace = (state: DeckState): DeckWorkspace | undefined =>
  state.workspaces.find((w) => w.id === state.activeWorkspaceId)

export const useActiveWorkspace = (): DeckWorkspace | undefined => useDeck(activeWorkspace)

/** Strips transient fields and hands the result to the main process. */
function serialize(state: DeckState): PersistedState {
  return {
    version: 1,
    activeWorkspaceId: state.activeWorkspaceId,
    settings: state.settings,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      zoomedPaneId: null,
      panes: ws.panes.map(({ id, profileId, command, args, cwd, viaShell, name, env }) => ({
        id,
        profileId,
        command,
        args,
        cwd,
        viaShell,
        name,
        env,
        status: 'idle' as PaneStatus,
        exitCode: null,
        epoch: 0
      }))
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
