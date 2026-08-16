import type { AppSlice } from './app'
import type { SettingsSlice } from './settings'
import type { UiSlice } from './ui'
import type { UpdateSlice } from './update'
import type { WorkspaceSlice } from './workspace'

/** The whole deck: every slice composed into the one `useDeck` store. */
export type DeckState = AppSlice & WorkspaceSlice & SettingsSlice & UpdateSlice & UiSlice
