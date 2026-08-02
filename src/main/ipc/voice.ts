import { ipcMain, systemPreferences } from 'electron'
import type { TranscribeRequest, VoiceProvider } from '@shared/types'
import { keyState, setKey, transcribe } from '../voice'

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:keyState', (_e, provider: VoiceProvider) => keyState(provider))
  ipcMain.handle('voice:setKey', (_e, provider: VoiceProvider, key: string | null) =>
    setKey(provider, key)
  )
  ipcMain.handle('voice:transcribe', (_e, req: TranscribeRequest) => transcribe(req))
  ipcMain.handle('voice:micAccess', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
}
