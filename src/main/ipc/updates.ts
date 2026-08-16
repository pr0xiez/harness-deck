import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { UpdateChannel } from '@shared/types'
import { checkNow, currentState, install, setChannel } from '../updater'

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC.updateState, () => currentState())
  ipcMain.handle(IPC.updateCheck, () => checkNow())
  ipcMain.handle(IPC.updateSetChannel, (_e, channel: UpdateChannel) => setChannel(channel))
  ipcMain.handle(IPC.updateInstall, () => install())
}
