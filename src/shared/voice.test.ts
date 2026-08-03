import { describe, expect, it } from 'vitest'
import type { VoiceProvider, VoiceSettings } from './types'
import {
  VOICE_PROVIDERS,
  voiceBaseUrl,
  voiceEndpointAllowed,
  voiceModel,
  voiceProvider
} from './voice'

/** Settings as the dialog leaves them: every field present, most of them blank. */
const settings = (over: Partial<VoiceSettings> = {}): VoiceSettings => ({
  provider: 'openai',
  baseUrl: '',
  model: '',
  language: '',
  prompt: '',
  submit: false,
  autoStop: true,
  ...over
})

/** The ids of the entries that fail some rule — an empty list, or the culprits. */
const idsWhere = (fails: (info: (typeof VOICE_PROVIDERS)[number]) => boolean): VoiceProvider[] =>
  VOICE_PROVIDERS.filter(fails).map((info) => info.id)

describe('VOICE_PROVIDERS', () => {
  it('never lists one service twice, so the first match is the only match', () => {
    const ids = VOICE_PROVIDERS.map((info) => info.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * `voiceModel` falls back to this. A service added without one would send a
   * blank model name to the endpoint and fail at the network, a long way from
   * the omission that caused it.
   */
  it('gives every service a default model to fall back on', () => {
    expect(idsWhere((info) => !info.model)).toEqual([])
  })

  /** The custom endpoint is the only one whose address the app cannot know. */
  it('knows where every hosted service lives', () => {
    expect(idsWhere((info) => !info.baseUrl)).toEqual(['custom'])
  })

  /** An id this build does not recognise lands here, so it has to be usable. */
  it('leads with a service that works before anyone configures anything', () => {
    expect(VOICE_PROVIDERS[0].baseUrl).toBeTruthy()
    expect(VOICE_PROVIDERS[0].model).toBeTruthy()
  })
})

describe('voiceProvider', () => {
  it('finds each service the settings dialog can offer', () => {
    expect(voiceProvider('openrouter').name).toBe('OpenRouter')
    expect(voiceProvider('openai').name).toBe('OpenAI')
    expect(voiceProvider('groq').name).toBe('Groq')
    expect(voiceProvider('custom').name).toBe('Custom (OpenAI-compatible)')
  })

  /**
   * Saved settings outlive the build that wrote them. A provider renamed or
   * dropped between versions has to degrade to a working service, not to
   * `undefined` and a crash on the first property read.
   */
  it('falls back to the first service for an id it has never heard of', () => {
    expect(voiceProvider('deepgram' as VoiceProvider)).toBe(VOICE_PROVIDERS[0])
  })
})

describe('voiceBaseUrl', () => {
  it('uses the endpoint the user typed for the custom service', () => {
    const voice = settings({ provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1' })

    expect(voiceBaseUrl(voice)).toBe('http://127.0.0.1:8000/v1')
  })

  /**
   * A hosted service's key must never be aimable anywhere but its own host, so
   * an endpoint override saved for one — by an older build, or by anything
   * poking at the settings store — is ignored, not sent a key.
   */
  it('ignores a stored endpoint override for a hosted service', () => {
    const voice = settings({ provider: 'openai', baseUrl: 'https://evil.example/v1' })

    expect(voiceBaseUrl(voice)).toBe('https://api.openai.com/v1')
  })

  it('falls back to the service default when the field is left blank', () => {
    expect(voiceBaseUrl(settings({ provider: 'groq' }))).toBe('https://api.groq.com/openai/v1')
    expect(voiceBaseUrl(settings({ provider: 'openrouter' }))).toBe('https://openrouter.ai/api/v1')
  })

  /** A field cleared with the spacebar looks empty and has to behave that way. */
  it('treats a field holding only whitespace as blank', () => {
    expect(voiceBaseUrl(settings({ baseUrl: '   ' }))).toBe('https://api.openai.com/v1')
    expect(voiceBaseUrl(settings({ baseUrl: ' \t\n ' }))).toBe('https://api.openai.com/v1')
  })

  /**
   * The request path is appended with a leading slash of its own, so an address
   * pasted with one on the end would reach the service as `/v1//audio/...`.
   */
  it('trims trailing slashes, however many came with the paste', () => {
    expect(
      voiceBaseUrl(settings({ provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1/' }))
    ).toBe('http://127.0.0.1:8000/v1')
    expect(
      voiceBaseUrl(settings({ provider: 'custom', baseUrl: 'http://127.0.0.1:8000/v1///' }))
    ).toBe('http://127.0.0.1:8000/v1')
  })

  it('strips the spaces around a pasted address before the slashes', () => {
    expect(
      voiceBaseUrl(settings({ provider: 'custom', baseUrl: '  http://localhost:1234/v1//  ' }))
    ).toBe('http://localhost:1234/v1')
  })

  /** Dictation refuses to start on an empty endpoint, and this is how it knows. */
  it('has no answer for a custom endpoint nobody has filled in', () => {
    expect(voiceBaseUrl(settings({ provider: 'custom' }))).toBe('')
  })

  /** A lone slash is not an endpoint; it comes back as the blank it really is. */
  it('leaves nothing behind when the field holds only slashes', () => {
    expect(voiceBaseUrl(settings({ provider: 'custom', baseUrl: '//' }))).toBe('')
  })
})

describe('voiceEndpointAllowed', () => {
  it('lets each hosted service talk to its own endpoint', () => {
    expect(voiceEndpointAllowed('openai', 'https://api.openai.com/v1')).toBe(true)
    expect(voiceEndpointAllowed('groq', 'https://api.groq.com/openai/v1')).toBe(true)
    expect(voiceEndpointAllowed('openrouter', 'https://openrouter.ai/api/v1')).toBe(true)
  })

  /** The exfiltration in issue #17: a real provider name, an attacker's URL. */
  it('never sends a hosted service anywhere but its own host', () => {
    expect(voiceEndpointAllowed('openai', 'https://evil.example/v1')).toBe(false)
    expect(voiceEndpointAllowed('groq', 'https://attacker.test/openai/v1')).toBe(false)
    expect(voiceEndpointAllowed('openrouter', 'http://127.0.0.1:8000/v1')).toBe(false)
  })

  /** Substring checks pass both of these; a parsed host comparison passes neither. */
  it('is not fooled by look-alike hosts or the real host in a query string', () => {
    expect(voiceEndpointAllowed('openai', 'https://api.openai.com.evil.example/v1')).toBe(false)
    expect(voiceEndpointAllowed('openai', 'https://evil.example/?x=api.openai.com')).toBe(false)
  })

  /** Plain http to the right host still hands the key to whoever is listening. */
  it('requires https for a hosted service', () => {
    expect(voiceEndpointAllowed('openai', 'http://api.openai.com/v1')).toBe(false)
  })

  /** A port nobody expects is a different server, even on the right hostname. */
  it('rejects a hosted endpoint on an unexpected port', () => {
    expect(voiceEndpointAllowed('openai', 'https://api.openai.com:8443/v1')).toBe(false)
  })

  /** The custom service is the one place a user-supplied address belongs. */
  it('lets the custom service reach any http(s) address', () => {
    expect(voiceEndpointAllowed('custom', 'http://127.0.0.1:8000/v1')).toBe(true)
    expect(voiceEndpointAllowed('custom', 'https://whisper.internal.example/v1')).toBe(true)
  })

  it('rejects what does not parse as an http(s) URL at all', () => {
    expect(voiceEndpointAllowed('custom', '')).toBe(false)
    expect(voiceEndpointAllowed('custom', 'not a url')).toBe(false)
    expect(voiceEndpointAllowed('custom', 'file:///etc/passwd')).toBe(false)
    expect(voiceEndpointAllowed('openai', '')).toBe(false)
  })

  /**
   * An id this build has never heard of resolves to the fallback service, so
   * its key checks against that service's host — never against nothing.
   */
  it('holds an unknown service id to the fallback host', () => {
    expect(voiceEndpointAllowed('deepgram' as VoiceProvider, 'https://evil.example/v1')).toBe(false)
    expect(
      voiceEndpointAllowed('deepgram' as VoiceProvider, 'https://openrouter.ai/api/v1')
    ).toBe(true)
  })
})

describe('voiceModel', () => {
  it('prefers the model the user typed over the service default', () => {
    expect(voiceModel(settings({ provider: 'openai', model: 'whisper-1' }))).toBe('whisper-1')
  })

  it('falls back to the service default when the field is left blank', () => {
    expect(voiceModel(settings({ provider: 'openai' }))).toBe('gpt-4o-mini-transcribe')
    expect(voiceModel(settings({ provider: 'openrouter' }))).toBe('google/gemini-2.5-flash-lite')
  })

  it('treats a field holding only whitespace as blank', () => {
    expect(voiceModel(settings({ provider: 'groq', model: '   ' }))).toBe('whisper-large-v3-turbo')
  })

  /** A model name copied out of a docs page tends to bring a space with it. */
  it('strips the spaces around a pasted name rather than sending them', () => {
    expect(voiceModel(settings({ model: ' whisper-1 ' }))).toBe('whisper-1')
  })

  /** Even settings naming a service this build dropped still have to transcribe. */
  it('still names a model when the saved service is one it does not know', () => {
    expect(voiceModel(settings({ provider: 'deepgram' as VoiceProvider }))).toBe(
      VOICE_PROVIDERS[0].model
    )
  })
})
