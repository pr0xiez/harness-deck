import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `envKey` is the half of issue #17's fix this suite can reach without an
 * Electron runtime: `resolveKey` also checks the OS-keychain-backed store
 * (`storedKey`), which calls `app.getPath('userData')` and so needs a real
 * `electron` — see vitest.config.ts. `envKey` only reads `shellEnv()`, which
 * this file mocks, so it exercises the exact question issue #17 reopened:
 * which environment variable, if any, may hand a key to which provider.
 *
 * shared/voice.test.ts checks the data side of the same fix (`custom`'s
 * `envVars` is empty); this checks the main-process side reads that list
 * rather than reaching for `HD_VOICE_API_KEY` on its own.
 */

vi.mock('./shell-env', () => ({ shellEnv: () => mockedEnv }))

let mockedEnv: NodeJS.ProcessEnv = {}

afterEach(() => {
  mockedEnv = {}
  vi.resetModules()
})

describe('envKey', () => {
  it('never hands the custom service a key, however the environment is set', async () => {
    mockedEnv = { HD_VOICE_API_KEY: 'sk-leaked', OPENAI_API_KEY: 'sk-also-leaked' }
    const { envKey } = await import('./voice')

    expect(envKey('custom')).toBeNull()
  })

  it('reads HD_VOICE_API_KEY for a hosted service when nothing more specific is set', async () => {
    mockedEnv = { HD_VOICE_API_KEY: 'sk-generic' }
    const { envKey } = await import('./voice')

    expect(envKey('openai')).toEqual({ key: 'sk-generic', envVar: 'HD_VOICE_API_KEY' })
  })

  it('falls back to the provider-specific variable when the generic one is unset', async () => {
    mockedEnv = { GROQ_API_KEY: 'sk-groq' }
    const { envKey } = await import('./voice')

    expect(envKey('groq')).toEqual({ key: 'sk-groq', envVar: 'GROQ_API_KEY' })
  })

  it('finds nothing for a hosted service when the environment is empty', async () => {
    mockedEnv = {}
    const { envKey } = await import('./voice')

    expect(envKey('openrouter')).toBeNull()
  })
})
