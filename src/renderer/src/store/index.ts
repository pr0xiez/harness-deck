import { create } from 'zustand'
import type { PaneStatus, PersistedState } from '@shared/types'
import { createAppSlice } from './app'
import { api, isSnoozed, type DeckWorkspace, type PaneView } from './helpers'
import { createSettingsSlice } from './settings'
import type { DeckState } from './types'
import { createUiSlice } from './ui'
import { createUpdateSlice } from './update'
import { createWorkspaceSlice } from './workspace'

export {
  isActionable,
  isLive,
  isSnoozed,
  SNOOZE_MS,
  type DeckWorkspace,
  type PaneView
} from './helpers'
export {
  DEFAULT_ATTENTION,
  DEFAULT_REMOTE,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE
} from './settings'
export type { DeckNotice } from './ui'
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
    const pane = state.workspaces.flatMap((w) => w.panes).find((p) => p.id === id)
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
