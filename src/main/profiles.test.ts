import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedProfile } from '@shared/types'
import { detectProfiles, findExecutable, shellCommandLine } from './profiles'

/**
 * Almost everything below is a branch nobody on a Mac ever takes — PATHEXT
 * lookup, and the argv that launches a pane on Windows — so `process.platform`
 * is stubbed outright and restored after every test.
 *
 * The files being searched for are real files under the system temp directory.
 * The question `findExecutable` answers is what the filesystem says about a
 * candidate path, and a stubbed `fs` would answer it by agreeing with this file
 * about what `accessSync` means, which is the part worth doubting.
 */

const HOST = process.platform

/** `process.platform` is read-only; this is the only way to ask the other ones. */
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

let dir = ''
/** Two PATH entries, so "which one wins" is a question with a visible answer. */
let bin = ''
let second = ''

/** A real file, executable unless a test is asking about one that is not. */
function put(where: string, name: string, mode = 0o755): string {
  const file = join(where, name)
  writeFileSync(file, '#!/bin/sh\necho hi\n')
  chmodSync(file, mode)
  return file
}

const pathOf = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.join(delimiter) })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hd-profiles-'))
  bin = join(dir, 'bin')
  second = join(dir, 'second')
  mkdirSync(bin)
  mkdirSync(second)
})

