import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PersistedState } from '@shared/types'
import { sanitizeState } from './state-schema'

export const STATE_VERSION = 1

/**
 * Where the app keeps its state, absent a caller that says otherwise.
 *
 * Read per call rather than captured, for the same reason index.ts builds its
 * ScrollbackStore after the app is ready: `userData` is not final at module
 * scope, and a smoke run moves it out of the way of a real profile.
 */
const userData = (): string => app.getPath('userData')

function statePath(baseDir: string): string {
  return join(baseDir, 'workspaces.json')
}

/**
 * `baseDir` is injectable so the unit tests can drive a real directory through
 * this: they run in plain Node, where `app` exists only as a string (see
 * vitest.config.ts). Omitting it is the app's own case, and still asks
 * electron — this is the crash-recovery path, so where it reads and writes in
 * production is exactly what it was before the seam existed.
 *
 * Parsing is not believing: the file is plain JSON anything with a file write
 * can shape, so both copies go through `sanitizeState` and only what survives
 * comes back. A file that parses but does not validate falls through to the
 * backup the same way a half-written one does. See state-schema.ts.
 */
export function loadState(baseDir: string = userData()): PersistedState | null {
  const file = statePath(baseDir)
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      const state = sanitizeState(JSON.parse(readFileSync(candidate, 'utf8')))
      if (state) return state
      console.error(`[store] ignoring state that failed validation at ${candidate}`)
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

export function saveState(state: PersistedState, baseDir: string = userData()): void {
  writeJsonAtomic(statePath(baseDir), { ...state, version: STATE_VERSION })
}

export function stateLocation(baseDir: string = userData()): string {
  return statePath(baseDir)
}
