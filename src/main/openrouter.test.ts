import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ dir: '', env: {} as NodeJS.ProcessEnv, encrypted: true }))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.dir },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encrypted,
    getSelectedStorageBackend: () => mocks.encrypted ? 'gnome_libsecret' : 'basic_text',
    encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
    decryptString: (value: Buffer) => [...value.toString()].reverse().join('')
  }
}))
vi.mock('./shell-env', () => ({ shellEnv: () => mocks.env }))
import { openRouterKeyState, setOpenRouterKey, prepareOpenRouter, openRouterModels } from './openrouter'

beforeEach(() => {
  mocks.dir = mkdtempSync(join(tmpdir(), 'hd-router-keys-'))
  mocks.env = {}; mocks.encrypted = true
})
afterEach(() => { rmSync(mocks.dir, { recursive: true, force: true }); vi.unstubAllGlobals() })

describe('agent credentials and model discovery', () => {
  it('stores an encrypted key separately and exposes only status', () => {
    const key = 'dummy-router-key'
    expect(setOpenRouterKey(key)).toEqual({ hasKey: true, source: 'stored', encrypted: true })
    expect(readFileSync(join(mocks.dir, 'agent-openrouter-key.json'), 'utf8')).not.toContain(key)
    expect(JSON.stringify(openRouterKeyState())).not.toContain(key)
    const routed = prepareOpenRouter({ id: 'a', command: 'claude', args: [], cwd: mocks.dir,
      openRouter: { model: 'anthropic/test' } })
    expect(routed.env!.ANTHROPIC_AUTH_TOKEN).toBe(key)
    expect(setOpenRouterKey(null).hasKey).toBe(false)
  })
  it('uses exported keys and does not decrypt stored credentials for a direct pane', () => {
    mocks.env.OPENROUTER_API_KEY = 'env-key'
    expect(openRouterKeyState()).toMatchObject({ source: 'env' })
    const spec = { id: 'a', command: 'codex', args: [], cwd: mocks.dir }
    expect(prepareOpenRouter(spec)).toBe(spec)
  })
  it('refuses to store plaintext when a keychain is unavailable', () => {
    mocks.encrypted = false
    expect(() => setOpenRouterKey('dummy')).toThrow('OS keychain')
    expect(openRouterKeyState().hasKey).toBe(false)
  })
  it('loads the public tool-capable Anthropic/OpenAI catalog without credentials or inference', async () => {
    mocks.env.OPENROUTER_API_KEY = 'not-for-catalog'
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: [
      { id: 'openai/a', supported_parameters: ['tools'] },
      { id: 'anthropic/b', supported_parameters: ['tools'] },
      { id: 'openai/no-tools', supported_parameters: [] },
      { id: 'other/c', supported_parameters: ['tools'] }
    ] }) }))
    vi.stubGlobal('fetch', fetcher)
    expect(await openRouterModels()).toEqual({ models: ['anthropic/b', 'openai/a'] })
    expect(fetcher.mock.calls[0]).toEqual(['https://openrouter.ai/api/v1/models',
      expect.objectContaining({ redirect: 'error' })])
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('not-for-catalog')
  })
  it('keeps manual model input available offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await openRouterModels()).toMatchObject({ models: [], error: expect.any(String) })
  })
})
