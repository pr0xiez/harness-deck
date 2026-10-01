import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceKeyState, PaneSpec } from '@shared/types'
import type { OpenRouterModels } from '@shared/openrouter'
import { routeOpenRouter } from '@shared/openrouter'
import { shellEnv } from './shell-env'

const keyFile = () => join(app.getPath('userData'), 'agent-openrouter-key.json')

function storedKey(): string | null {
  const file = keyFile()
  if (!existsSync(file)) return null
  let entry: { version: number; value: string }
  try {
    entry = JSON.parse(readFileSync(file, 'utf8'))
    if (!entry || entry.version !== 1 || typeof entry.value !== 'string') throw new Error()
  } catch { throw new Error('Unreadable OpenRouter key file. Save the key again in Settings.') }
  try { return safeStorage.decryptString(Buffer.from(entry.value, 'base64')) }
  catch { throw new Error('Cannot decrypt the OpenRouter key. Save it again in Settings on this machine.') }
}

export function openRouterKeyState(): VoiceKeyState {
  // Status never needs to decrypt the key or send it to the renderer.
  if (existsSync(keyFile())) return { hasKey: true, source: 'stored', encrypted: true }
  if (shellEnv().OPENROUTER_API_KEY?.trim()) return { hasKey: true, source: 'env', envVar: 'OPENROUTER_API_KEY' }
  return { hasKey: false, source: 'none' }
}

export function setOpenRouterKey(key: string | null): VoiceKeyState {
  if (key !== null && typeof key !== 'string') throw new Error('Invalid API key.')
  const file = keyFile()
  const value = key?.trim()
  if (!value) rmSync(file, { force: true })
  else {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('No OS keychain is available. Export OPENROUTER_API_KEY in your shell instead.')
    }
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file + '.tmp', JSON.stringify({ version: 1,
      value: safeStorage.encryptString(value).toString('base64') }), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }
  return openRouterKeyState()
}

export function prepareOpenRouter(spec: PaneSpec): PaneSpec {
  if (!spec.openRouter) return spec
  const env = shellEnv()
  return routeOpenRouter(spec, storedKey() ?? env.OPENROUTER_API_KEY?.trim() ?? null,
    process.platform, env.WSLENV)
}

/** Main-process consumers only; the key never crosses the preload bridge. */
export function personalOpenRouterKey(): string | null {
  return storedKey() ?? shellEnv().OPENROUTER_API_KEY?.trim() ?? null
}

export async function openRouterModels(): Promise<OpenRouterModels> {
  try {
    // Public catalog: no credential, inference, or spend. Fetch only on explicit UI action.
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      redirect: 'error', signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) throw new Error(`OpenRouter model catalog returned HTTP ${response.status}.`)
    const data = await response.json() as { data: Array<{ id: string; supported_parameters?: string[] }> }
    if (!Array.isArray(data.data)) throw new Error('OpenRouter returned an invalid model catalog.')
    const models = data.data.filter(m => typeof m.id === 'string' &&
      /^(anthropic|openai)\//.test(m.id) && m.supported_parameters?.includes('tools'))
      .map(m => m.id).sort()
    return { models }
  } catch {
    return { models: [], error: 'Could not load OpenRouter models. You can enter a model ID manually.' }
  }
}
