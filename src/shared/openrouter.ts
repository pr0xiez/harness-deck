import { agentLaunch } from './agent-session'
import { quote } from './remote'
import type { PaneSpec } from './types'

export interface OpenRouterRoute { model: string }
export interface OpenRouterModels { models: string[]; error?: string }

export function isRouterProfile(id: string): boolean {
  return /^(agent|wsl):(claude|codex)$/.test(id)
}

export function validateRouterModel(model: unknown): string {
  if (typeof model !== 'string' || !/^~?[a-z0-9-]+\/[A-Za-z0-9._:/+\[\]-]+$/.test(model.trim())) {
    throw new Error('Choose a complete OpenRouter model ID, including its provider prefix.')
  }
  return model.trim()
}

const claudeEnv = (model: string): Record<string, string> => ({
  ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
  ANTHROPIC_API_KEY: '',
  CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '0',
  CLAUDE_CODE_USE_VERTEX: '0',
  CLAUDE_CODE_USE_FOUNDRY: '0',
  ANTHROPIC_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: '~anthropic/claude-opus-latest',
  ANTHROPIC_DEFAULT_SONNET_MODEL: '~anthropic/claude-sonnet-latest',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: '~anthropic/claude-haiku-latest',
  CLAUDE_CODE_SUBAGENT_MODEL: model,
  ANTHROPIC_SMALL_FAST_MODEL: '~anthropic/claude-haiku-latest'
})

/** Applied only at spawn, after session tracking; no secret enters persisted argv/env. */
export function routeOpenRouter(spec: PaneSpec, key: string | null, platform = process.platform,
  inheritedWslEnv = ''): PaneSpec {
  if (!spec.openRouter) return spec
  const launch = agentLaunch(spec)
  if (!launch || !['claude', 'codex'].includes(launch.agent)) {
    throw new Error('OpenRouter requires a native or generated WSL Claude Code / Codex launcher.')
  }
  const model = validateRouterModel(spec.openRouter.model)
  if (!key && !launch.wsl) throw new Error('Add an OpenRouter key in Settings or export OPENROUTER_API_KEY before starting Deck.')
  const env = { ...spec.env }
  // Explicit pane routing wins over model flags added through Edit pane.
  const args: string[] = []
  for (let i = 0; i < launch.args.length; i++) {
    const arg = launch.args[i]
    if (arg === '--model' || arg === '-m') { i++; continue }
    if (arg.startsWith('--model=') || arg.startsWith('-m=')) continue
    args.push(arg)
  }
  if (launch.agent === 'codex') {
    const windows = platform === 'win32' && !launch.wsl
    const auth = windows
      ? { command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Write-Output $env:OPENROUTER_API_KEY'] }
      : { command: 'sh', args: ['-c', 'printf "%s" "$OPENROUTER_API_KEY"'] }
    // A single table replaces any same-name provider from user config. Key stays in env.
    const authArgs = auth.args.map(a => JSON.stringify(a)).join(',')
    if (!args.includes('--no-daemon')) args.push('--no-daemon')
    args.push('-c', 'model_provider="harness_deck_openrouter"',
      '-c', `model=${JSON.stringify(model)}`,
      '-c', `model_providers.harness_deck_openrouter={name="OpenRouter",base_url="https://openrouter.ai/api/v1",wire_api="responses",supports_websockets=false,auth={command=${JSON.stringify(auth.command)},args=[${authArgs}]}}`,
      '-c', 'web_search="disabled"')
  } else {
    // Pin non-secret routing settings above user/project env blocks, while retaining hooks.
    const at = args.findIndex(arg => arg === '--settings' || arg.startsWith('--settings='))
    let settings: Record<string, any> = {}
    if (at >= 0) {
      const inline = args[at].startsWith('--settings=')
      const raw = inline ? args[at].slice('--settings='.length) : args[at + 1]
      if (!raw?.trim().startsWith('{')) throw new Error('OpenRouter routing requires Claude --settings as inline JSON.')
      settings = JSON.parse(raw)
      args.splice(at, inline ? 1 : 2)
    }
    settings.env = { ...settings.env, ...claudeEnv(model) }
    args.push('--settings', JSON.stringify(settings))
    args.push('--model', model)
  }
  const routed = { ...spec, ...launch.apply(args), env }
  if (!launch.wsl) {
    env.OPENROUTER_API_KEY = key!
    if (launch.agent === 'claude') Object.assign(env, claudeEnv(model), { ANTHROPIC_AUTH_TOKEN: key! })
    return routed
  }
  // A courier variable survives bash's login files; use the WSL shell key when absent.
  if (key) {
    env.HD_OPENROUTER_API_KEY = key
    const entries = (env.WSLENV ?? inheritedWslEnv).split(':').filter(e => e && e.split('/')[0] !== 'HD_OPENROUTER_API_KEY')
    env.WSLENV = [...entries, 'HD_OPENROUTER_API_KEY/u'].join(':')
  }
  const prefix = 'cd "$HD_CWD" 2>/dev/null; exec '
  const script = routed.args[3]
  const exports = launch.agent === 'claude'
    ? Object.entries(claudeEnv(model)).map(([name, value]) => `export ${name}=${quote(value)}; `).join('') +
      'export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"; '
    : ''
  routed.args = [...routed.args]
  routed.args[3] = prefix.slice(0, -'exec '.length) +
    (key ? 'export OPENROUTER_API_KEY="$HD_OPENROUTER_API_KEY"; unset HD_OPENROUTER_API_KEY; ' : '') +
    'if [ -z "$OPENROUTER_API_KEY" ]; then printf "%s\\n" "No OpenRouter key: add one in Deck Settings or export OPENROUTER_API_KEY in WSL." >&2; exit 1; fi; ' +
    exports + (env.HD_WORK_BIN ? 'export PATH="$HD_WORK_BIN:$PATH"; ' : '') +
    'exec ' + script.slice(prefix.length)
  return routed
}
