import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PersistedState, SaveStateResult } from '@shared/types'
import { isAppWorktree } from './repo-registry'

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
      if (parsed && Array.isArray(parsed.workspaces)) return scrubWorktrees(parsed)
    } catch (err) {
      console.error(`[store] ignoring unreadable state at ${candidate}:`, err)
    }
  }
  return null
}

/**
 * A worktree the app created always lives under a `.harness-deck` segment, and
 * a state file is not trusted to say otherwise: `pane.worktree` is what feeds
 * the delete-confirm flow, so a tampered workspaces.json pointing it anywhere
 * else would put somebody's real folder behind that button. See issue #48.
 */
function scrubWorktrees(state: PersistedState): PersistedState {
  for (const workspace of state.workspaces) {
    for (const pane of workspace.panes ?? []) {
      if (pane.worktree && !isAppWorktree(pane.worktree)) {
        console.warn(`[store] dropping worktree outside the app's convention: ${pane.worktree}`)
        delete pane.worktree
      }
    }
  }
  return state
}

/**
 * Writes via a temp file + rename so a crash mid-write can't corrupt state.
 *
 * A failure is reported rather than thrown: every caller is a menu command or
 * an IPC handler, and a throw would take the app down over a file it can say
 * something about instead. The result carries the reason so the renderer can
 * put it in front of the user (issue #26) — before it did, a full disk lost a
 * whole session of edits with nothing but a console line in the main process.
 */
export function writeJsonAtomic(file: string, value: unknown): SaveStateResult {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    console.error(`[store] failed to write ${file}:`, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function saveState(state: PersistedState, baseDir: string = userData()): SaveStateResult {
  return writeJsonAtomic(statePath(baseDir), { ...state, version: STATE_VERSION })
}

export function stateLocation(baseDir: string = userData()): string {
  return statePath(baseDir)
}
