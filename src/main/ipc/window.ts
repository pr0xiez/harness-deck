import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

interface Deps {
  getWindow: () => BrowserWindow | null
}

export function registerWindowIpc({ getWindow }: Deps): void {
  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:toggleMaximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())
  ipcMain.handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)
}
