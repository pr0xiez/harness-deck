import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { PaneSpec } from '@shared/types'
import { stripAnsi } from '../pty'
import type { PtyManager } from '../pty'

interface Deps {
  /**
   * A getter, not the manager: it is built inside `whenReady`, after these
   * handlers could be registered, and nothing stops it being rebuilt later the
   * way the window is on macOS `activate`.
   */
  getPtys: () => PtyManager
}

export function registerPtyIpc({ getPtys }: Deps): void {
  ipcMain.handle(IPC.ptyEnsure, (_e, spec: PaneSpec, cols: number, rows: number) =>
    getPtys().ensure(spec, cols, rows)
  )
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => getPtys().write(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) =>
    getPtys().resize(id, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, id: string) => getPtys().kill(id))
  ipcMain.on(IPC.ptyDispose, (_e, id: string) => getPtys().dispose(id))
  ipcMain.handle(IPC.ptyStatus, (_e, id: string) => getPtys().status(id))
  ipcMain.handle(IPC.ptyRunning, () => getPtys().runningIds())
  ipcMain.handle(IPC.ptyTranscript, (_e, id: string, strip?: boolean) => {
    const text = getPtys().transcript(id)
    return strip ? stripAnsi(text) : text
  })
  ipcMain.handle(IPC.ptyTail, (_e, id: string, lines: number) => getPtys().tail(id, lines))
}
