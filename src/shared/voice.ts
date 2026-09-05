/**
 * Speech-to-text services the app can talk to.
 *
 * Two request shapes exist. Most services expose OpenAI's
 * `/audio/transcriptions`, which takes a compressed file — one code path covers
 * a hosted service and a Whisper server on localhost. OpenRouter has no
 * transcription endpoint, so audio goes to a multimodal *chat* model instead,
 * base64-encoded; those models want WAV rather than webm/opus.
 */

import type { VoiceProvider, VoiceSettings } from './types'

export interface VoiceProviderInfo {
  id: VoiceProvider
  name: string
  /** Default endpoint root; empty means the user must supply one. */
  baseUrl: string
  /** Default model, used when the settings field is blank. */
  model: string
  /** Suggestions offered in the settings dialog. */
  models: string[]
  /** Which endpoint and body shape this service speaks. */
  api: 'transcriptions' | 'chat'
  /** Recording format the service accepts. */
  audio: 'webm' | 'wav'
  /** Environment variables checked for a key, in order, before the stored one. */
  envVars: string[]
  hint: string
  keysUrl?: string
}

export const VOICE_PROVIDERS: VoiceProviderInfo[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash-lite',
    models: [
      'google/gemini-2.5-flash-lite',
      'google/gemini-3.5-flash-lite',
      'google/gemini-2.5-flash',
      'openai/gpt-audio-mini'
    ],
    api: 'chat',
    audio: 'wav',
    envVars: ['HD_VOICE_API_KEY', 'OPENROUTER_API_KEY'],
    hint: 'Spends OpenRouter credits — a listening chat model, about $0.0001 a prompt.',
    keysUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    api: 'transcriptions',
    audio: 'webm',
    envVars: ['HD_VOICE_API_KEY', 'OPENAI_API_KEY'],
    hint: 'Purpose-built transcription; the mini model is the fastest of the three.',
    keysUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
    api: 'transcriptions',
    audio: 'webm',
    envVars: ['HD_VOICE_API_KEY', 'GROQ_API_KEY'],
    hint: 'Whisper on Groq hardware — usually the quickest turnaround.',
    keysUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: 'whisper-1',
    models: [],
    api: 'transcriptions',
    audio: 'webm',
    envVars: ['HD_CUSTOM_VOICE_API_KEY'],
    hint: 'Anything serving /audio/transcriptions — e.g. http://127.0.0.1:8000/v1 for a local Whisper.'
  }
]

export function voiceProvider(id: VoiceProvider): VoiceProviderInfo {
  return VOICE_PROVIDERS.find((p) => p.id === id) ?? VOICE_PROVIDERS[0]
}

/** Endpoint root for these settings, trailing slashes trimmed. */
export function voiceBaseUrl(voice: VoiceSettings): string {
  const base = voice.baseUrl.trim() || voiceProvider(voice.provider).baseUrl
  return base.replace(/\/+$/, '')
}

export function voiceModel(voice: VoiceSettings): string {
  return voice.model.trim() || voiceProvider(voice.provider).model
}
