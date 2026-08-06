import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '@shared/types'
import { loadState, saveState, stateLocation, STATE_VERSION, writeJsonAtomic } from './store'

/**
 * This is the app's crash-recovery path, so the questions worth asking are all
 * about a filesystem in a state nobody meant to leave it in: a state file cut
 * off mid-write, a backup that is the only readable copy left, a folder that
 * went away. A stubbed `fs` would answer them by agreeing with itself — so
 * every test below runs against a real directory under the system temp
 * directory, made in `beforeEach` and removed in `afterEach` either way.
 *
 * `baseDir` is what makes that possible: in the app it defaults to
 * `app.getPath('userData')`, and these tests run in plain Node where there is
 * no `app` to ask (see vitest.config.ts).
 */

let dir = ''
/** What `loadState` said about the files it refused, so tests can assert on it. */
let complaints: string[] = []

/** Shaped like a state file, which is all either side of this ever requires. */
const state = (over: Partial<PersistedState> = {}): PersistedState =>
  ({ version: STATE_VERSION, workspaces: [], activeWorkspaceId: null, ...over }) as PersistedState

const stateFile = (): string => stateLocation(dir)

/** Writes a file exactly as given — including text that is not JSON at all. */
function put(file: string, contents: string): void {
  writeFileSync(file, contents, 'utf8')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hd-store-'))
  // Half of these tests hand this module state it cannot read, and it says so
  // on console.error. That is behaviour worth asserting and not worth printing.
  complaints = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('loadState', () => {
  it('has nothing to hand back the first time the app runs', () => {
    expect(loadState(dir)).toBeNull()
  })

  it('reads back the workspaces it finds', () => {
    const saved = state({ workspaces: [{ id: 'w1' }], activeWorkspaceId: 'w1' } as Partial<PersistedState>)
    put(stateFile(), JSON.stringify(saved))

    expect(loadState(dir)).toEqual(saved)
  })

  /** The crash the temp-file + rename dance in writeJsonAtomic cannot prevent. */
  it('falls back to the backup when the state file is half-written', () => {
    const saved = state({ activeWorkspaceId: 'yesterday' })
    put(`${stateFile()}.bak`, JSON.stringify(saved))
    put(stateFile(), '{"workspaces": [{"id": "w1"')

    expect(loadState(dir)).toEqual(saved)
  })

  /**
   * A file that parses is not a file worth restoring from. Losing a workspace
   * list to a `{}` someone left behind would look exactly like losing it.
   */
  it('falls back to the backup when the file parses but is not a state file', () => {
    const saved = state({ activeWorkspaceId: 'yesterday' })
    put(`${stateFile()}.bak`, JSON.stringify(saved))
    put(stateFile(), JSON.stringify({ workspaces: 'all of them' }))

    expect(loadState(dir)).toEqual(saved)
  })

  it('is not fooled by a file holding nothing but null', () => {
    put(stateFile(), 'null')

    expect(loadState(dir)).toBeNull()
  })

  it('gives up rather than guessing when neither copy can be read', () => {
    put(stateFile(), 'not json, and never was')
    put(`${stateFile()}.bak`, '{"workspaces": [')

    expect(loadState(dir)).toBeNull()
  })

  it('names the file it would not read rather than dropping it silently', () => {
    put(stateFile(), 'not json, and never was')

    expect(loadState(dir)).toBeNull()
    expect(complaints).toHaveLength(1)
    expect(complaints[0]).toContain(stateFile())
  })

  it('reads the directory it was handed, not one it went looking for', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'hd-store-other-'))
    try {
      put(join(elsewhere, 'workspaces.json'), JSON.stringify(state({ activeWorkspaceId: 'there' })))

      expect(loadState(dir)).toBeNull()
      expect(loadState(elsewhere)?.activeWorkspaceId).toBe('there')
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('writeJsonAtomic', () => {
  it('creates the folder it was pointed at', () => {
    const file = join(dir, 'nested', 'deeper', 'thing.json')

    writeJsonAtomic(file, { hello: 'world' })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hello: 'world' })
  })

  it('keeps the previous contents as a backup before overwriting them', () => {
    const file = join(dir, 'thing.json')
    writeJsonAtomic(file, { generation: 1 })
    writeJsonAtomic(file, { generation: 2 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ generation: 2 })
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual({ generation: 1 })
  })

  it('has nothing to back up the first time it writes', () => {
    const file = join(dir, 'thing.json')

    writeJsonAtomic(file, { generation: 1 })

    expect(existsSync(`${file}.bak`)).toBe(false)
  })

  /**
   * These files carry pane env vars in plain text, so nobody else on the
   * machine gets to read them. The mode rides the temp file through the
   * rename — even over an older copy left wide open by a previous version.
   * Windows has no POSIX modes to assert on, so this stays off there.
   */
  it.skipIf(process.platform === 'win32')('leaves the file readable by its owner alone', () => {
    const file = join(dir, 'thing.json')
    put(file, JSON.stringify({ generation: 0 }))
    // A previous version wrote this with default permissions.

    writeJsonAtomic(file, { generation: 1 })

    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('leaves no half-written temp file behind', () => {
    const file = join(dir, 'thing.json')

    writeJsonAtomic(file, { hello: 'world' })

    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(readdirSync(dir)).toEqual(['thing.json'])
  })

  /**
   * Every caller here is a menu command or an IPC handler on the way to
   * quitting: a throw would take the app down over a file it could have
   * complained about instead.
   */
  it('complains about a write it cannot make rather than throwing at the caller', () => {
    const blocker = join(dir, 'not-a-folder')
    put(blocker, 'something else lives here')

    expect(() => writeJsonAtomic(join(blocker, 'thing.json'), { hello: 'world' })).not.toThrow()

    expect(complaints).toHaveLength(1)
    expect(complaints[0]).toContain('failed to write')
    expect(readFileSync(blocker, 'utf8')).toBe('something else lives here')
  })

  it('leaves the last good copy alone when the value cannot be described in JSON', () => {
    const file = join(dir, 'thing.json')
    writeJsonAtomic(file, { generation: 1 })
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => writeJsonAtomic(file, circular)).not.toThrow()

    // The write threw before the rename, so the file is still the last thing
    // that parsed — the temp file is where the failure stayed.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ generation: 1 })
  })
})

describe('saveState', () => {
  it('stamps the state version onto what it writes', () => {
    saveState(state({ activeWorkspaceId: 'w1' }), dir)

    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toMatchObject({
      version: STATE_VERSION,
      activeWorkspaceId: 'w1'
    })
  })

  /** The renderer's copy of `version` is whatever it last read — ours is the truth. */
  it('stamps its own version over the one the caller arrived with', () => {
    saveState(state({ version: 99 }), dir)

    expect(JSON.parse(readFileSync(stateFile(), 'utf8')).version).toBe(STATE_VERSION)
  })

  it('writes where stateLocation says it will, and reads back the same way', () => {
    const saved = state({ activeWorkspaceId: 'w1' })

    saveState(saved, dir)

    expect(stateLocation(dir)).toBe(join(dir, 'workspaces.json'))
    expect(loadState(dir)).toEqual({ ...saved, version: STATE_VERSION })
  })

  /** The round trip the app actually makes: save, save again, lose the newer one. */
  it('leaves a readable backup for the next launch to fall back to', () => {
    saveState(state({ activeWorkspaceId: 'first' }), dir)
    saveState(state({ activeWorkspaceId: 'second' }), dir)
    put(stateFile(), '{"workspaces": [')

    expect(loadState(dir)?.activeWorkspaceId).toBe('first')
  })
})
