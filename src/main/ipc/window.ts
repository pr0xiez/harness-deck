import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'

interface Deps {
  getWindow: () => BrowserWindow | null
}

export function registerWindowIpc({ getWindow }: Deps): void {
  ipcMain.on(IPC.windowMinimize, () => getWindow()?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.windowClose, () => getWindow()?.close())
  ipcMain.handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)
}
