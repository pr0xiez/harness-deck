import { ipcMain } from 'electron'
import type { PaneSpec } from '@shared/types'
import { stripAnsi } from '../pty'
import type { PtyManager } from '../pty'

export function registerPtyIpc(ptys: PtyManager): void {
  ipcMain.handle('pty:ensure', (_e, spec: PaneSpec, cols: number, rows: number) =>
    ptys.ensure(spec, cols, rows)
  )
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    ptys.resize(id, cols, rows)
  )
  ipcMain.on('pty:kill', (_e, id: string) => ptys.kill(id))
  ipcMain.on('pty:dispose', (_e, id: string) => ptys.dispose(id))
  ipcMain.handle('pty:status', (_e, id: string) => ptys.status(id))
  ipcMain.handle('pty:running', () => ptys.runningIds())
  ipcMain.handle('pty:transcript', (_e, id: string, strip?: boolean) => {
    const text = ptys.transcript(id)
    return strip ? stripAnsi(text) : text
  })
}
