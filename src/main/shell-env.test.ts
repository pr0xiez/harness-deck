import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeShell } from './shell-env'

/**
 * This is the module that makes `claude` findable when the app was launched
 * from Finder rather than from a terminal, so the behaviour that matters is
 * what it does when the login shell does *not* answer: a Finder launch with no
 * usable PATH is the whole reason it exists, and falling back to a bare
 * environment must never be a crash.
 *
 * The probe is injected (see `ProbeShell`) rather than spawned: a real login
 * shell would take seconds, and would report a different environment on every
 * machine — none of which is the question. Where a directory has to be real to
 * be found, it is a real directory under the system temp directory.
 */

/** Matches MARKER in shell-env.ts — what the probe script echoes either side. */
const MARKER = '__HARNESS_DECK_ENV__'

/** What a login shell that behaved itself writes to stdout. */
const reported = (body: string): string => `${MARKER}\n${body}\n${MARKER}\n`

const HOST = process.platform

/** `process.platform` is read-only; this is the only way to ask the other ones. */
function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

interface Probe {
  probe: ProbeShell
  /** Every attempt, in order, so the fallback ladder is visible to a test. */
  calls: Array<{ shell: string; args: string[]; timeout: number }>
}

/** A login shell that says each of `replies` in turn, then nothing at all. */
function probing(...replies: Array<string | null>): Probe {
  const calls: Probe['calls'] = []
  const queue = [...replies]
  return {
    calls,
    probe: async (shell, args, timeout) => {
      calls.push({ shell, args, timeout })
      return queue.shift() ?? null
    }
  }
}

let dir = ''
/** A home with nothing in it, so `withUserBins` has nothing to prepend. */
let home = ''
/**
 * The module keeps the resolved environment for the life of the process, which
 * is right for an app that starts once and wrong for a test file — so every
 * test gets its own copy of the module, and its own empty cache.
 */
let mod: typeof import('./shell-env')

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hd-shell-env-'))
  home = join(dir, 'home')
  mkdirSync(home)
  vi.resetModules()
  mod = await import('./shell-env')
})

