import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { DiffRequest, WorktreeRequest } from '@shared/types'
import { addWorktree, diffRange, diffStat, info as repoInfo, removeWorktree } from '../git'
import { detectForge } from '../profiles'

export function registerGitIpc(): void {
  ipcMain.handle(IPC.gitInfo, (_e, dir: string) => repoInfo(dir))
  ipcMain.handle(IPC.gitAddWorktree, (_e, req: WorktreeRequest) => addWorktree(req))
  ipcMain.handle(IPC.gitRemoveWorktree, (_e, path: string) => removeWorktree(path))
  ipcMain.handle(IPC.gitDiffStat, (_e, dir: string) => diffStat(dir))
  ipcMain.handle(IPC.gitDiffRange, (_e, req: DiffRequest) => diffRange(req))
  ipcMain.handle(IPC.gitForge, () => detectForge())
  // Stubs the later items replace — registered now so four parallel branches
  // build on a settled surface instead of each adding its own. See HD-14.
  ipcMain.handle(IPC.gitCheckpoint, () => undefined)
  ipcMain.handle(IPC.gitCheckpoints, () => [])
  ipcMain.handle(IPC.gitRestoreCheckpoint, () => ({ ok: false, error: 'not implemented' }))
  ipcMain.handle(IPC.gitDropCheckpoints, () => undefined)
  ipcMain.handle(IPC.gitDeleteBranch, () => ({ ok: false, error: 'not implemented' }))
}
