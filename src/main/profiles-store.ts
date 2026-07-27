import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SavedProfile } from '@shared/types'
import { writeJsonAtomic } from './store'

/**
 * The launchers the user saved, kept beside workspaces.json and merged into the
 * detected list by `detectProfiles()`. Anything in here — including `env` — is
 * plain text on disk; the dialog says so, and secrets belong elsewhere.
 */
function customPath(): string {
  return join(app.getPath('userData'), 'custom-profiles.json')
}

/** The file is user-editable, so a half-written entry must not take the app down. */
function isSaved(value: unknown): value is SavedProfile {
  const p = value as SavedProfile | null
  return Boolean(p && typeof p.id === 'string' && typeof p.command === 'string')
}

function clean(profile: SavedProfile): SavedProfile {
  const env = Object.entries(profile.env ?? {}).filter(([key]) => key.trim())
  return {
    id: profile.id,
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

export function loadCustomProfiles(): SavedProfile[] {
  const file = customPath()
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
export function saveCustomProfile(profile: SavedProfile): SavedProfile[] {
  const list = loadCustomProfiles()
  const index = list.findIndex((p) => p.id === profile.id)
  const next = [...list]
  if (index >= 0) next[index] = clean(profile)
  else next.push(clean(profile))
  writeJsonAtomic(customPath(), next)
  return next
}

export function removeCustomProfile(id: string): SavedProfile[] {
  const next = loadCustomProfiles().filter((p) => p.id !== id)
  writeJsonAtomic(customPath(), next)
  return next
}