afterEach(() => {
  onPlatform(HOST)
  vi.unstubAllEnvs()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('defaultShell', () => {
  it('uses the shell the user actually logs in with', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/usr/bin/fish')

    expect(mod.defaultShell()).toBe('/usr/bin/fish')
  })

  /** macOS ships zsh, and its /bin/bash is still 3.2. */
  it('falls back to zsh on macOS when SHELL is unset', () => {
    onPlatform('darwin')
    vi.stubEnv('SHELL', undefined)

    expect(mod.defaultShell()).toBe('/bin/zsh')
  })

  it('falls back to bash everywhere else when SHELL is unset', () => {
    onPlatform('linux')
    vi.stubEnv('SHELL', undefined)

    expect(mod.defaultShell()).toBe('/bin/bash')
  })

  describe('on Windows', () => {
    beforeEach(() => {
      onPlatform('win32')
      // Nothing is installed until a test puts it there.
      vi.stubEnv('SystemRoot', dir)
      vi.stubEnv('ProgramFiles', dir)
      vi.stubEnv('LOCALAPPDATA', dir)
      vi.stubEnv('COMSPEC', undefined)
    })

    /** A Windows app launched from a WSL shell inherits SHELL=/bin/bash. */
    it('ignores SHELL, which on Windows is never a Windows shell', () => {
      vi.stubEnv('SHELL', '/bin/bash')

      expect(mod.defaultShell()).toBe(join(dir, 'System32', 'cmd.exe'))
    })

    it('prefers PowerShell 7 where it is installed', () => {
      const pwsh = join(dir, 'PowerShell', '7', 'pwsh.exe')
      mkdirSync(join(dir, 'PowerShell', '7'), { recursive: true })
      writeFileSync(pwsh, '')

      expect(mod.defaultShell()).toBe(pwsh)
    })

    /** The store install puts pwsh in WindowsApps and nowhere else. */
    it('finds the one installed from the store when Program Files has none', () => {
      const pwsh = join(dir, 'Microsoft', 'WindowsApps', 'pwsh.exe')
      mkdirSync(join(dir, 'Microsoft', 'WindowsApps'), { recursive: true })
      writeFileSync(pwsh, '')

      expect(mod.defaultShell()).toBe(pwsh)
    })

    it('falls back to the PowerShell that ships with the OS', () => {
      const legacy = join(dir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      mkdirSync(join(dir, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true })
      writeFileSync(legacy, '')

      expect(mod.defaultShell()).toBe(legacy)
    })

    it('falls back to whatever COMSPEC names when no PowerShell is there', () => {
      vi.stubEnv('COMSPEC', 'D:\\shells\\cmd.exe')

      expect(mod.defaultShell()).toBe('D:\\shells\\cmd.exe')
    })

    it('falls back to cmd.exe under the Windows directory with nothing left to ask', () => {
      expect(mod.defaultShell()).toBe(join(dir, 'System32', 'cmd.exe'))
    })
  })
})

describe('resolveShellEnv', () => {
  beforeEach(() => {
    onPlatform('linux')
    vi.stubEnv('SHELL', '/bin/zsh')
    // An empty home keeps `withUserBins` out of the PATH assertions below.
    vi.stubEnv('HOME', home)
  })

  it('takes the PATH the login shell reported over the one the app inherited', async () => {
    vi.stubEnv('PATH', '/usr/bin')
    const { probe } = probing(reported('PATH=/opt/homebrew/bin:/usr/bin'))

    expect((await mod.resolveShellEnv(probe)).PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('keeps variables the login shell set that the app had never heard of', async () => {
    const { probe } = probing(reported('PATH=/usr/bin\nANTHROPIC_API_KEY=from-zshrc'))

    expect((await mod.resolveShellEnv(probe)).ANTHROPIC_API_KEY).toBe('from-zshrc')
  })

  it('asks the shell to load the files people put their PATH edits in', async () => {
    const { probe, calls } = probing(reported('PATH=/usr/bin'))

    await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(1)
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args.slice(0, 3)).toEqual(['-l', '-i', '-c'])
    expect(calls[0].args[3]).toContain('env')
  })

  /** A .zshrc that refuses to run interactively is common enough to plan for. */
  it('drops -i and tries again when the interactive shell says nothing', async () => {
    const { probe, calls } = probing(null, reported('PATH=/opt/second-try/bin'))

    const env = await mod.resolveShellEnv(probe)

    expect(calls.map((c) => c.args.slice(0, -1))).toEqual([
      ['-l', '-i', '-c'],
      ['-l', '-c']
    ])
    expect(env.PATH).toBe('/opt/second-try/bin')
  })

  it('drops -l too before it gives up', async () => {
    const { probe, calls } = probing(null, null, reported('PATH=/opt/third-try/bin'))

    const env = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(3)
    expect(calls[2].args.slice(0, -1)).toEqual(['-c'])
    expect(env.PATH).toBe('/opt/third-try/bin')
  })

  /**
   * The Finder-launch fallback. A shell that hangs, is missing, or dies in its
   * own rc file must leave the app with a working environment, not an empty one.
   */
  it('falls back to the environment the app already had when every attempt fails', async () => {
    vi.stubEnv('PATH', '/usr/bin')
    const { probe, calls } = probing()

    const env = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(3)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe(home)
  })

  it('ignores output that arrived without the markers around it', async () => {
    vi.stubEnv('PATH', '/usr/bin')
    const { probe, calls } = probing('PATH=/opt/not-really/bin\n')

    const env = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(3)
    expect(env.PATH).toBe('/usr/bin')
  })

  /** Half a probe is not a probe: the second marker is what says `env` finished. */
  it('ignores output the shell was cut off in the middle of', async () => {
    vi.stubEnv('PATH', '/usr/bin')
    const { probe } = probing(`${MARKER}\nPATH=/opt/cut-short/bin\nHOME=`)

    expect((await mod.resolveShellEnv(probe)).PATH).toBe('/usr/bin')
  })

  it('goes on looking when the shell answered without a PATH at all', async () => {
    vi.stubEnv('PATH', '/usr/bin')
    const { probe, calls } = probing(reported('LANG=en_GB.UTF-8'))

    const env = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(3)
    // The whole answer was discarded with the attempt, not merged in anyway.
    expect(env.LANG).toBe(process.env.LANG)
  })

  it('keeps a value that runs on past the end of its line together', async () => {
    const key = '-----BEGIN KEY-----\nnot really a key\n-----END KEY-----'
    const { probe } = probing(reported(`PATH=/usr/bin\nSIGNING_KEY=${key}\nLANG=C`))

    const env = await mod.resolveShellEnv(probe)

    expect(env.SIGNING_KEY).toBe(key)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.LANG).toBe('C')
  })

  /**
   * Marked failing because it describes what should happen, and does not.
   *
   * Since the Shellshock fix, bash exports a function as `BASH_FUNC_name%%`,
   * and the `%` characters put that name outside the key pattern parseEnv
   * accepts — so both of its lines fall through to the continuation branch and
   * are appended to whatever variable came before it. `export -f` in a .bashrc
   * is all it takes, and when the variable before it is PATH every pane on the
   * machine inherits a PATH with a shell function embedded in it.
   */
  it('keeps an exported bash function out of the variable before it', async () => {
    const { probe } = probing(reported('PATH=/usr/bin\nBASH_FUNC_greet%%=() {  echo hi\n}\nLANG=C'))

    expect((await mod.resolveShellEnv(probe)).PATH).toBe('/usr/bin')
  })

  /** These describe the probe shell, and the panes are not the probe shell. */
  it('does not carry the probe shell‘s own bookkeeping over to the panes', async () => {
    const { probe } = probing(
      reported('PATH=/usr/bin\n_=/usr/bin/env\nSHLVL=4\nPWD=/tmp/probe\nOLDPWD=/')
    )

    const env = await mod.resolveShellEnv(probe)

    expect(env.PWD).not.toBe('/tmp/probe')
    expect(env.SHLVL).not.toBe('4')
    expect(env._).not.toBe('/usr/bin/env')
  })

  it('runs the shell once and hands the same environment back after that', async () => {
    const { probe, calls } = probing(reported('PATH=/opt/once/bin'))

    const first = await mod.resolveShellEnv(probe)
    const second = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(1)
    expect(second).toBe(first)
  })

  /** A cold .zshrc sourcing nvm takes well over a second before it reaches env. */
  it('waits longer on macOS than it does elsewhere', async () => {
    onPlatform('darwin')
    const slow = probing(reported('PATH=/usr/bin'))
    await mod.resolveShellEnv(slow.probe)

    vi.resetModules()
    const fresh = await import('./shell-env')
    onPlatform('linux')
    const quick = probing(reported('PATH=/usr/bin'))
    await fresh.resolveShellEnv(quick.probe)

    expect(slow.calls[0].timeout).toBeGreaterThan(quick.calls[0].timeout)
  })

  it('never goes looking for a login shell on Windows', async () => {
    onPlatform('win32')
    const { probe, calls } = probing(reported('PATH=/opt/never-asked/bin'))

    const env = await mod.resolveShellEnv(probe)

    expect(calls).toHaveLength(0)
    expect(env.PATH).toContain(process.env.PATH ?? '')
  })
})

describe('shellEnv', () => {
  beforeEach(() => {
    onPlatform('linux')
    vi.stubEnv('HOME', home)
  })

  /** Everything that spawns — git, voice, every pane — reads it through this. */
  it('answers from the process environment before the probe has run', () => {
    vi.stubEnv('PATH', '/usr/bin')

    expect(mod.shellEnv().PATH).toBe('/usr/bin')
  })

  it('hands back what the login shell reported once the probe has finished', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const { probe } = probing(reported('PATH=/opt/homebrew/bin\nANTHROPIC_API_KEY=from-zshrc'))
    const resolved = await mod.resolveShellEnv(probe)

    expect(mod.shellEnv()).toBe(resolved)
    expect(mod.shellEnv().ANTHROPIC_API_KEY).toBe('from-zshrc')
  })

  /**
   * The other half of the Finder problem: a bun or cargo install lands in a
   * directory the login shell would have added, and a probe that failed did not.
   */
  it('adds the per-user bin directories PATH has missed, in the order it knows them', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    mkdirSync(join(home, '.cargo', 'bin'), { recursive: true })
    vi.stubEnv('PATH', '/usr/bin')

    expect(mod.shellEnv().PATH).toBe(
      [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), '/usr/bin'].join(delimiter)
    )
  })

  it('adds nothing for a directory that is not there', () => {
    vi.stubEnv('PATH', '/usr/bin')

    expect(mod.shellEnv().PATH).toBe('/usr/bin')
  })

  it('does not add a directory PATH already has', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    const path = [join(home, '.local', 'bin'), '/usr/bin'].join(delimiter)
    vi.stubEnv('PATH', path)

    expect(mod.shellEnv().PATH).toBe(path)
  })

  it('leaves the process environment itself alone', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    vi.stubEnv('PATH', '/usr/bin')

    mod.shellEnv()

    expect(process.env.PATH).toBe('/usr/bin')
  })
})
