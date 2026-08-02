import { ipcMain } from 'electron'
import type { DiffRequest, WorktreeRequest } from '@shared/types'
import { addWorktree, diffRange, diffStat, info as repoInfo, removeWorktree } from '../git'

export function registerGitIpc(): void {
  ipcMain.handle('git:info', (_e, dir: string) => repoInfo(dir))
  ipcMain.handle('git:addWorktree', (_e, req: WorktreeRequest) => addWorktree(req))
  ipcMain.handle('git:removeWorktree', (_e, path: string) => removeWorktree(path))
  ipcMain.handle('git:diffStat', (_e, dir: string) => diffStat(dir))
  ipcMain.handle('git:diffRange', (_e, req: DiffRequest) => diffRange(req))
}
