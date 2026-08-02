import { app, clipboard, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { defaultShell } from '../shell-env'

interface Deps {
  getWindow: () => BrowserWindow | null
}

/**
 * How many panes are waiting, shown where the platform puts it: a dock badge on
 * macOS and Linux, and a flashing taskbar button on Windows, which has no badge
 * of its own without an overlay icon to draw the number onto.
 */
function setBadge(win: BrowserWindow | null, count: number): void {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  if (process.platform === 'win32') {
    if (win && !win.isDestroyed() && !win.isFocused()) {
      win.flashFrame(value > 0)
    }
    return
  }
  app.setBadgeCount(value)
}

export function registerAppIpc({ getWindow }: Deps): void {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      app: app.getVersion()
    },
    homeDir: homedir(),
    defaultShell: defaultShell(),
    defaultCwd: process.env.HD_DEFAULT_CWD || homedir()
  }))

  ipcMain.handle('fs:missingDirs', (_e, paths: string[]) =>
    (paths ?? []).filter((path) => {
      try {
        return !path || !statSync(path).isDirectory()
      } catch {
        // Unreadable is as good as gone for anything about to spawn there.
        return true
      }
    })
  )

  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  // `ms-settings:` is allowed so the app can send the user to the Windows
  // microphone privacy page when capture is blocked there.
  ipcMain.on('app:openExternal', (_e, url: string) => {
    if (/^(https?|ms-settings):/.test(url)) shell.openExternal(url)
  })
  ipcMain.on('app:openPath', (_e, path: string) => shell.openPath(path))
  ipcMain.on('app:setBadge', (_e, count: number) => setBadge(getWindow(), count))

  ipcMain.handle('app:capture', async (_e, target: string) => {
    const win = getWindow()
    if (!win) return null
    const image = await win.webContents.capturePage()
    const file = resolve(target)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, image.toPNG())
    return file
  })
}
