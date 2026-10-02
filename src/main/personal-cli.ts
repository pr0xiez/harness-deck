import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonalCliEnvironment, PersonalProvider } from '@shared/personal-agent'
import { detectProfiles } from './profiles'
import { powershellShimLine } from './opencode'
import { shellEnv } from './shell-env'

export type SubscriptionProvider = Exclude<PersonalProvider, 'openrouter'>
export interface PersonalCli {
  provider: SubscriptionProvider; command: string; environment: 'native' | 'wsl'
}
export interface PersonalCliRequest {
  cli: PersonalCli; args: string[]; cwd?: string; input?: string; signal: AbortSignal; controlDir?: string
  timeout: number
}
export interface PersonalCliResult { ok: boolean; stdout: string; stderr: string }
export type PersonalCliRunner = (request: PersonalCliRequest) => Promise<PersonalCliResult>

// Subscription runs must never inherit API billing or a custom provider route.
export const SUBSCRIPTION_ENV_REMOVE = [
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN',
  'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SIMPLE', 'CLAUDECODE',
  'HD_CWD', 'HD_WORK_DISCOVERY', 'HD_WORK_WORKSPACE', 'HD_WORK_BIN'
]
export function subscriptionEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of Object.keys(env)) if (SUBSCRIPTION_ENV_REMOVE.includes(key.toUpperCase())) delete env[key]
  // Do not forward a pane's working directory or provider key back into WSL.
  delete env.WSLENV
  return env
}

export async function resolvePersonalCli(provider: SubscriptionProvider, environment: PersonalCliEnvironment): Promise<PersonalCli | null> {
  const harness = provider === 'chatgpt' ? 'codex' : 'claude'
  const profiles = await detectProfiles()
  for (const kind of environment === 'auto' ? ['native', 'wsl'] as const : [environment]) {
    const profile = profiles.find(p => p.id === `${kind === 'wsl' ? 'wsl' : 'agent'}:${harness}` && p.available)
    if (profile) return { provider, environment: kind, command: profile.command }
  }
  return null
}

export function personalCliLaunch(request: PersonalCliRequest, platform = process.platform): { command: string; args: string[] } {
  const { cli, args, cwd, timeout } = request
  if (cli.environment === 'wsl') {
    // Positional argv carries paths/flags without placing prompts in a shell string.
    // Clear routing again AFTER loading bashrc, which may export API credentials.
    const script = `unset ${SUBSCRIPTION_ENV_REMOVE.join(' ')}; set +m; ` +
      'export PATH="$HOME/.local/bin:$PATH"; ' +
      'if [ "$1" != "" ]; then cd -- "$(wslpath -u "$1")" || exit 1; fi; shift; ' +
      'control=$(wslpath -u "$1") || exit 1; shift; ' +
      'agent_args=(); while [ "$#" -gt 0 ]; do if [ "$1" = "--output-schema" ]; then ' +
      'agent_args+=("$1" "$(wslpath -u "$2")"); shift 2; else agent_args+=("$1"); shift; fi; done; ' +
      '[ -e "$control/cancelled" ] && exit 130; ' +
      `setsid timeout -k 5s ${Math.ceil(timeout / 1000)}s "\${agent_args[@]}" <&0 & agent_pid=$!; ` +
      'printf "%s\\n" "$agent_pid" > "$control/pid"; ' +
      '[ -e "$control/cancelled" ] && kill -KILL -- "-$agent_pid" 2>/dev/null; ' +
      'wait "$agent_pid"; exit $?'
    return { command: cli.command, args: ['-e', 'bash', '-lic', script, 'hd-personal', cwd || '', request.controlDir || '', cli.provider === 'chatgpt' ? 'codex' : 'claude', ...args] }
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cli.command)) {
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return { command: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellShimLine(cli.command, args) + '; exit $LASTEXITCODE'] }
  }
  return { command: cli.command, args }
}

/** Prompts use stdin. Output is bounded and raw CLI failures never cross IPC. */
export const runPersonalCli: PersonalCliRunner = async request => {
  request.signal.throwIfAborted()
  const controlDir = request.cli.environment === 'wsl' ? mkdtempSync(join(tmpdir(), 'hd-personal-cli-')) : undefined
  const launch = personalCliLaunch({ ...request, controlDir })
  const env = subscriptionEnvironment(shellEnv())
  return new Promise((resolve, reject) => {
    let stopped = false
    let outputBytes = 0
    let stdout = ''
    let stderr = ''
    const child = spawn(launch.command, launch.args, {
      cwd: request.cli.environment === 'wsl' ? undefined : request.cwd,
      env, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe'
    })
    const stopTree = (): void => {
      if (stopped || !child.pid) return
      stopped = true
      if (controlDir) {
        // Killing wsl.exe alone can leave inference running inside Linux.
        // The marker also closes the race where Stop arrives before its PID.
        writeFileSync(join(controlDir, 'cancelled'), '')
        const cleanup = 'control=$(wslpath -u "$1") || exit 1; if [ -r "$control/pid" ]; then read -r group < "$control/pid"; case "$group" in ""|*[!0-9]*) ;; *) kill -KILL -- "-$group" 2>/dev/null ;; esac; fi'
        execFile(request.cli.command, ['-e', 'bash', '-c', cleanup, 'hd-personal-stop', controlDir], { env, windowsHide: true, timeout: 5000 }, () => {})
      } else if (process.platform === 'win32') {
        execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {})
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const timer = setTimeout(stopTree, request.timeout)
    const backstop = setTimeout(() => child.kill('SIGKILL'), request.timeout + 5000)
    const abort = (): void => { stopTree() }
    let failed = false
    child.on('error', () => { failed = true })
    for (const [stream, output] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > 2 * 1024 * 1024) { stopTree(); return }
        if (output === 'stdout') stdout += chunk
        else stderr += chunk
      })
    }
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(backstop); request.signal.removeEventListener('abort', abort)
      if (controlDir) rmSync(controlDir, { recursive: true, force: true })
      if (request.signal.aborted) reject(request.signal.reason)
      else resolve({ ok: !failed && code === 0 && !stopped, stdout, stderr })
    })
    request.signal.addEventListener('abort', abort, { once: true })
    child.stdin?.on('error', () => {})
    child.stdin?.end(request.input || '')
    if (request.signal.aborted) abort()
  })
}
