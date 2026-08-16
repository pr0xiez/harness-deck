import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SavedProfile } from '@shared/types'
import { writeJsonAtomic } from './store'

/**
 * The launchers the user saved, kept beside workspaces.json and merged into the
 * detected list by `detectProfiles()`. Anything in here — including `env` — is
 * plain text on disk; the dialog says so, and secrets belong elsewhere.
 *
 * `baseDir` on the exports below is the same seam store.ts gives its tests:
 * they run in plain Node, where there is no `app` to ask, and hand a real
 * directory in instead. Omitting it is the app's own case.
 */
const userData = (): string => app.getPath('userData')

function customPath(baseDir: string): string {
  return join(baseDir, 'custom-profiles.json')
}

/** The file is user-editable, so a half-written entry must not take the app down. */
function isSaved(value: unknown): value is SavedProfile {
  const p = value as SavedProfile | null
  return Boolean(p && typeof p.id === 'string' && typeof p.command === 'string')
}

/**
 * Saved ids live under `custom:`, the namespace the save dialog itself mints
 * into. Any other id — the bare reserved 'custom' above all, but also a
 * detected built-in's like 'agent:claude' — is rewritten into the namespace
 * rather than refused, for the same reason `isSaved` filters instead of
 * throwing: the file is user-editable. An id outside the namespace would
 * collide with a built-in in `detectProfiles()`, and the renderer's lookup
 * would hand that entry's `env` to every pane spawned through the built-in.
 */
function namespaced(id: string): string {
  return id.startsWith('custom:') ? id : `custom:${id}`
}

function clean(profile: SavedProfile): SavedProfile {
  const env = Object.entries(profile.env ?? {}).filter(([key]) => key.trim())
  return {
    id: namespaced(profile.id),
    name: String(profile.name || profile.command),
    command: profile.command,
    args: Array.isArray(profile.args) ? profile.args.map(String) : [],
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    ...(env.length ? { env: Object.fromEntries(env.map(([k, v]) => [k, String(v)])) } : {}),
    icon: String(profile.icon || '»').slice(0, 2),
    accent: String(profile.accent || '#94a3b8'),
    ...(profile.viaShell ? { viaShell: true } : {})
  }
}

export function loadCustomProfiles(baseDir: string = userData()): SavedProfile[] {
  const file = customPath(baseDir)
  for (const candidate of [file, `${file}.bak`]) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as unknown
      if (Array.isArray(parsed)) return parsed.filter(isSaved).map(clean)
    } catch (err) {
      console.error(`[profiles] ignoring unreadable launchers at ${candidate}:`, err)
    }
  }
  return []
}

/** Saving an id that is already there edits it in place, keeping its position. */
export function saveCustomProfile(
  profile: SavedProfile,
  baseDir: string = userData()
): SavedProfile[] {
  // Cleaned before the lookup, so an id the file spelled bare and the same id
  // arriving over IPC land on one entry rather than two.
  const cleaned = clean(profile)
  const list = loadCustomProfiles(baseDir)
  const index = list.findIndex((p) => p.id === cleaned.id)
  const next = [...list]
  if (index >= 0) next[index] = cleaned
  else next.push(cleaned)
  writeJsonAtomic(customPath(baseDir), next)
  return next
}

export function removeCustomProfile(id: string, baseDir: string = userData()): SavedProfile[] {
  const next = loadCustomProfiles(baseDir).filter((p) => p.id !== id)
  writeJsonAtomic(customPath(baseDir), next)
  return next
}
