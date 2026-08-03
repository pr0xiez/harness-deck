import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  TranscribeRequest,
  TranscribeResult,
  VoiceKeyState,
  VoiceProvider
} from '@shared/types'
import { voiceEndpointAllowed, voiceProvider } from '@shared/voice'
import { shellEnv } from './shell-env'

/**
 * Dictation lives in the main process for two reasons: the API key never has to
 * exist in the renderer, and the OS keychain (safeStorage) is only reachable
 * here. Audio arrives as a plain ArrayBuffer and leaves as text.
 */

const REQUEST_TIMEOUT_MS = 60_000
/** Below this the recording is a click or a stray keypress, not speech. */
const MIN_AUDIO_BYTES = 1200

interface StoredSecret {
  encrypted: boolean
  value: string
}

/** One secret per provider, so switching services keeps both keys. */
type KeyStore = Partial<Record<VoiceProvider, StoredSecret>>

function keyPath(): string {
  return join(app.getPath('userData'), 'voice-keys.json')
}

function readStore(): KeyStore {
  const file = keyPath()
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    console.error('[voice] ignoring unreadable key file:', err)
    return {}
  }
}

function storedKey(provider: VoiceProvider): { key: string; encrypted: boolean } | null {
  const entry = readStore()[provider]
  if (!entry?.value) return null
  try {
    const key = entry.encrypted
      ? safeStorage.decryptString(Buffer.from(entry.value, 'base64'))
      : Buffer.from(entry.value, 'base64').toString('utf8')
    return key ? { key, encrypted: entry.encrypted } : null
  } catch (err) {
    // Usually a keychain that moved with the profile — treat it as absent.
    console.error('[voice] could not decrypt the stored key:', err)
    return null
  }
}

/** Keys exported in the user's shell profile, so no copy needs to be stored. */
function envKey(provider: VoiceProvider): { key: string; envVar: string } | null {
  const env = shellEnv()
  for (const envVar of voiceProvider(provider).envVars) {
    const key = env[envVar]?.trim()
    if (key) return { key, envVar }
  }
  return null
}

function resolveKey(provider: VoiceProvider): string | null {
  return storedKey(provider)?.key ?? envKey(provider)?.key ?? null
}

export function keyState(provider: VoiceProvider): VoiceKeyState {
  const stored = storedKey(provider)
  if (stored) return { hasKey: true, source: 'stored', encrypted: stored.encrypted }
  const fromEnv = envKey(provider)
  if (fromEnv) return { hasKey: true, source: 'env', envVar: fromEnv.envVar }
  return { hasKey: false, source: 'none' }
}

/** Stores (or, with null, forgets) a key. Encrypted when the OS allows it. */
export function setKey(provider: VoiceProvider, key: string | null): VoiceKeyState {
  const file = keyPath()
  const trimmed = key?.trim()
  try {
    const store = readStore()
    if (!trimmed) {
      delete store[provider]
    } else {
      const encrypted = safeStorage.isEncryptionAvailable()
      store[provider] = {
        encrypted,
        value: encrypted
          ? safeStorage.encryptString(trimmed).toString('base64')
          : Buffer.from(trimmed, 'utf8').toString('base64')
      }
    }
    if (!Object.keys(store).length) {
      if (existsSync(file)) rmSync(file)
    } else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 })
    }
  } catch (err) {
    console.error('[voice] failed to store the key:', err)
  }
  return keyState(provider)
}

function extractError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message ?? '')
    if (message) return message.slice(0, 300)
  } catch {
    /* not JSON — fall through to the raw body */
  }
  const text = body.replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 200)
  return `Transcription failed (HTTP ${status})`
}

/** Turns an HTTP failure into something worth showing in a 400px pill. */
function describeFailure(status: number, body: string): string {
  const detail = extractError(body, status)
  if (status === 401 || status === 403) return `Key rejected (${status}): ${detail}`
  if (status === 404) return `No transcription endpoint there (404) — check the base URL`
  if (status === 429) return `Rate limited (429): ${detail}`
  return detail
}

