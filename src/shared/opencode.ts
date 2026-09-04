/**
 * Launch options for the OpenCode TUI, and the argv they compose into.
 *
 * OpenCode is launched like every other harness — a command line a pane runs —
 * so this file's whole job is composing that command line from options a human
 * would rather pick than type: a model, an agent, whether to resume, the
 * prompt. The flags are the TUI's own (`opencode --help`), and everything here
 * is pure so the tests can hold the grammar without a terminal attached.
 *
 * `--title` is deliberately absent: `opencode run` takes one, the TUI does not.
 */
import { quote } from './remote'

export interface OpencodeLaunch {
  /** `provider/model`, as `opencode models` prints them. Empty keeps opencode's default. */
  model?: string
  /** An agent name, as `opencode agent list` prints them. */
  agent?: string
  /** What the session starts from: fresh, the last one, or a named one. */
  resume?: 'new' | 'continue' | { id: string }
  /** Copy the resumed session instead of appending to it. Needs a resume. */
  fork?: boolean
  /** Auto-approve every permission opencode would otherwise ask about. */
  auto?: boolean
  /** The prompt the TUI opens with. */
  prompt?: string
}

const clean = (value?: string): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** The profile ids the opencode dialog belongs to — native and WSL alike. */
export function isOpencodeProfile(profileId: string): boolean {
  return profileId === 'agent:opencode' || profileId === 'wsl:opencode'
}

/** opencode's own argv for the TUI with these options, binary excluded. */
export function opencodeArgs(launch: OpencodeLaunch): string[] {
  const args: string[] = []
  const model = clean(launch.model)
  if (model) args.push('--model', model)
  const agent = clean(launch.agent)
  if (agent) args.push('--agent', agent)
  const resuming = launch.resume === 'continue' || Boolean(launch.resume && typeof launch.resume === 'object')
  if (launch.resume === 'continue') args.push('--continue')
  if (launch.resume && typeof launch.resume === 'object') {
    const id = clean(launch.resume.id)
    if (id) args.push('--session', id)
  }
  if (launch.fork && resuming) args.push('--fork')
  if (launch.auto) args.push('--auto')
  const prompt = clean(launch.prompt)
  if (prompt) args.push('--prompt', prompt)
  return args
}

/**
 * The same argv as one POSIX command line — the inner line of a WSL launcher's
 * login shell, where argv does not exist and quoting does. Values arrive as a
 * single argument each, so single-quoting them is enough.
 */
export function opencodeShellLine(launch: OpencodeLaunch, bin = 'opencode'): string {
  const parts = [bin]
  for (const arg of opencodeArgs(launch)) {
    parts.push(/^[A-Za-z0-9_@.~/:=+-]+$/.test(arg) ? arg : quote(arg))
  }
  return parts.join(' ')
}

/**
 * The full WSL launcher script — the same `cd "$HD_CWD"` shape `profiles.ts`
 * composes for a bare launch, so the pane lands in the workspace folder before
 * opencode starts. `HD_CWD` is the translated workspace path; when the courier
 * loses it the cd fails quietly and opencode opens where WSL lands.
 */
export function opencodeWslScript(launch: OpencodeLaunch, bin = 'opencode'): string {
  return `cd "$HD_CWD" 2>/dev/null; exec ${opencodeShellLine(launch, bin)}`
}

/**
 * A short suffix for the pane header: the model's tail, else the agent, else
 * the prompt's first few words. Empty when nothing was chosen — the pane has
 * nothing to say beyond its harness name, so it keeps that name alone.
 */
export function opencodePaneSuffix(launch: OpencodeLaunch): string | null {
  const model = clean(launch.model)
  if (model) return model.split('/').pop() ?? model
  const agent = clean(launch.agent)
  if (agent) return agent
  const prompt = clean(launch.prompt)
  if (prompt) return prompt.length > 32 ? `${prompt.slice(0, 31)}…` : prompt
  if (launch.resume === 'continue') return 'last session'
  if (launch.resume && typeof launch.resume === 'object') return 'resumed'
  return null
}
