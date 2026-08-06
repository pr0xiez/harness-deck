import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { InstallResult, UpdateChannel, UpdateState } from '@shared/types'
import {
  compareVersions,
  feedUrl,
  parseLatestYml,
  pickInstaller,
  repoFromPackage,
  type ReleaseRepo
} from './update-feed'

/**
 * Updates come from one of two release channels. The local one is a manifest on
 * this machine: `npm run release` builds an installer into `release/` and writes
 * a manifest pointing at it. The manifest lives beside the app's own state,
 * which is the one location the build script and an installed copy can both
 * derive without anything being baked in at package time.
 *
 * The other is the GitHub release CI publishes to, read through the same
 * `latest*.yml` electron-updater would have used. Whichever is selected, the
 * shape below is what the rest of this file works with — a version, an
 * installer to run, and a hash to check it against.
 */
interface ReleaseManifest {
  version: string
  /** Absolute native path to the installer this release wants us to run. Empty until a remote one is fetched. */
  installer: string
  /**
   * Base64 sha512 of the installer, matching electron-builder's convention.
   * Optional in shape because a manifest on disk may omit it, but evaluation
   * refuses one that does and install() will not spawn without it.
   */
  sha512?: string
  size?: number
  notes?: string
  releasedAt?: string
  /** Set on the GitHub channel: where the installer is fetched from at install time. */
  url?: string
}

const CHECK_INTERVAL_MS = 15 * 60 * 1000
const WATCH_DEBOUNCE_MS = 400
/** A feed that never answers must not outlive the poll that asked for it. */
const FEED_TIMEOUT_MS = 15 * 1000
/** An installer is ~240 MB, so this is a stall guard rather than a deadline. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
/**
 * The rolling prerelease every build of main refreshes. People installing from
 * CI take it from there, so that is the release they need to be told about;
 * tagged releases are drafts until someone publishes them by hand.
 */
const FEED_TAG = 'latest-main'

interface Hooks {
  publish: (state: UpdateState) => void
  /** Called just before we quit for an install, so pane prompts stay out of the way. */
  beforeInstallQuit: () => void
}

/**
 * Starts local and only moves once the renderer says the user picked otherwise,
 * so neither a dev run nor the smoke test can touch the network on its own.
 *
 * Declared above `state`, which is seeded from idleState() as this module
 * loads and reads both this and `repo`.
 */
let channel: UpdateChannel = 'local'
let repo: ReleaseRepo | null | undefined

let hooks: Hooks | null = null
let state: UpdateState = idleState()
let pending: ReleaseManifest | null = null
let watcher: FSWatcher | null = null
let interval: NodeJS.Timeout | null = null
let debounce: NodeJS.Timeout | null = null
let installing = false
let checking = false

export function manifestPath(): string {
  return process.env.HD_UPDATE_MANIFEST || join(app.getPath('userData'), 'update.json')
}

/** package.json ships inside the asar, so an installed copy can still read it. */
function releaseRepo(): ReleaseRepo | null {
  if (repo !== undefined) return repo
  try {
    repo = repoFromPackage(JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')))
  } catch (err) {
    console.error('[updater] cannot read the release repository from package.json:', err)
    repo = null
  }
  return repo
}

export function feedLocation(): string {
  if (process.env.HD_UPDATE_FEED) return process.env.HD_UPDATE_FEED
  const target = releaseRepo()
  return target ? feedUrl(target, FEED_TAG, process.platform) : ''
}

function idleState(): UpdateState {
  return {
    stage: 'idle',
    current: app.getVersion(),
    available: null,
    channel,
    manifestPath: manifestPath(),
    feedUrl: feedLocation(),
    lastCheckedAt: null,
    installable: app.isPackaged
  }
}

/**
 * Node reports every transport failure as a bare "fetch failed" and hangs the
 * half worth reading — ECONNREFUSED, DNS, TLS — off the cause. This is the only
 * text the toast gets, so it is worth unwrapping.
 */
const reason = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause
  return cause instanceof Error && cause.message ? `${err.message} (${cause.message})` : err.message
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

function evaluateLocal(): UpdateState {
  const base = { ...idleState(), lastCheckedAt: new Date().toISOString() }

  let manifest: ReleaseManifest | null = null
  try {
    manifest = readManifest()
  } catch (err) {
    pending = null
    return { ...base, stage: 'error', error: `Release manifest unreadable — ${reason(err)}` }
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

  // The hash is the only check standing between the manifest and spawning the
  // installer, so a manifest without one is refused rather than trusted.
  if (!manifest.sha512) {
    pending = null
    return {
      ...base,
      stage: 'error',
      error: `${manifest.version} was released without a sha512, so its installer cannot be verified.`
    }
  }

  // A build still writing to disk would otherwise be offered as installable.
  if (manifest.size && statSync(manifest.installer).size !== manifest.size) {
    pending = null
    return { ...base, stage: 'error', error: `The installer for ${manifest.version} looks incomplete.` }
  }

  pending = manifest
  return offer(base, manifest)
}

async function evaluateFeed(): Promise<UpdateState> {
  const base = { ...idleState(), lastCheckedAt: new Date().toISOString() }
  const url = base.feedUrl
  if (!url) {
    pending = null
    return {
      ...base,
      stage: 'error',
      error: 'No release repository is configured — package.json names no "repository".'
    }
  }

  let yml
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
    })
    // A 404 here is the normal answer for a repository that has never published,
    // so it is reported the same way as being offline rather than crashing.
    if (!response.ok) throw new Error(`the release feed answered ${response.status}`)
    yml = parseLatestYml(await response.text())
  } catch (err) {
    pending = null
    return { ...base, stage: 'error', error: `Could not read the release channel — ${reason(err)}` }
  }

  // Version first: a release we already have is not worth complaining about,
  // whatever it does or doesn't carry for this platform.
  if (compareVersions(yml.version, base.current) <= 0) {
    pending = null
    return base
  }

  // Also null when the feed names no sha512 for its installer: a hash-less
  // release is one we could never verify, so it is never offered.
  const file = pickInstaller(yml, process.platform)
  if (!file) {
    pending = null
    return {
      ...base,
      stage: 'error',
      error: `Release ${yml.version} carries no verifiable installer for ${process.platform}.`
    }
  }

  const manifest: ReleaseManifest = {
    version: yml.version,
    // Filled in by install(): 240 MB is not something to fetch on a poll.
    installer: '',
    sha512: file.sha512,
    size: file.size,
    notes: yml.releaseNotes,
    releasedAt: yml.releaseDate,
    url: new URL(file.url, url).toString()
  }
  pending = manifest
  return offer(base, manifest)
}