/** The multipart shape: OpenAI, Groq, a local Whisper server. */
function transcriptionsRequest(req: TranscribeRequest, key: string | null): [string, RequestInit] {
  const form = new FormData()
  form.append('file', new Blob([req.audio], { type: req.mimeType }), req.fileName)
  form.append('model', req.model)
  form.append('response_format', 'json')
  if (req.language) form.append('language', req.language)
  if (req.prompt) form.append('prompt', req.prompt)

  return [
    `${req.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : undefined, body: form }
  ]
}

/**
 * The chat shape, for services that only offer multimodal models. The
 * instructions matter: a chat model will happily add "Sure, here's the
 * transcription" unless told not to.
 */
function chatRequest(req: TranscribeRequest, key: string | null): [string, RequestInit] {
  const rules = [
    'You are a speech-to-text engine.',
    'Reply with the words spoken in the audio, verbatim, and nothing else:',
    'no preamble, no quotes, no translation, no commentary, no markdown.',
    'The speaker is dictating a prompt to a coding assistant, so expect',
    'programming terms, file names and command flags.',
    'Never invent, complete or paraphrase content that was not spoken.',
    'If the audio is silent, unintelligible or contains no speech,',
    'reply with an empty message rather than guessing.'
  ]
  if (req.language) rules.push(`The audio is in ${req.language}; transcribe it in that language.`)
  if (req.prompt) rules.push(`Spell these terms exactly when you hear them: ${req.prompt}.`)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = `Bearer ${key}`
  // OpenRouter shows these on the activity page; harmless elsewhere.
  headers['X-Title'] = 'Harness Deck'
  headers['HTTP-Referer'] = 'https://github.com/pr0xiez/harness-deck'

  return [
    `${req.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model,
        temperature: 0,
        messages: [
          { role: 'system', content: rules.join(' ') },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe this recording.' },
              {
                type: 'input_audio',
                input_audio: {
                  data: Buffer.from(req.audio).toString('base64'),
                  format: req.mimeType.includes('wav') ? 'wav' : 'mp3'
                }
              }
            ]
          }
        ]
      })
    }
  ]
}

/** Chat models pad and decorate; peel that off without eating real words. */
function cleanChatReply(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-z]*\s*|\s*```$/gi, '').trim()
  text = text.replace(/^(?:transcript|transcription)\s*:\s*/i, '').trim()
  if (text.length > 1 && /^["'“](.*)["'”]$/s.test(text)) {
    text = text.replace(/^["'“]|["'”]$/g, '').trim()
  }
  // Models answer these instead of staying quiet when a clip has no speech.
  if (/^\(?\s*(empty|silence|no speech(?: detected)?|inaudible)\s*\)?[.!]?$/i.test(text)) return ''
  return text
}

export async function transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
  const started = Date.now()
  const done = (result: Omit<TranscribeResult, 'ms'>): TranscribeResult => ({
    ...result,
    ms: Date.now() - started
  })

  if (!/^https?:\/\//i.test(req.baseUrl)) {
    return done({ error: 'No transcription URL configured — set one in Settings › Voice input.' })
  }
  // The renderer names both the provider and the URL, so a compromised
  // renderer could pair a real key with an attacker's endpoint. Refuse before
  // any key is resolved: a hosted provider's key only ever goes to that
  // provider's own host, over https.
  if (!voiceEndpointAllowed(req.provider, req.baseUrl)) {
    const info = voiceProvider(req.provider)
    return done({
      error: info.baseUrl
        ? `Refusing to contact ${req.baseUrl} — ${info.name} requests only go to ${info.baseUrl}.`
        : `${req.baseUrl} is not a usable endpoint URL — check Settings › Voice input.`
    })
  }
  if (req.audio.byteLength < MIN_AUDIO_BYTES) {
    return done({ error: 'That was too short to transcribe.' })
  }

  const key = resolveKey(req.provider)
  if (!key && req.provider !== 'custom') {
    return done({ error: 'No API key for transcription — add one in Settings › Voice input.' })
  }

  const chat = voiceProvider(req.provider).api === 'chat'
  const [url, init] = chat ? chatRequest(req, key) : transcriptionsRequest(req, key)

  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    const body = await response.text()
    if (!response.ok) {
      return done({ error: describeFailure(response.status, body), status: response.status })
    }

    if (chat) {
      let reply = ''
      try {
        const parsed = JSON.parse(body) as {
          choices?: Array<{ message?: { content?: string } }>
          error?: { message?: string }
        }
        // OpenRouter can answer 200 with an error body when a model is unhappy.
        if (parsed.error?.message) {
          return done({ error: parsed.error.message.slice(0, 300), status: response.status })
        }
        reply = parsed.choices?.[0]?.message?.content ?? ''
      } catch {
        return done({ error: 'The service answered with something that was not JSON.' })
      }
      return done({ text: cleanChatReply(reply), status: response.status })
    }

    let text = ''
    try {
      text = ((JSON.parse(body) as { text?: string }).text ?? '').trim()
    } catch {
      // A few servers answer text/plain even when asked for JSON.
      text = body.trim()
    }
    return done({ text, status: response.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/timed? ?out|abort/i.test(message)) {
      return done({ error: `Transcription timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` })
    }
    // "fetch failed" on its own says nothing; the cause carries the real reason.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    return done({ error: `Could not reach ${req.baseUrl} — ${cause?.code ?? cause?.message ?? message}` })
  }
}
