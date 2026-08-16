import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { RemoteStatus } from '@shared/types'

/**
 * Deck Remote is stubs until HD-21 builds the server. Off is the whole truth:
 * no socket exists — the README's nothing-reaches-the-network promise extends
 * to listening.
 */
const REMOTE_OFF: RemoteStatus = {
  enabled: false,
  url: null,
  lan: false,
  allowTyping: false,
  clients: 0
}

export function registerRemoteIpc(): void {
  ipcMain.handle(IPC.remoteStatus, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetEnabled, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetLan, () => REMOTE_OFF)
  ipcMain.handle(IPC.remoteSetAllowTyping, () => REMOTE_OFF)
}
