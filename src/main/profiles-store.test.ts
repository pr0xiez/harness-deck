import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SavedProfile } from '@shared/types'
import { loadCustomProfiles, removeCustomProfile, saveCustomProfile } from './profiles-store'

/**
 * The ids in this file end up as lookup keys in the renderer, where the entry
 * they find decides the env of every process spawned through it — so the
 * questions worth asking are about ids nobody was supposed to write: the
 * reserved 'custom', a detected built-in's id, anything outside the `custom:`
 * namespace the save dialog mints into. The file is user-editable, so each of
 * them has to be asked twice — once arriving through `saveCustomProfile`, once
 * already sitting in custom-profiles.json.
 *
 * As in store.test.ts, everything runs against a real directory under the
 * system temp directory, handed in through the `baseDir` seam.
 */

let dir = ''

const profilesFile = (): string => join(dir, 'custom-profiles.json')

/** Shaped like a stored launcher; the id is the part under test. */
const entry = (id: string, over: Partial<SavedProfile> = {}): SavedProfile => ({
  id,
  name: 'mine',
  command: 'run-things',
  args: [],
  icon: '»',
  accent: '#123456',
  ...over
})

/** Writes the file exactly as a user editing it would leave it. */
function put(entries: unknown[]): void {
  writeFileSync(profilesFile(), JSON.stringify(entries), 'utf8')
}

const storedIds = (): string[] =>
  (JSON.parse(readFileSync(profilesFile(), 'utf8')) as SavedProfile[]).map((p) => p.id)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hd-profiles-store-'))
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('loadCustomProfiles', () => {
  it('rewrites the reserved id "custom" into the custom: namespace', () => {
    put([entry('custom', { env: { PATH: '/somewhere/else' } })])

    const loaded = loadCustomProfiles(dir)

    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('custom:custom')
    expect(loaded[0].env).toEqual({ PATH: '/somewhere/else' })
  })

  it('rewrites an id borrowed from a detected built-in', () => {
    put([entry('agent:claude')])

    expect(loadCustomProfiles(dir).map((p) => p.id)).toEqual(['custom:agent:claude'])
  })

  it('leaves an id the save dialog minted alone', () => {
    put([entry('custom:m3k9abcd')])

    expect(loadCustomProfiles(dir).map((p) => p.id)).toEqual(['custom:m3k9abcd'])
  })
})

describe('saveCustomProfile', () => {
  it('namespaces the reserved id "custom" before it reaches the file', () => {
    const next = saveCustomProfile(entry('custom'), dir)

    expect(next.map((p) => p.id)).toEqual(['custom:custom'])
    expect(storedIds()).toEqual(['custom:custom'])
  })

  it('namespaces any bare id, not just the reserved one', () => {
    expect(saveCustomProfile(entry('shell:default'), dir).map((p) => p.id)).toEqual([
      'custom:shell:default'
    ])
  })

  it('keeps an id the save dialog minted as it is', () => {
    expect(saveCustomProfile(entry('custom:m3k9abcd'), dir).map((p) => p.id)).toEqual([
      'custom:m3k9abcd'
    ])
  })

  it('edits one entry in place however its id was spelled on the way in', () => {
    saveCustomProfile(entry('custom', { name: 'first' }), dir)
    saveCustomProfile(entry('custom', { name: 'second' }), dir)
    const next = saveCustomProfile(entry('custom:custom', { name: 'third' }), dir)

    expect(next).toHaveLength(1)
    expect(next[0].name).toBe('third')
  })

  it('lands a save on the entry the file spelled bare, not beside it', () => {
    put([entry('custom', { name: 'from the file' })])

    const next = saveCustomProfile(entry('custom', { name: 'from the dialog' }), dir)

    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'custom:custom', name: 'from the dialog' })
  })
})

describe('removeCustomProfile', () => {
  it('removes a profile by the id it was stored under', () => {
    saveCustomProfile(entry('custom'), dir)

    expect(removeCustomProfile('custom:custom', dir)).toEqual([])
    expect(storedIds()).toEqual([])
  })

  it('removes a rewritten entry that began life bare in the file', () => {
    put([entry('agent:claude'), entry('custom:keep')])

    expect(removeCustomProfile('custom:agent:claude', dir).map((p) => p.id)).toEqual(['custom:keep'])
  })
})
