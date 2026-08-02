import type { StateCreator } from 'zustand'
import type { AttentionSettings, Settings, VoiceSettings } from '@shared/types'
import { MONO_STACK } from '../theme'
import type { DeckState } from './types'

export const DEFAULT_VOICE: VoiceSettings = {
  provider: 'openrouter',
  baseUrl: '',
  model: '',
  language: '',
  prompt: '',
  submit: false,
  autoStop: true
}

export const DEFAULT_ATTENTION: AttentionSettings = {
  quietMs: 2500,
  notify: true,
  badge: true
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: MONO_STACK,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 8000,
  copyOnSelect: false,
  confirmCloseRunning: true,
  autoStartPanes: true,
  defaultCwd: '',
  bellNotifications: true,
  sidebarCollapsed: false,
  voice: DEFAULT_VOICE,
  attention: DEFAULT_ATTENTION,
  // Nothing reaches the network until this is changed by hand.
  updateChannel: 'local',
  broadcastHistory: [],
  broadcastSnippets: []
}

/** How far back ↑ reaches in the broadcast box before prompts are forgotten. */
const BROADCAST_HISTORY = 50

export interface SettingsSlice {
  settings: Settings

  updateSettings: (patch: Partial<Settings>) => void
  updateVoice: (patch: Partial<VoiceSettings>) => void
  updateAttention: (patch: Partial<AttentionSettings>) => void
  /** Files a sent prompt at the front of the broadcast history. */
  rememberBroadcast: (prompt: string) => void
}

export const createSettingsSlice: StateCreator<DeckState, [], [], SettingsSlice> = (set, get) => ({
  settings: DEFAULT_SETTINGS,

  updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

  updateVoice: (patch) =>
    set({ settings: { ...get().settings, voice: { ...get().settings.voice, ...patch } } }),

  updateAttention: (patch) =>
    set({ settings: { ...get().settings, attention: { ...get().settings.attention, ...patch } } }),

  rememberBroadcast: (prompt) => {
    const text = prompt.trim()
    if (!text) return
    const { settings } = get()
    // Re-sending an old prompt moves it back to the top rather than doubling it.
    const broadcastHistory = [text, ...settings.broadcastHistory.filter((p) => p !== text)]
    set({ settings: { ...settings, broadcastHistory: broadcastHistory.slice(0, BROADCAST_HISTORY) } })
  }
})
