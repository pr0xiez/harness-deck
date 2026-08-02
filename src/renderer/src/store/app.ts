import type { StateCreator } from 'zustand'
import type {
  AppInfo,
  PaneStatus,
  Profile,
  RepoInfo,
  SavedProfile,
  Settings
} from '@shared/types'
import {
  api,
  makeWorkspace,
  paneFromProfile,
  shortName,
  type DeckWorkspace,
  type StoredPane
} from './helpers'
import { DEFAULT_ATTENTION, DEFAULT_SETTINGS, DEFAULT_VOICE } from './settings'
import type { DeckState } from './types'

export interface AppSlice {
  hydrated: boolean
  info: AppInfo | null
  profiles: Profile[]
  /** What git says about the folders on screen, keyed by folder. Never saved. */
  repos: Record<string, RepoInfo | null>

  hydrate: () => Promise<void>
  refreshProfiles: () => Promise<void>
  /** Re-reads git for one folder. Called on window focus and when a pane falls quiet. */
  refreshRepo: (dir: string) => Promise<void>
  /** Keeps a launcher in the harness menu; an existing id is edited in place. */
  saveLauncher: (profile: SavedProfile) => Promise<void>
  removeLauncher: (id: string) => Promise<void>
}

export const createAppSlice: StateCreator<DeckState, [], [], AppSlice> = (set, get) => ({
  hydrated: false,
  info: null,
  profiles: [],
  repos: {},

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

  removeLauncher: async (id) => set({ profiles: await api.profiles.removeCustom(id) })
})
