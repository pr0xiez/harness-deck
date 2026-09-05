import type { PaneSpec } from './types'
import { commandName, quote } from './remote'

export type ResumableAgent = 'codex' | 'claude' | 'opencode'
export interface AgentLaunch {
  agent: ResumableAgent
  args: string[]
  wsl: boolean
  apply: (args: string[]) => Pick<PaneSpec, 'command' | 'args'>
}

const agents = new Set(['codex', 'claude', 'opencode'])
const WSL_PREFIX = 'cd "$HD_CWD" 2>/dev/null; exec '

/** Only decode argv we can round-trip safely; never interpret arbitrary shell code. */
export function shellWords(line: string): string[] | null {
  const words: string[] = []
  let word = '', started = false, quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") { quoted = !quoted; started = true }
    else if (quoted) word += c
    else if (c === '\\' && line[i + 1] === "'") { word += "'"; i++; started = true }
    else if (/\s/.test(c)) {
      if (started) { words.push(word); word = ''; started = false }
    } else if (/[A-Za-z0-9_@.~/:=+,-]/.test(c)) { word += c; started = true }
    else return null
  }
  if (quoted) return null
  if (started) words.push(word)
  return words
}

export function agentLaunch(spec: Pick<PaneSpec, 'command' | 'args' | 'viaShell'>): AgentLaunch | null {
  if (spec.viaShell) return null // These are user-authored shell expressions, not argv.
  const bin = commandName(spec.command).replace(/\.(cmd|bat)$/i, '')
  if (agents.has(bin)) {
    // Non-interactive tools and administrative commands are ordinary processes.
    if (bin === 'codex' && spec.args[0] && !spec.args[0].startsWith('-') &&
        !['resume', 'fork'].includes(spec.args[0])) return null
    if (bin === 'claude' && spec.args.some((a) => ['-p', '--print'].includes(a))) return null
    if (['acp', 'agents', 'attach', 'auth', 'completion', 'db', 'debug', 'doctor', 'export', 'import',
      'install', 'logs', 'mcp', 'models', 'plugin', 'providers', 'run', 'serve', 'session', 'stats',
      'update', 'upgrade', 'web'].includes(spec.args[0])) return null
    return { agent: bin as ResumableAgent, args: spec.args, wsl: false,
      apply: (args) => ({ command: spec.command, args }) }
  }
  if (bin !== 'wsl' || spec.args.length !== 4 || spec.args[0] !== '-e' ||
      spec.args[1] !== 'bash' || spec.args[2] !== '-lic' || !spec.args[3].startsWith(WSL_PREFIX)) return null
  const words = shellWords(spec.args[3].slice(WSL_PREFIX.length))
  if (!words?.length) return null
  const inner = agentLaunch({ command: words[0], args: words.slice(1) })
  if (!inner) return null
  return { ...inner, wsl: true, apply: (args) => ({ command: spec.command,
    args: ['-e', 'bash', '-lic', WSL_PREFIX + [words[0], ...args].map(quote).join(' ')] }) }
}

/** IDs are arguments, never names to resolve by recency or shell expressions. */
export function validSessionId(agent: ResumableAgent, id: unknown): id is string {
  return typeof id === 'string' && (agent === 'opencode'
    ? /^ses_[A-Za-z0-9_-]{1,160}$/.test(id)
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
}

const values = new Set([
  '--model', '-m', '--agent', '--config', '--profile', '--sandbox', '--cd', '-C',
  '--add-dir', '--ask-for-approval', '-a', '--enable', '--disable', '--local-provider',
  '--settings', '--setting-sources', '--permission-mode', '--allowedTools', '--allowed-tools',
  '--disallowedTools', '--disallowed-tools', '--tools', '--mcp-config', '--plugin-dir',
  '--system-prompt', '--system-prompt-file', '--append-system-prompt', '--append-system-prompt-file',
  '--effort', '--name', '-n', '--port', '--hostname', '--log-level', '--replay-limit'
])

/** Preserve launch configuration, but never replay the initial prompt or fork on a restart. */
export function continuationArgs(agent: ResumableAgent, original: string[], id?: string): string[] {
  const kept: string[] = []
  let start = 0
  if (agent === 'codex' && ['resume', 'fork'].includes(original[0])) {
    start = 1
    if (original[1] && !original[1].startsWith('-')) start++
  }
  for (let i = start; i < original.length; i++) {
    const arg = original[i], flag = arg.split('=')[0]
    if (flag === '--') break // Remaining positional input is an initial prompt.
    const target = agent === 'claude' ? ['--resume', '-r', '--session-id']
      : agent === 'opencode' ? ['--session', '-s'] : []
    if (target.includes(flag) || ['--prompt', '--image', '-i'].includes(flag)) {
      if (!arg.includes('=') && original[i + 1] && !original[i + 1].startsWith('-')) i++
      continue
    }
    if (['--continue', '--fork', '--fork-session', '--last', '--all'].includes(flag) ||
        (arg === '-c' && agent !== 'codex')) continue
    if (!arg.startsWith('-')) {
      if (agent === 'opencode') kept.push(arg) // OpenCode's positional argument is the project directory.
      continue
    }
    kept.push(arg)
    if (!arg.includes('=') && (values.has(flag) || (agent === 'codex' && ['-c', '-p', '-s'].includes(flag)))) {
      if (original[i + 1] !== undefined) kept.push(original[++i])
    }
  }
  if (!id) return kept
  if (!validSessionId(agent, id)) throw new Error('Invalid agent session ID')
  return agent === 'codex' ? ['resume', id, ...kept]
    : [...kept, agent === 'claude' ? '--resume' : '--session', id]
}
