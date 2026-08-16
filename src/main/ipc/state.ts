import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { PersistedState } from '@shared/types'
import { loadState, saveState, stateLocation } from '../store'

interface Deps {
  /** Keeps the main-process quiet timer in step with the renderer's settings. */
  rememberAttention: (state: PersistedState | null) => void
}

export function registerStateIpc({ rememberAttention }: Deps): void {
  ipcMain.handle(IPC.stateLoad, () => {
    const state = loadState()
    rememberAttention(state)
    return state
  })
  ipcMain.on(IPC.stateSave, (_e, state: PersistedState) => {
    rememberAttention(state)
    saveState(state)
  })
  ipcMain.handle(IPC.stateLocation, () => stateLocation())
}
