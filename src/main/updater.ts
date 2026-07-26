import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { InstallResult, UpdateState } from '@shared/types'

/**
 * Updates come from a release channel on this machine rather than a server:
 * `npm run release` builds an installer into `release/` and writes a manifest
 * pointing at it. The manifest lives beside the app's own state, which is the
 * one location the build script and an installed copy can both derive without
 * anything being baked in at package time.
 */
interface ReleaseManifest {
  version: string
  /** Absolute native path to the installer this release wants us to run. */
  installer: string
  /** Base64 sha512 of the installer, matching electron-builder's convention. */
  sha512?: string
  size?: number
  notes?: string
  releasedAt?: string
}

const CHECK_INTERVAL_MS = 15 * 60 * 1000
const WATCH_DEBOUNCE_MS = 400

interface Hooks {
  publish: (state: UpdateState) => void
  /** Called just before we quit for an install, so pane prompts stay out of the way. */
  beforeInstallQuit: () => void
}

let hooks: Hooks | null = null
let state: UpdateState = idleState()
let pending: ReleaseManifest | null = null
let watcher: FSWatcher | null = null
let interval: NodeJS.Timeout | null = null
let debounce: NodeJS.Timeout | null = null
let installing = false

export function manifestPath(): string {
  return process.env.HD_UPDATE_MANIFEST || join(app.getPath('userData'), 'update.json')
}

function idleState(): UpdateState {
  return {
    stage: 'idle',
    current: app.getVersion(),
    available: null,
    manifestPath: manifestPath(),
    lastCheckedAt: null,
    installable: app.isPackaged
  }
}

/** Enough of semver for `x.y.z` with an optional prerelease tag. */
function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = value.trim().replace(/^v/, '').split('-')
    return {
      parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre: rest.join('-')
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  // A release outranks any prerelease of the same numbers.
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

function readManifest(): ReleaseManifest | null {
  const file = manifestPath()
  if (!existsSync(file)) return null
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReleaseManifest
  if (typeof parsed?.version !== 'string' || typeof parsed?.installer !== 'string') {
    throw new Error('it is missing "version" or "installer"')
  }
  return parsed
}

function evaluate(): UpdateState {
  const base = { ...idleState(), lastCheckedAt: new Date().toISOString() }

  let manifest: ReleaseManifest | null = null
  try {
    manifest = readManifest()
  } catch (err) {
    pending = null
    return { ...base, stage: 'error', error: `Release manifest unreadable — ${(err as Error).message}` }
  }

  if (!manifest || compareVersions(manifest.version, base.current) <= 0) {
    pending = null
    return base
  }

  if (!existsSync(manifest.installer)) {
    pending = null
    return {
      ...base,
      stage: 'error',
      error: `${manifest.version} was released but its installer is gone: ${manifest.installer}`
    }
  }

  // A build still writing to disk would otherwise be offered as installable.
  if (manifest.size && statSync(manifest.installer).size !== manifest.size) {
    pending = null
    return { ...base, stage: 'error', error: `The installer for ${manifest.version} looks incomplete.` }
  }

  pending = manifest
  return {
    ...base,
    stage: 'available',
    available: {
      version: manifest.version,
      notes: manifest.notes,
      releasedAt: manifest.releasedAt,
      size: manifest.size
    }
  }
}

export function currentState(): UpdateState {
  return state
}

export function checkNow(): UpdateState {
  if (installing) return state
  state = evaluate()
  hooks?.publish(state)
  return state
}

function watchChannel(): void {
  const file = manifestPath()
  const dir = dirname(file)
  const name = basename(file)
  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, (_event, changed) => {
      if (changed && changed !== name) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(checkNow, WATCH_DEBOUNCE_MS)
    })
  } catch (err) {
    // Losing the watch only costs immediacy — the interval below still catches it.
    console.error('[updater] cannot watch the release channel:', err)
  }
}

export function initUpdater(next: Hooks): void {
  hooks = next
  watchChannel()
  interval = setInterval(checkNow, CHECK_INTERVAL_MS)
  checkNow()
}

export function disposeUpdater(): void {
  watcher?.close()
  watcher = null
  if (interval) clearInterval(interval)
  if (debounce) clearTimeout(debounce)
  interval = null
  debounce = null
}

function sha512(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
  })
}

/**
 * Hands the release over to its NSIS installer and quits. The flags match what
 * electron-updater uses: `/S` installs silently, `--force-run` relaunches us
 * afterwards, and `/D=` pins the install to where this copy already lives —
 * NSIS treats everything after it as the path, so it has to come last.
 */
export async function install(): Promise<InstallResult> {
  if (installing) return { ok: false, error: 'An install is already under way.' }
  if (!pending) return { ok: false, error: 'No update is waiting.' }
  if (!app.isPackaged) {
    return { ok: false, error: 'Only a packaged build can install an update — this is a dev run.' }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: `Installing is wired up for the Windows installer only (running on ${process.platform}).`
    }
  }

  const manifest = pending
  installing = true
  try {
    if (manifest.sha512) {
      const actual = await sha512(manifest.installer)
      if (actual !== manifest.sha512) {
        installing = false
        return {
          ok: false,
          error: `The installer for ${manifest.version} failed its checksum — the build may still be running.`
        }
      }
    }

    if (!existsSync(manifest.installer)) {
      installing = false
      return { ok: false, error: `The installer has gone missing: ${manifest.installer}` }
    }

    const child = spawn(
      manifest.installer,
      ['--updated', '/S', '--force-run', `/D=${dirname(app.getPath('exe'))}`],
      { detached: true, stdio: 'ignore' }
    )
    child.on('error', (err) => console.error('[updater] installer failed to start:', err))
    child.unref()

    hooks?.beforeInstallQuit()
    setTimeout(() => app.quit(), 250)
    // `installing` stays set — the app is on its way out.
    return { ok: true }
  } catch (err) {
    installing = false
    return { ok: false, error: `Could not start the installer: ${(err as Error).message}` }
  }
}
