import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * A GUI-launched Electron app inherits a bare environment: none of the PATH
 * entries a user sets up in .zshrc / .bash_profile are present, so agent CLIs
 * installed in ~/.local/bin or a version manager's shims are invisible. We
 * resolve the environment of a real login shell once at startup and use it as
 * the base environment for every pane we spawn (same trick VS Code uses).
 */

let cached: NodeJS.ProcessEnv | null = null

const MARKER = '__HARNESS_DECK_ENV__'

const EXTRA_PATH_CANDIDATES = [
  '.local/bin',
  'bin',
  '.bun/bin',
  '.cargo/bin',
  '.deno/bin',
  '.npm-global/bin',
  '.volta/bin',
  'go/bin'
]

/**
 * Windows PATH can be unusable — most often when the app is started from a WSL
 * shell, which hands its Linux PATH to the Windows process. Make sure the
 * directories that matter (System32, global npm) are always searchable.
 */
function withWindowsBins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(root, 'System32'),
    join(root),
    join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    join(env.APPDATA || '', 'npm'),
    join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    join(env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps')
  ].filter((dir) => dir && isAbsolute(dir) && existsSync(dir))

  const current = (env.Path || env.PATH || '').split(';').filter(Boolean)
  const missing = candidates.filter(
    (dir) => !current.some((entry) => entry.toLowerCase() === dir.toLowerCase())
  )
  if (!missing.length) return env
  const merged = [...current, ...missing].join(';')
  return { ...env, PATH: merged, Path: merged }
}

export function defaultShell(): string {
  if (process.platform === 'win32') {
    return findWindowsShell()
  }
  return process.env.SHELL || '/bin/bash'
}

function findWindowsShell(): string {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const pwsh = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ].find((p) => p && existsSync(p))
  if (pwsh) return pwsh
  const legacy = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(legacy)) return legacy
  return process.env.COMSPEC || join(root, 'System32', 'cmd.exe')
}

/** Adds the usual per-user bin directories that exist but are missing from PATH. */
function withUserBins(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return withWindowsBins(env)
  const home = homedir()
  const current = (env.PATH || '').split(delimiter).filter(Boolean)
  const missing = EXTRA_PATH_CANDIDATES.map((rel) => join(home, rel)).filter(
    (dir) => existsSync(dir) && !current.includes(dir)
  )
  if (!missing.length) return env
  return { ...env, PATH: [...missing, ...current].join(delimiter) }
}

/**
 * Runs the user's login shell to capture its environment. Falls back to the
 * process environment if the shell misbehaves or takes too long.
 */
export async function resolveShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cached) return cached
  if (process.platform === 'win32') {
    // No login shell to probe, but PATH still needs the usual repairs.
    cached = withUserBins({ ...process.env })
    return cached
  }

  const shell = defaultShell()
  const script = `echo ${MARKER}; env; echo ${MARKER}`
  // -i loads .zshrc/.bashrc where most people put their PATH edits.
  const attempts: string[][] = [
    ['-l', '-i', '-c', script],
    ['-l', '-c', script],
    ['-c', script]
  ]

  for (const args of attempts) {
    const out = await run(shell, args, 4000)
    if (!out) continue
    const parsed = parseEnv(out)
    if (parsed?.PATH) {
      cached = withUserBins({ ...process.env, ...parsed })
      return cached
    }
  }

  cached = withUserBins({ ...process.env })
  return cached
}

/** Synchronous access for code paths that run after resolveShellEnv(). */
export function shellEnv(): NodeJS.ProcessEnv {
  return cached ?? withUserBins({ ...process.env })
}

function run(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (stdout && stdout.includes(MARKER)) return resolve(stdout)
        resolve(err ? null : stdout || null)
      }
    )
    child.on('error', () => resolve(null))
  })
}

function parseEnv(output: string): NodeJS.ProcessEnv | null {
  const start = output.indexOf(MARKER)
  const end = output.lastIndexOf(MARKER)
  if (start === -1 || end === start) return null
  const body = output.slice(start + MARKER.length, end)
  const env: NodeJS.ProcessEnv = {}
  let lastKey: string | null = null
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq) : ''
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = line.slice(eq + 1)
      lastKey = key
    } else if (lastKey && line) {
      // multi-line values (e.g. exported functions)
      env[lastKey] += `\n${line}`
    }
  }
  // Never inherit these from the probe shell.
  delete env._
  delete env.SHLVL
  delete env.PWD
  delete env.OLDPWD
  return Object.keys(env).length ? env : null
}