afterEach(() => {
  onPlatform(HOST)
  vi.unstubAllEnvs()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('findExecutable', () => {
  beforeEach(() => {
    // The default arm, unless a test says Windows. Stubbed rather than left to
    // the host so the same branch runs wherever the suite is run.
    onPlatform('linux')
  })

  it('finds a command in the directory PATH points at', () => {
    const agent = put(bin, 'claude')

    expect(findExecutable('claude', pathOf(bin))).toBe(agent)
  })

  it('walks PATH in order and stops at the first directory that has it', () => {
    const first = put(bin, 'claude')
    put(second, 'claude')

    expect(findExecutable('claude', pathOf(bin, second))).toBe(first)
  })

  it('walks past a directory that does not have it', () => {
    const later = put(second, 'claude')

    expect(findExecutable('claude', pathOf(bin, second))).toBe(later)
  })

  it('ignores an empty PATH entry rather than searching the working directory', () => {
    put(bin, 'claude')

    expect(findExecutable('claude', { PATH: `${delimiter}${bin}${delimiter}` })).toBe(
      join(bin, 'claude')
    )
  })

  it('says nothing about a command that is on no PATH entry', () => {
    expect(findExecutable('claude', pathOf(bin, second))).toBeNull()
  })

  it('says nothing when there is no PATH to search', () => {
    put(bin, 'claude')

    expect(findExecutable('claude', {})).toBeNull()
  })

  it('says nothing about an empty command', () => {
    expect(findExecutable('', pathOf(bin))).toBeNull()
  })

  it('takes an absolute path at its word, without consulting PATH', () => {
    const elsewhere = put(second, 'claude')

    expect(findExecutable(elsewhere, pathOf(bin))).toBe(elsewhere)
  })

  it('says nothing about an absolute path to something that is not there', () => {
    put(bin, 'claude')

    expect(findExecutable(join(second, 'claude'), pathOf(bin))).toBeNull()
  })

  /**
   * A command with a separator in it is a path, not a name: joining it onto
   * every PATH entry would find `bin/tools/claude` for someone who typed
   * `tools/claude` from somewhere else entirely.
   */
  it('does not search PATH for a command that is already spelled as a path', () => {
    put(bin, 'claude')

    expect(findExecutable(join('tools', 'claude'), pathOf(bin))).toBeNull()
  })

  /** The reason `available` exists: a downloaded binary nobody chmod'd. */
  it.skipIf(HOST === 'win32')('passes over a file that is there but cannot be run', () => {
    put(bin, 'claude', 0o644)

    expect(findExecutable('claude', pathOf(bin))).toBeNull()
  })

  it.skipIf(HOST === 'win32')('goes on searching PATH past one it cannot run', () => {
    put(bin, 'claude', 0o644)
    const runnable = put(second, 'claude')

    expect(findExecutable('claude', pathOf(bin, second))).toBe(runnable)
  })

  describe('on Windows', () => {
    beforeEach(() => {
      onPlatform('win32')
    })

    it('finds a command spelled without the extension it was installed under', () => {
      put(bin, 'claude.CMD')

      expect(findExecutable('claude', { ...pathOf(bin), PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toBe(
        join(bin, 'claude.CMD')
      )
    })

    it('tries the extensions in the order PATHEXT gives them', () => {
      put(bin, 'claude.CMD')
      put(bin, 'claude.EXE')

      expect(findExecutable('claude', { ...pathOf(bin), PATHEXT: '.EXE;.CMD' })).toBe(
        join(bin, 'claude.EXE')
      )
      expect(findExecutable('claude', { ...pathOf(bin), PATHEXT: '.CMD;.EXE' })).toBe(
        join(bin, 'claude.CMD')
      )
    })

    /** npm installs its shims as .CMD, so an unset PATHEXT must still find them. */
    it('falls back to the usual extensions when PATHEXT is unset', () => {
      put(bin, 'claude.CMD')

      expect(findExecutable('claude', pathOf(bin))).toBe(join(bin, 'claude.CMD'))
    })

    it('prefers the name as it was spelled over any extension of it', () => {
      const bare = put(bin, 'claude')
      put(bin, 'claude.EXE')

      expect(findExecutable('claude', { ...pathOf(bin), PATHEXT: '.EXE' })).toBe(bare)
    })

    /** Windows has no executable bit, and asking for one finds nothing at all. */
    it('takes a file it could not run on a POSIX machine', () => {
      put(bin, 'claude.EXE', 0o644)

      expect(findExecutable('claude', { ...pathOf(bin), PATHEXT: '.EXE' })).toBe(
        join(bin, 'claude.EXE')
      )
    })

    it('adds an extension to an absolute path that was given without one', () => {
      put(bin, 'claude.EXE')

      expect(findExecutable(join(bin, 'claude'), { PATHEXT: '.EXE' })).toBe(join(bin, 'claude.EXE'))
    })
  })
})

/**
 * `viaShell` panes are the ones a user typed a command line into, and this is
 * where that line becomes an argv. Get it wrong and panes silently fail to
 * launch on Windows — where the shell is whatever `defaultShell()` found, so
 * these drive it through the environment rather than mocking it out.
 */
describe('shellCommandLine', () => {
  /** No PowerShell, no cmd.exe: everything Windows resolves to is under here. */
  function noWindowsShells(): void {
    vi.stubEnv('SystemRoot', dir)
    vi.stubEnv('ProgramFiles', dir)
    vi.stubEnv('LOCALAPPDATA', dir)
  }

  it('runs the line in a login interactive shell on POSIX', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/usr/bin/fish')

    expect(shellCommandLine('npm run dev')).toEqual({
      command: '/usr/bin/fish',
      args: ['-l', '-i', '-c', 'npm run dev']
    })
  })

  it('hands the whole line over as one argument, spaces and quotes and all', () => {
    onPlatform('darwin')
    vi.stubEnv('SHELL', '/bin/zsh')
    const line = 'claude --model opus -p "write a haiku about $PATH"'

    expect(shellCommandLine(line).args).toEqual(['-l', '-i', '-c', line])
  })

  it('keeps cmd.exe alive after the command with /k', () => {
    onPlatform('win32')
    noWindowsShells()
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe')

    expect(shellCommandLine('npm run dev')).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/k', 'npm run dev']
    })
  })

  /** COMSPEC is whatever the registry says, and the registry does not shout. */
  it('recognises cmd.exe however it was capitalised', () => {
    onPlatform('win32')
    noWindowsShells()
    vi.stubEnv('COMSPEC', 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE')

    expect(shellCommandLine('npm run dev').args).toEqual(['/k', 'npm run dev'])
  })

  it('drives PowerShell with -Command, and keeps it open', () => {
    onPlatform('win32')
    const pwsh = join(dir, 'PowerShell', '7', 'pwsh.exe')
    mkdirSync(join(dir, 'PowerShell', '7'), { recursive: true })
    writeFileSync(pwsh, '')
    vi.stubEnv('SystemRoot', dir)
    vi.stubEnv('ProgramFiles', dir)
    vi.stubEnv('LOCALAPPDATA', dir)

    expect(shellCommandLine('npm run dev')).toEqual({
      command: pwsh,
      args: ['-NoLogo', '-NoExit', '-Command', 'npm run dev']
    })
  })

  /**
   * `exits` is what a pane with a setup command asks for: the pty's onExit is
   * the pane's exit report, and an interactive `/k` or `-NoExit` shell would
   * sit at a prompt in its place — running forever, auto-restart never firing.
   * POSIX `-c` exits with the line either way, so its argv does not change.
   */
  it('lets the shell die with the command when asked to', () => {
    onPlatform('win32')
    noWindowsShells()
    vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe')
    expect(shellCommandLine('npm run dev', { exits: true }).args).toEqual(['/c', 'npm run dev'])

    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/bash')
    expect(shellCommandLine('npm run dev', { exits: true }).args).toEqual([
      '-l',
      '-i',
      '-c',
      'npm run dev'
    ])
  })

  it('exits PowerShell with the line, forwarding its code', () => {
    onPlatform('win32')
    const pwsh = join(dir, 'PowerShell', '7', 'pwsh.exe')
    mkdirSync(join(dir, 'PowerShell', '7'), { recursive: true })
    writeFileSync(pwsh, '')
    noWindowsShells()

    // `exit $LASTEXITCODE`, because -Command's own exit status collapses to
    // 0-or-1 and the crash-restart backoff wants the real code.
    expect(shellCommandLine('npm run dev', { exits: true })).toEqual({
      command: pwsh,
      args: ['-NoLogo', '-Command', 'npm run dev; exit $LASTEXITCODE']
    })
  })

  /** `/k` handed to PowerShell is an error dialog, so the test is the name. */
  it('reads the executable name, not the path it sits in', () => {
    onPlatform('win32')
    noWindowsShells()
    vi.stubEnv('COMSPEC', 'C:\\cmd.exe\\bin\\pwsh.exe')

    expect(shellCommandLine('npm run dev').args).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'npm run dev'
    ])
  })
})

/**
 * The renderer resolves a workspace action's env by looking its profile up by
 * id, so a saved profile answering for a built-in id — the 'custom' sentinel
 * above all — would hand its `env` to every process spawned through it. The
 * store refuses to persist such an id; these drive the guard in
 * `detectProfiles` itself, through the `load` seam, with exactly the lists the
 * store would never produce.
 */
describe('detectProfiles', () => {
  beforeEach(() => {
    onPlatform('linux')
  })

  /** Shaped like a stored launcher; the id is the part under test. */
  const saved = (id: string, over: Partial<SavedProfile> = {}): SavedProfile => ({
    id,
    name: id,
    command: 'run-things',
    args: [],
    icon: '»»',
    accent: '#123456',
    ...over
  })

  it('keeps the built-in custom sentinel over a saved profile claiming its id', async () => {
    const list = await detectProfiles(() => [
      saved('custom', { env: { PATH: '/somewhere/else', NODE_OPTIONS: '--require x' } })
    ])

    const custom = list.filter((p) => p.id === 'custom')
    expect(custom).toHaveLength(1)
    expect(custom[0].command).toBe('')
    expect(custom[0].env).toBeUndefined()
  })

  it('keeps a detected built-in over a saved profile claiming its id', async () => {
    const list = await detectProfiles(() => [
      saved('agent:claude', { env: { BASH_ENV: '/somewhere/else' } })
    ])

    const claude = list.filter((p) => p.id === 'agent:claude')
    expect(claude).toHaveLength(1)
    expect(claude[0].kind).toBe('agent')
    expect(claude[0].env).toBeUndefined()
  })

  it('keeps the first of two saved profiles sharing an id', async () => {
    const list = await detectProfiles(() => [
      saved('custom:mine', { name: 'first' }),
      saved('custom:mine', { name: 'second' })
    ])

    const mine = list.filter((p) => p.id === 'custom:mine')
    expect(mine).toHaveLength(1)
    expect(mine[0].name).toBe('first')
  })

  it('never returns the same id twice', async () => {
    const list = await detectProfiles(() => [
      saved('custom'),
      saved('shell:default'),
      saved('custom:mine')
    ])

    const ids = list.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('still carries a namespaced saved profile through, env and all', async () => {
    const list = await detectProfiles(() => [
      saved('custom:mine', { env: { FOO: 'bar' }, cwd: '/somewhere' })
    ])

    const mine = list.find((p) => p.id === 'custom:mine')
    expect(mine).toMatchObject({ kind: 'custom', env: { FOO: 'bar' }, cwd: '/somewhere' })
  })
})
