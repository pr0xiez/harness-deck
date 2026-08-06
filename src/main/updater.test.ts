import { createHash } from 'node:crypto'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * updater.ts imports `electron`, which the node test project cannot satisfy —
 * so the module is mocked with the two properties the updater reads, and the
 * env vars point every path it derives at a temp directory. What is under test
 * is the local channel failing closed: a manifest without a sha512 must never
 * become an installable offer, whatever else it gets right.
 */
const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'harness-deck-updater-'))
  process.env.HD_UPDATE_MANIFEST = join(dir, 'update.json')
  process.env.HD_UPDATE_FEED = 'https://release.feed.invalid/latest.yml'
  return dir
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0',
    getPath: () => dir,
    getAppPath: () => dir,
    isPackaged: false
  }
}))

import { checkNow, install } from './updater'

const manifestFile = join(dir, 'update.json')
const installer = join(dir, 'Harness-Deck-9.9.9.exe')

describe('the local channel and a hash-less manifest', () => {
  it('refuses the release and leaves nothing for install() to run', async () => {
    writeFileSync(installer, 'installer bytes')
    writeFileSync(manifestFile, JSON.stringify({ version: '9.9.9', installer }))

    const state = await checkNow()
    expect(state.stage).toBe('error')
    expect(state.error).toMatch(/sha512/)
    expect(state.available).toBeNull()

    // Nothing was offered, so nothing can be installed — the installer file
    // existing on disk buys the manifest nothing without its hash.
    expect(await install()).toEqual({ ok: false, error: 'No update is waiting.' })
  })

  it('offers the same release once the manifest carries its sha512', async () => {
    writeFileSync(installer, 'installer bytes')
    writeFileSync(
      manifestFile,
      JSON.stringify({
        version: '9.9.9',
        installer,
        sha512: createHash('sha512').update('installer bytes').digest('base64'),
        size: statSync(installer).size
      })
    )

    const state = await checkNow()
    expect(state.stage).toBe('available')
    expect(state.available?.version).toBe('9.9.9')

    // Still nothing spawns from a test: install() bows out before touching the
    // installer because this is not a packaged build.
    expect(await install()).toEqual({
      ok: false,
      error: 'Only a packaged build can install an update — this is a dev run.'
    })
  })
})
