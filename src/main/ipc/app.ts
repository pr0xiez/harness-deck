import { app, clipboard, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { IPC } from '@shared/ipc'
import { captureTarget } from '../debug'
import type { PasteGate } from '../paste-gate'
import { resolveWithin } from '../paths'
import { defaultShell } from '../shell-env'

interface Deps {
  getWindow: () => BrowserWindow | null
  /** Records the paste chord off real keyboard input; gates `clipboard:read`. */
  pasteGate: PasteGate
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

export function registerAppIpc({ getWindow, pasteGate }: Deps): void {
  ipcMain.handle(IPC.appInfo, () => ({
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

  ipcMain.handle(IPC.fsMissingDirs, (_e, paths: string[]) =>
    (paths ?? []).filter((path) => {
      try {
        return !path || !statSync(path).isDirectory()
      } catch {
        // Unreadable is as good as gone for anything about to spawn there.
        return true
      }
    })
  )

  // Only within a moment of a real paste chord (recorded in createWindow). The
  // permission handler already refuses the web clipboard-read permission; a
  // channel that answered unconditionally was a side door around it. An
  // unprompted caller gets an empty string, not what the user last copied.
  ipcMain.handle(IPC.clipboardRead, () => (pasteGate.allows() ? clipboard.readText() : ''))
  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => clipboard.writeText(text))

  // `ms-settings:` is allowed so the app can send the user to the Windows
  // microphone privacy page when capture is blocked there.
  ipcMain.on(IPC.appOpenExternal, (_e, url: string) => {
    if (/^(https?|ms-settings):/.test(url)) shell.openExternal(url)
  })
  ipcMain.on(IPC.appOpenPath, (_e, path: string) => shell.openPath(path))
  ipcMain.on(IPC.appSetBadge, (_e, count: number) => setBadge(getWindow(), count))

  // The channel exists solely for the --capture dev flow (see the flag table
  // in debug.ts), so in a normal run it is never registered and a renderer that
  // calls it gets a rejection, not a file. Even in a capture run the renderer
  // only names a file inside the directory the CLI flag already chose — its
  // string used to be resolved and written verbatim, which let any code in
  // the renderer overwrite whatever the OS user could (issue #29).
  if (captureTarget) {
    const captureDir = dirname(resolve(captureTarget))
    ipcMain.handle(IPC.appCapture, async (_e, target: string) => {
      const win = getWindow()
      if (!win) return null
      const file = resolveWithin(captureDir, target)
      if (!file) {
        console.warn(`[capture] refused a path outside ${captureDir}: ${target}`)
        return null
      }
      const image = await win.webContents.capturePage()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, image.toPNG())
      return file
    })
  }
}