function offer(base: UpdateState, manifest: ReleaseManifest): UpdateState {
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

export async function checkNow(): Promise<UpdateState> {
  if (installing) return state
  // A feed that is merely slow would otherwise have every 15-minute tick pile a
  // second request on top of the first, and none of them would ever finish.
  if (checking) return state
  if (channel === 'off') {
    pending = null
    state = idleState()
    hooks?.publish(state)
    return state
  }

  checking = true
  try {
    state = channel === 'github' ? await evaluateFeed() : evaluateLocal()
  } finally {
    checking = false
  }
  hooks?.publish(state)
  return state
}

/** Switching channel throws away whatever the old one had found. */
export function setChannel(next: UpdateChannel): Promise<UpdateState> {
  if (next === channel) return Promise.resolve(state)
  channel = next
  pending = null
  return checkNow()
}

function watchChannel(): void {
  const file = manifestPath()
  const dir = dirname(file)
  const name = basename(file)
  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, (_event, changed) => {
      if (changed && changed !== name) return
      // Only the local channel is watching this file; on the others a manifest
      // landing is somebody else's business and must not cost a request.
      if (channel !== 'local') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void checkNow(), WATCH_DEBOUNCE_MS)
    })
  } catch (err) {
    // Losing the watch only costs immediacy — the interval below still catches it.
    console.error('[updater] cannot watch the release channel:', err)
  }
}

export function initUpdater(next: Hooks): void {
  hooks = next
  watchChannel()
  interval = setInterval(() => void checkNow(), CHECK_INTERVAL_MS)
  void checkNow()
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
 * Fetches a release asset into a temp directory. It lands under `.part` and is
 * renamed once the body is complete, so a download cut off halfway can never be
 * picked up as an installer by a later attempt.
 */
async function download(url: string): Promise<string> {
  const dir = join(tmpdir(), 'harness-deck-updates')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, basename(new URL(url).pathname) || 'installer')

  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`)

  const partial = `${target}.part`
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(partial))
  renameSync(partial, target)
  return target
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
  // Both channels refuse a hash-less release at evaluation time, so nothing
  // unverifiable should ever get this far — but if one does, it must not be
  // spawned. This check fails closed where trusting the manifest would not.
  if (!manifest.sha512) {
    return {
      ok: false,
      error: `The installer for ${manifest.version} cannot be verified — its release names no sha512.`
    }
  }
  installing = true
  try {
    if (manifest.url) {
      try {
        manifest.installer = await download(manifest.url)
      } catch (err) {
        installing = false
        return { ok: false, error: `Could not download ${manifest.version} — ${reason(err)}` }
      }

      // A truncated body that still ended cleanly would fail the hash below
      // anyway; checking the size first just names the likelier cause.
      if (manifest.size && statSync(manifest.installer).size !== manifest.size) {
        installing = false
        rmSync(manifest.installer, { force: true })
        manifest.installer = ''
        return {
          ok: false,
          error: `The download for ${manifest.version} is not the size its release promised.`
        }
      }
    }

    const actual = await sha512(manifest.installer)
    if (actual !== manifest.sha512) {
      installing = false
      // A downloaded file that fails here is ours to throw away, and it has to
      // go — leaving it would hand the next attempt the same bad bytes.
      if (manifest.url) {
        rmSync(manifest.installer, { force: true })
        manifest.installer = ''
      }
      return {
        ok: false,
        error: `The installer for ${manifest.version} failed its checksum — the build may still be running.`
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
    return { ok: false, error: `Could not start the installer: ${reason(err)}` }
  }
}
