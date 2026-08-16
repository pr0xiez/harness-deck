import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isInsideDir, type OpenPathPolicy, resolveOpenPath } from './open-path'

/**
 * `resolveOpenPath` is the decision behind `app:openPath`, previously
 * module-private in index.ts with no coverage of its own — the git side of
 * this PR got 15 tests for an equivalent decision (`worktreePathAllowed`),
 * this had none. Everything below runs against a real temp directory, made in
 * `beforeEach` and removed in `afterEach` either way, the same posture
 * git.test.ts and store.test.ts take: a stubbed `fs` would only prove this
 * file agrees with itself about what realpath does.
 */

let base = ''

beforeEach(() => {
  // Resolved up front for the same reason git.test.ts and smoke.ts do it: on
  // macOS the temp directory itself is a /var symlink, and comparing an
  // unresolved path against a realpath'd one would fail for a reason that has
  // nothing to do with the code under test.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'hd-open-path-')))
})

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

describe('isInsideDir', () => {
  it('is true for a file directly inside the base', () => {
    expect(isInsideDir('/data/dev', '/data/dev/state.json')).toBe(true)
  })

  it('is false for the base itself — a file is always some path within it', () => {
    expect(isInsideDir('/data/dev', '/data/dev')).toBe(false)
  })

  it('is false for a path that climbs back out with ..', () => {
    expect(isInsideDir('/data/dev', '/data/dev/../evil')).toBe(false)
  })

  it('is false for a sibling that merely shares the prefix', () => {
    expect(isInsideDir('/data/dev', '/data/dev-evil/x')).toBe(false)
  })
})

describe('resolveOpenPath', () => {
  const policy = (userData: string, manifestPath: string): OpenPathPolicy => ({ userData, manifestPath })

  it('reveals a directory rather than opening it', async () => {
    const dir = join(base, 'a-folder')
    mkdirSync(dir)
    const decision = await resolveOpenPath(dir, policy(join(base, 'userData'), join(base, 'update.json')))
    expect(decision).toEqual({ ok: true, target: realpathSync(dir), reveal: true })
  })

  /**
   * The blocker this file exists for: `shell.openPath` on darwin LAUNCHES a
   * directory shaped like an application bundle (`.app`, `.workflow`,
   * `.prefPane`, `.bundle`) instead of merely opening it. The fix is to reveal
   * every directory rather than open it, so the decision does not depend on
   * the extension at all — asserted the same way on every platform this runs.
   */
  it('reveals a macOS-bundle-shaped directory rather than launching it', async () => {
    const bundle = join(base, 'Terminal.app')
    mkdirSync(bundle)
    const decision = await resolveOpenPath(bundle, policy(join(base, 'userData'), join(base, 'update.json')))
    expect(decision).toEqual({ ok: true, target: realpathSync(bundle), reveal: true })
  })

  it('allows a file inside userData', async () => {
    const userData = join(base, 'userData')
    mkdirSync(userData)
    const file = join(userData, 'state.json')
    writeFileSync(file, '{}')

    const decision = await resolveOpenPath(file, policy(userData, join(base, 'update.json')))
    expect(decision).toEqual({ ok: true, target: realpathSync(file), reveal: false })
  })

  it('allows the update manifest even when HD_UPDATE_MANIFEST moves it outside userData', async () => {
    const userData = join(base, 'userData')
    mkdirSync(userData)
    mkdirSync(join(base, 'elsewhere'))
    const manifest = join(base, 'elsewhere', 'update.json')
    writeFileSync(manifest, '{}')

    const decision = await resolveOpenPath(manifest, policy(userData, manifest))
    expect(decision).toEqual({ ok: true, target: realpathSync(manifest), reveal: false })
  })

  it('blocks a file outside both userData and the manifest', async () => {
    const userData = join(base, 'userData')
    mkdirSync(userData)
    const outside = join(base, 'secret.txt')
    writeFileSync(outside, 'x')

    const decision = await resolveOpenPath(outside, policy(userData, join(base, 'update.json')))
    expect(decision).toEqual({ ok: false })
  })

  it('blocks the manifest path itself before any update has ever been checked for', async () => {
    const userData = join(base, 'userData')
    mkdirSync(userData)
    const manifest = join(base, 'update.json')

    // SettingsDialog calls `api.openPath(update?.manifestPath ?? '')` even
    // when no update has ever landed, so the file plainly does not exist yet.
    // That is an ordinary refusal, not a throw.
    const decision = await resolveOpenPath(manifest, policy(userData, manifest))
    expect(decision).toEqual({ ok: false })
  })

  it('blocks a relative path without touching the filesystem', async () => {
    const decision = await resolveOpenPath(
      'relative/path',
      policy(join(base, 'userData'), join(base, 'update.json'))
    )
    expect(decision).toEqual({ ok: false })
  })

  it('blocks an empty path — resolve("") would otherwise rebase it onto the main process cwd', async () => {
    const decision = await resolveOpenPath('', policy(join(base, 'userData'), join(base, 'update.json')))
    expect(decision).toEqual({ ok: false })
  })

  it('blocks a path that does not exist', async () => {
    const decision = await resolveOpenPath(
      join(base, 'nope.json'),
      policy(join(base, 'userData'), join(base, 'update.json'))
    )
    expect(decision).toEqual({ ok: false })
  })

  /**
   * A Linux home on another volume (`/home/dev -> /data/dev`) is a common
   * shape. `userData` itself has to be realpath'd, not just the candidate —
   * otherwise a state file that is genuinely inside it stops resolving.
   */
  it('follows a symlinked userData to allow what is really inside it', async () => {
    const real = join(base, 'real-user-data')
    mkdirSync(real)
    const linked = join(base, 'userData-link')
    symlinkSync(real, linked, 'dir')
    const file = join(real, 'state.json')
    writeFileSync(file, '{}')

    const decision = await resolveOpenPath(file, policy(linked, join(base, 'update.json')))
    expect(decision).toEqual({ ok: true, target: realpathSync(file), reveal: false })
  })

  it('refuses a symlink inside userData standing in for a file outside it', async () => {
    const userData = join(base, 'userData')
    mkdirSync(userData)
    const outside = join(base, 'outside.txt')
    writeFileSync(outside, 'x')
    symlinkSync(outside, join(userData, 'looks-safe.txt'))

    const decision = await resolveOpenPath(
      join(userData, 'looks-safe.txt'),
      policy(userData, join(base, 'update.json'))
    )
    expect(decision).toEqual({ ok: false })
  })
})
