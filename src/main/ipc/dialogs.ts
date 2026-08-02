import { app, dialog, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SaveTextRequest, SaveTextResult } from '@shared/types'

interface Deps {
  getWindow: () => BrowserWindow | null
}

/** Where a save dialog opens. Downloads is not guaranteed to resolve on Linux. */
function saveDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return homedir()
  }
}

export function registerDialogIpc({ getWindow }: Deps): void {
  ipcMain.handle('dialog:pickDirectory', async (_e, current?: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a working directory',
      defaultPath: current || homedir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('dialog:confirm', async (_e, options: { title: string; message: string; detail?: string; confirmLabel?: string }) => {
    const win = getWindow()
    if (!win) return false
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [options.confirmLabel || 'Confirm', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: options.title,
      message: options.message,
      detail: options.detail,
      noLink: true
    })
    return response === 0
  })

  ipcMain.handle('dialog:saveText', async (_e, req: SaveTextRequest): Promise<SaveTextResult> => {
    const win = getWindow()
    if (!win) return { ok: false, error: 'No window to hang the dialog off.' }
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Save transcript',
        defaultPath: join(saveDir(), req.defaultName),
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      // An empty string is a legitimate transcript — a pane that never ran.
      writeFileSync(filePath, req.text ?? '', 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
