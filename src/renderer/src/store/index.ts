import { create } from 'zustand'
import type { PaneStatus, PersistedState } from '@shared/types'
import { createAppSlice } from './app'
import { api, type DeckWorkspace } from './helpers'
import { createSettingsSlice } from './settings'
import type { DeckState } from './types'
import { createUiSlice } from './ui'
import { createUpdateSlice } from './update'
import { createWorkspaceSlice } from './workspace'

export { isLive, type DeckWorkspace, type PaneView } from './helpers'
export { DEFAULT_ATTENTION, DEFAULT_SETTINGS, DEFAULT_VOICE } from './settings'
export type { DeckState } from './types'

export const useDeck = create<DeckState>()((...args) => ({
  ...createAppSlice(...args),
  ...createWorkspaceSlice(...args),
  ...createSettingsSlice(...args),
  ...createUpdateSlice(...args),
  ...createUiSlice(...args)
}))

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
