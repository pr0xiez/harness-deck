import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscribeRequest, VoiceProvider } from '@shared/types'

const mocks = vi.hoisted(() => ({ dir: '', env: {} as NodeJS.ProcessEnv }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./shell-env', () => ({ shellEnv: () => mocks.env }))
import { keyState, setKey, transcribe } from './voice'

const request = (over: Partial<TranscribeRequest> = {}): TranscribeRequest => ({
  provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test',
  audio: new ArrayBuffer(1500), mimeType: 'audio/webm', fileName: 'test.webm', ...over
})
const fetchMock = vi.fn()

beforeEach(() => {
  mocks.dir = mkdtempSync(join(tmpdir(), 'deck-voice-test-'))
  mocks.env = { OPENAI_API_KEY: 'dummy-openai', HD_VOICE_API_KEY: 'dummy-shared' }
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => '{"text":"hello"}' })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(mocks.dir, { recursive: true, force: true })
})

describe('transcription credential destinations', () => {
  it.each([
    'https://attacker.invalid/v1', 'http://api.openai.com/v1',
    'https://api.openai.com.attacker.invalid/v1', 'https://api.openai.com:444/v1',
    'https://api.openai.com@attacker.invalid/v1', 'https://user@api.openai.com/v1',
    'http://127.0.0.1:8000/v1', 'file:///tmp/audio', 'not a URL',
    'https://api.openai.com/v1?target=other', 'https://api.openai.com/v1#other'
  ])('refuses provider credentials at %s before fetching', async (baseUrl) => {
    setKey('openai', 'dummy-stored')
    expect((await transcribe(request({ baseUrl }))).error).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['openai', 'https://api.openai.com/v1'],
    ['groq', 'https://api.groq.com/openai/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1']
  ] as const)('allows %s only on its origin and refuses redirects', async (provider, baseUrl) => {
    setKey(provider, 'dummy-stored')
    await transcribe(request({ provider, baseUrl }))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'error', headers: { Authorization: 'Bearer dummy-stored' }
    })
  })

  it('rejects unknown providers instead of falling back to another provider key', async () => {
    expect((await transcribe(request({ provider: 'unknown' as VoiceProvider }))).error).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps local custom endpoints anonymous unless a separate custom key was supplied', async () => {
    setKey('openai', 'dummy-stored')
    await transcribe(request({ provider: 'custom', baseUrl: 'http://localhost:8000/v1' }))
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  })

  it('binds custom stored keys to their origin, including port and scheme', async () => {
    const baseUrl = 'https://custom.invalid/v1'
    setKey('custom', 'dummy-custom', baseUrl)
    expect(keyState('custom', baseUrl).hasKey).toBe(true)
    await transcribe(request({ provider: 'custom', baseUrl: 'https://custom.invalid/other' }))
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dummy-custom')
    for (const other of ['https://different.invalid/v1', 'https://custom.invalid:444/v1']) {
      expect(keyState('custom', other).hasKey).toBe(false)
      await transcribe(request({ provider: 'custom', baseUrl: other }))
      expect(fetchMock.mock.calls.at(-1)![1].headers).toBeUndefined()
    }
  })

  it('requires old unbound custom keys to be saved again', async () => {
    writeFileSync(join(mocks.dir, 'voice-keys.json'), JSON.stringify({
      custom: { encrypted: false, value: Buffer.from('old-key').toString('base64') }
    }))
    await transcribe(request({ provider: 'custom', baseUrl: 'https://custom.invalid/v1' }))
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  })

  it('requires a separate custom environment key and matching configured origin', async () => {
    mocks.env.HD_CUSTOM_VOICE_API_KEY = 'dummy-custom-env'
    mocks.env.HD_CUSTOM_VOICE_BASE_URL = 'https://custom.invalid/v1'
    await transcribe(request({ provider: 'custom', baseUrl: 'https://custom.invalid/v2' }))
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dummy-custom-env')
    await transcribe(request({ provider: 'custom', baseUrl: 'https://other.invalid/v1' }))
    expect(fetchMock.mock.calls[1][1].headers).toBeUndefined()
  })

  it('refuses non-local plaintext custom endpoints', async () => {
    expect((await transcribe(request({ provider: 'custom', baseUrl: 'http://custom.invalid/v1' }))).error).toContain('HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
