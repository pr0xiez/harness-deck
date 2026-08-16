import { ipcMain, systemPreferences } from 'electron'
import { IPC } from '@shared/ipc'
import type { TranscribeRequest, VoiceProvider } from '@shared/types'
import { keyState, setKey, transcribe } from '../voice'

export function registerVoiceIpc(): void {
  ipcMain.handle(IPC.voiceKeyState, (_e, provider: VoiceProvider) => keyState(provider))
  ipcMain.handle(IPC.voiceSetKey, (_e, provider: VoiceProvider, key: string | null) =>
    setKey(provider, key)
  )
  ipcMain.handle(IPC.voiceTranscribe, (_e, req: TranscribeRequest) => transcribe(req))
  ipcMain.handle(IPC.voiceMicAccess, async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
}
