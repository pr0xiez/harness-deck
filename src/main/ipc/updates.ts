import { ipcMain } from 'electron'
import type { UpdateChannel } from '@shared/types'
import { checkNow, currentState, install, setChannel } from '../updater'

export function registerUpdateIpc(): void {
  ipcMain.handle('update:state', () => currentState())
  ipcMain.handle('update:check', () => checkNow())
  ipcMain.handle('update:setChannel', (_e, channel: UpdateChannel) => setChannel(channel))
  ipcMain.handle('update:install', () => install())
}
