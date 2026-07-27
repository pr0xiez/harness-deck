import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PersistedState } from '@shared/types'

export const STATE_VERSION = 1

function statePath(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

export function loadState(): PersistedState | null {
  const file = statePath()
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as PersistedState
      if (parsed && Array.isArray(parsed.workspaces)) return parsed
    } catch (err) {
      console.error(`[store] ignoring unreadable state at ${candidate}:`, err)
    }
  }
  return null
}

/** Writes via a temp file + rename so a crash mid-write can't corrupt state. */
export function writeJsonAtomic(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error(`[store] failed to write ${file}:`, err)
  }
}

export function saveState(state: PersistedState): void {
  writeJsonAtomic(statePath(), { ...state, version: STATE_VERSION })
}

export function stateLocation(): string {
  return statePath()
}
