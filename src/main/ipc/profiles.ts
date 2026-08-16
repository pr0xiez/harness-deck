import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { SavedProfile } from '@shared/types'
import { detectProfiles } from '../profiles'
import { removeCustomProfile, saveCustomProfile } from '../profiles-store'

export function registerProfilesIpc(): void {
  ipcMain.handle(IPC.profilesList, () => detectProfiles())
  // Both hand back the whole merged list: the renderer keeps one array of
  // profiles, so a save that returned only the saved ones would leave it to
  // re-merge what detectProfiles() has already done.
  ipcMain.handle(IPC.profilesSaveCustom, (_e, profile: SavedProfile) => {
    saveCustomProfile(profile)
    return detectProfiles()
  })
  ipcMain.handle(IPC.profilesRemoveCustom, (_e, id: string) => {
    removeCustomProfile(id)
    return detectProfiles()
  })
}
