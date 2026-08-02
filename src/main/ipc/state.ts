import { ipcMain } from 'electron'
import type { PersistedState } from '@shared/types'
import { loadState, saveState, stateLocation } from '../store'

interface Deps {
  /** Keeps the main-process quiet timer in step with the renderer's settings. */
  rememberAttention: (state: PersistedState | null) => void
}

export function registerStateIpc({ rememberAttention }: Deps): void {
  ipcMain.handle('state:load', () => {
    const state = loadState()
    rememberAttention(state)
    return state
  })
  ipcMain.on('state:save', (_e, state: PersistedState) => {
    rememberAttention(state)
    saveState(state)
  })
  ipcMain.handle('state:location', () => stateLocation())
}
