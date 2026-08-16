import type { StateCreator } from 'zustand'
import type { PaneStatus, PersistedState } from '@shared/types'
import { api } from './helpers'
import type { DeckState } from './types'

export interface PersistSlice {
  /** Why the last save did not reach disk; null again once one does. */
  saveError: string | null
  /**
   * The current failure's toast was waved off. Cleared by the next save that
   * lands, so a fresh run of failures shows the toast again — dismissing is
   * "stop telling me about this outage", not "never warn me again".
   */
  saveErrorDismissed: boolean

  /** One immediate save of the deck as it stands, without waiting for an edit. */
  retrySave: () => Promise<void>
  dismissSaveError: () => void
}

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

let lastSnapshot = ''

/**
 * Enough of the store for `deliverSave` to report an outcome. Passed in rather
 * than imported, because the store is assembled from these slices — reaching
 * back for `useDeck` from here would be a runtime import cycle.
 */
export interface SaveTarget {
  getState: () => DeckState
  setState: (patch: Partial<DeckState>) => void
}

/**
 * One write to disk, with the outcome reflected into the store (issue #26).
 *
 * The snapshot is remembered before the reply comes back — that is what lets
 * the debounce dedupe back-to-back identical decks — and handed back on
 * failure: a snapshot kept after a failed write would convince the debounce
 * the deck was already on disk, and the next edit would skip the write that
 * could have recovered it. Forgetting it means every later change — even one
 * that serializes identically — tries again, which is the retry loop, for free.
 *
 * The toast is fed by `saveError`, written only when the message changes and
 * cleared by the first save that lands — so a failure streak shows one toast
 * for as long as it lasts rather than a new one per debounce tick.
 */
export async function deliverSave(
  payload: PersistedState,
  snapshot: string,
  store: SaveTarget
): Promise<void> {
  lastSnapshot = snapshot
  const result = await api.saveState(payload)
  const { saveError, saveErrorDismissed } = store.getState()
  if (result.ok) {
    if (saveError !== null || saveErrorDismissed) {
      store.setState({ saveError: null, saveErrorDismissed: false })
    }
    return
  }
  if (lastSnapshot === snapshot) lastSnapshot = ''
  const error = result.error || 'unknown error'
  if (saveError !== error) store.setState({ saveError: error })
}

/** The deck as last written to disk — the debounce's dedupe key. */
export const savedSnapshot = (): string => lastSnapshot

export const createPersistSlice: StateCreator<DeckState, [], [], PersistSlice> = (set, get) => ({
  saveError: null,
  saveErrorDismissed: false,

  retrySave: async () => {
    const payload = serialize(get())
    await deliverSave(payload, JSON.stringify(payload), { getState: get, setState: set })
  },

  dismissSaveError: () => set({ saveErrorDismissed: true })
})
