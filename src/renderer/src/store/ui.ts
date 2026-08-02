import type { StateCreator } from 'zustand'
import type { DeckState } from './types'

export interface UiState {
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

export interface UiSlice {
  ui: UiState

  setUi: (patch: Partial<UiState>) => void
}

export const createUiSlice: StateCreator<DeckState, [], [], UiSlice> = (set, get) => ({
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

  setUi: (patch) => set({ ui: { ...get().ui, ...patch } })
})
