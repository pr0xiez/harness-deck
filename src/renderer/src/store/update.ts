import type { StateCreator } from 'zustand'
import type { UpdateState } from '@shared/types'
import { api, isLive } from './helpers'
import type { DeckState } from './types'

export interface UpdateSlice {
  update: UpdateState | null
  /** Version whose toast the user waved off; the title bar still offers it. */
  updateDismissed: string | null
  /** Why the last install attempt did not get off the ground. */
  updateError: string | null
  updateInstalling: boolean

  setUpdate: (update: UpdateState) => void
  checkForUpdate: () => Promise<void>
  /** Confirms if panes are live, then hands over to the installer. */
  installUpdate: () => Promise<void>
  dismissUpdate: () => void
  showUpdate: () => void
}

export const createUpdateSlice: StateCreator<DeckState, [], [], UpdateSlice> = (set, get) => ({
  update: null,
  updateDismissed: null,
  updateError: null,
  updateInstalling: false,

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

  showUpdate: () => set({ updateDismissed: null })
})
