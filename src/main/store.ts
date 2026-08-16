import { app } from 'electron'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PersistedState } from '@shared/types'

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
 */
export function loadState(baseDir: string = userData()): PersistedState | null {
  const file = statePath(baseDir)
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

/**
 * Best-effort tightening to owner-only (0o600), applied *after* the file is
 * on disk rather than trusted to `mode` at open() time. `writeFileSync`'s
 * `mode` argument and `copyFileSync`'s mode preservation both only take
 * effect when the destination is created fresh — POSIX `open(2)` ignores
 * `mode` on a path that already exists — so a stale `.tmp` left by a crashed
 * older build, or an existing `.bak` from before this control existed, would
 * otherwise keep whatever looser mode it already had forever. `chmodSync`
 * applies unconditionally, which is why this exists as a separate step.
 *
 * A failure here must not take down the write it's protecting, and is
 * expected on Windows, which has no POSIX chmod semantics (same as
 * voice.ts's key store) — so it only complains.
 */
function chmodOwnerOnly(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch (err) {
    console.error(`[store] could not tighten permissions on ${path}:`, err)
  }
}

/**
 * Writes via a temp file + rename so a crash mid-write can't corrupt state.
 *
 * The files this writes carry pane env vars in plain text, so both the temp
 * file and the `.bak` sibling are chmod'd owner-only (0o600) once they're
 * written — see chmodOwnerOnly for why that has to be a separate step rather
 * than relying on `mode`/copy-preservation alone. The rename then carries
 * the temp file's already-tightened mode onto the target.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      const bak = `${file}.bak`
      copyFileSync(file, bak)
      chmodOwnerOnly(bak)
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    chmodOwnerOnly(tmp)
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
