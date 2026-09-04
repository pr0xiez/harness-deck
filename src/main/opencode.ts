import { join } from 'node:path'
import type { OpencodeInfo, OpencodeSession } from '@shared/types'
import { decodeWsl, findExecutable } from './profiles'
import { runProcess } from './process'
import { shellEnv } from './shell-env'

/**
 * What the opencode pane dialog offers, asked of the CLI itself.
 *
 * OpenCode can name its models, agents and sessions, and the dialog would
 * rather show them than have them typed. The lists ride the same three CLI
 * invocations a user would run — `models`, `agent list`, `session list
 * --format json` — each with a timeout, each free to come back empty, because
 * every field in the dialog is free text first and a suggestion second. One
 * version's table formatting cannot break the pane; at worst the dialog says
 * less.
 *
 * The answers are cached briefly: the dialog reopens often, each open costs
 * two seconds of CLI warm-up (more through WSL), and a model list that is
 * forty-five seconds stale has never mattered to anyone.
 */

const TIMEOUT = 20000
const MAX_BUFFER = 8 * 1024 * 1024
const CACHE_TTL = 45000

/** `opencode models` prints one `provider/model` per line — anything with a space is prose. */
export function parseModels(out: string): string[] {
  const found = new Set<string>()
  for (const line of out.split('\n')) {
    const name = line.trim()
    if (/^[^\s/]+\/\S+$/.test(name)) found.add(name)
  }
  return [...found]
}

/** `opencode agent list` headers its JSON blobs with `name (primary|subagent)`. */
export function parseAgents(out: string): string[] {
  const found = new Set<string>()
  for (const [, name] of out.matchAll(/^(.+?) \((?:primary|subagent)\)\s*$/gm)) {
    const agent = name.trim()
    if (agent) found.add(agent)
  }
  return [...found]
}

/** `session list --format json` is an array; anything else parses as no sessions. */
export function parseSessions(out: string): OpencodeSession[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const sessions: OpencodeSession[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) continue
    sessions.push({
      id: record.id,
      title: typeof record.title === 'string' && record.title ? record.title : 'Untitled',
      ...(typeof record.updated === 'number' ? { updated: record.updated } : {}),
      ...(typeof record.directory === 'string' && record.directory
        ? { directory: record.directory }
        : {})
    })
  }
  sessions.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  return sessions
}

/**
 * The one way this module runs the CLI: an argv in, the tool's stdout out.
 * Errors are the caller's to flatten into an empty list — see `assembleInfo`.
 */
export type OpencodeRunner = (args: string[]) => Promise<string>

/**
 * execFile cannot launch a Windows `.cmd`/`.bat` shim, and npm's global shims
 * are exactly that. PowerShell can, and its single-quoted strings survive the
 * trip with nothing escaped — the subcommand names are literals here, so the
 * line is fixed whatever the shim path turns out to be.
 */
export function powershellShimLine(command: string, args: string[]): string {
  const quote = (value: string): string => `'${value.split("'").join("''")}'`
  return `& ${quote(command)} ${args.map(quote).join(' ')}`
}

async function runNative(command: string, args: string[], cwd?: string): Promise<string> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const powershell = join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const ran = await runProcess(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellShimLine(command, args)],
      { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, cwd }
    )
    return ran.stdout
  }
  const ran = await runProcess(command, args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER, cwd })
  return ran.stdout
}

/**
 * The WSL launcher's own courier: a login shell over there, so the same PATH
 * the pane sees is the one that finds opencode. The folder rides `HD_CWD`
 * through `WSLENV`'s path translation, exactly as a pane spawn hands it over.
 */
async function runWsl(wsl: string, args: string[], cwd?: string): Promise<string> {
  const inner = `opencode ${args.join(' ')}`
  const script = cwd ? `cd "$HD_CWD" 2>/dev/null; ${inner}` : inner
  const env = { ...process.env }
  if (cwd) {
    env.HD_CWD = cwd
    if (!/(^|:)HD_CWD\//.test(env.WSLENV || '')) {
      env.WSLENV = env.WSLENV ? `${env.WSLENV}:HD_CWD/p` : 'HD_CWD/p'
    }
  }
  // Bytes rather than text, for the same reason the WSL probe decodes: wsl.exe
  // answers in whichever encoding it feels like, and `decodeWsl` sniffs it.
  const ran = await runProcess(wsl, ['-e', 'bash', '-lic', script], {
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
    env,
    encoding: 'buffer'
  })
  return decodeWsl(ran.stdout)
}

/**
 * Picks the courier from the profile id, or answers null when there is no
 * opencode to ask. Only the two detected ids are ours to interpret; anything
 * else runs native, which is what a saved launcher named opencode would want.
 * The folder is bound in, not passed per call — it is one query's context.
 */
export function runnerFor(profileId: string, cwd?: string): OpencodeRunner | null {
  if (profileId.startsWith('wsl:')) {
    const env = shellEnv()
    const wsl =
      findExecutable('wsl.exe', env) ??
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')
    return (args) => runWsl(wsl, args, cwd)
  }
  const command = findExecutable('opencode', shellEnv())
  if (!command) return null
  return (args) => runNative(command, args, cwd)
}

/**
 * The query itself, with the runner already chosen — the seam the tests use.
 * Every list is free to fail; only a silence from all three counts as an error,
 * and even then the dialog's fields stay usable.
 */
export async function assembleInfo(run: OpencodeRunner): Promise<OpencodeInfo> {
  const [models, agents, sessions] = await Promise.all([
    run(['models']).then(parseModels).catch(() => []),
    run(['agent', 'list']).then(parseAgents).catch(() => []),
    run(['session', 'list', '--format', 'json']).then(parseSessions).catch(() => [])
  ])
  const info: OpencodeInfo = { models, agents, sessions }
  if (!models.length && !agents.length && !sessions.length) {
    info.error = 'opencode did not answer — the fields below are free text'
  }
  return info
}

const cache = new Map<string, { at: number; info: OpencodeInfo }>()

/** For the tests, which want each query to actually run. */
export function resetOpencodeCache(): void {
  cache.clear()
}

/** What the opencode dialog asks for, cached for a moment against reopening. */
export async function queryOpencode(profileId: string, cwd?: string): Promise<OpencodeInfo> {
  const cached = cache.get(profileId)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.info

  const runner = runnerFor(profileId, cwd)
  const info = runner
    ? await assembleInfo(runner)
    : { models: [], agents: [], sessions: [], error: 'opencode is not on PATH' }
  cache.set(profileId, { at: Date.now(), info })
  return info
}
