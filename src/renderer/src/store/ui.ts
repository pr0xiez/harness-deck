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

export interface UiSlice {
  ui: UiState
  /** Shown bottom-right until waved off. Never saved. */
  notice: DeckNotice | null

  setUi: (patch: Partial<UiState>) => void
  setNotice: (notice: DeckNotice | null) => void
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
    compare: false,
    pendingInsert: null,
    waitingQueue: false,
    workspaceDialogFor: null,
    shipFor: null
  },
  notice: null,

  setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),

  setNotice: (notice) => set({ notice })
})
