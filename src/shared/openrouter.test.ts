import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentLaunch } from './agent-session'
import { routeOpenRouter } from './openrouter'
import type { PaneSpec } from './types'
import { parseForESLint } from 'toml-eslint-parser'

const pane = (command = 'codex'): PaneSpec => ({ id: 'a', command, args: [], cwd: tmpdir(),
  openRouter: { model: 'openai/test-model' } })
const wsl = (agent = 'codex'): PaneSpec => ({ ...pane('wsl.exe'), args: ['-e', 'bash', '-lic',
  `cd "$HD_CWD" 2>/dev/null; exec ${agent}`] })

describe('OpenRouter launch boundaries', () => {
  it('leaves existing launches and their authentication alone', () => {
    const spec = { ...pane(), openRouter: undefined }
    expect(routeOpenRouter(spec, null)).toBe(spec)
  })
  it.each(['linux', 'win32'] as const)('builds valid Responses/auth configuration on %s without argv secrets', platform => {
    const routed = routeOpenRouter(pane(), 'secret-router-key', platform)
    expect(routed.env!.OPENROUTER_API_KEY).toBe('secret-router-key')
    expect(routed.args.join(' ')).not.toContain('secret-router-key')
    expect(routed.args).toContain('--no-daemon')
    const config = routed.args.filter((_, i) => routed.args[i - 1] === '-c').join('\n')
    expect(() => parseForESLint(config)).not.toThrow()
    expect(config).toContain('wire_api="responses"')
    expect(config).toContain('https://openrouter.ai/api/v1')
    expect(config).toContain(platform === 'win32' ? 'powershell.exe' : 'command="sh"')
  })
  it('overrides Anthropic auth and alternate backends only for the selected pane', () => {
    const spec = { ...pane('claude'), env: { ANTHROPIC_API_KEY: 'old', CLAUDE_CODE_USE_BEDROCK: '1' },
      openRouter: { model: 'anthropic/test-model' } }
    const routed = routeOpenRouter(spec, 'router-key')
    expect(routed.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      ANTHROPIC_AUTH_TOKEN: 'router-key', ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/test-model' })
    expect(spec.env.ANTHROPIC_API_KEY).toBe('old')
  })
  it('refuses unsupported launchers and absent native credentials', () => {
    expect(() => routeOpenRouter(pane('ssh'), 'secret')).toThrow('launcher')
    expect(() => routeOpenRouter({ ...pane(), viaShell: true }, 'secret')).toThrow('launcher')
    expect(() => routeOpenRouter(pane(), null)).toThrow('OpenRouter key')
  })
  it.each(['', 'gpt-5', 'openai/model;touch /tmp/owned', 'openai/$(id)'])('rejects invalid model ID %j', model => {
    expect(() => routeOpenRouter({ ...pane(), openRouter: { model } }, 'secret')).toThrow('model ID')
  })
  it('preserves WSL session variables while forwarding only the credential courier', () => {
    const spec = { ...wsl(), env: { WSLENV: 'HD_SESSION_FILE/p:OTHER:HD_OPENROUTER_API_KEY/p' } }
    const routed = routeOpenRouter(spec, 'router-key', 'win32')
    expect(routed.env!.WSLENV).toBe('HD_SESSION_FILE/p:OTHER:HD_OPENROUTER_API_KEY/u')
    expect(routed.args.join(' ')).not.toContain('router-key')
    expect(agentLaunch(spec)?.agent).toBe('codex')
  })
  it.skipIf(process.platform === 'win32')('applies WSL auth after login settings, with shell metacharacters kept as data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hd-router-shell-'))
    try {
      const fake = join(dir, 'claude')
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_API_KEY" "$CLAUDE_CODE_SUBAGENT_MODEL"\nprintf "%s\\n" "$@"\n')
      chmodSync(fake, 0o755)
      const spec = { ...wsl('claude'), openRouter: { model: '~anthropic/claude-sonnet-latest[1m]' },
        env: { HD_WORK_BIN: dir } }
      const key = 'dummy-$(exit 42)-`exit 43`'
      const routed = routeOpenRouter(spec, key, 'win32')
      const output = execFileSync('bash', ['-c', routed.args[3]], { encoding: 'utf8',
        env: { ...process.env, ...routed.env, HD_CWD: dir, OPENROUTER_API_KEY: 'old-login-key',
          ANTHROPIC_BASE_URL: 'https://old.invalid', ANTHROPIC_API_KEY: 'old-anthropic' } })
      const lines = output.split('\n')
      expect(lines.slice(0, 4)).toEqual(['https://openrouter.ai/api', key, '', '~anthropic/claude-sonnet-latest[1m]'])
      expect(lines.slice(-3)).toEqual(['--model', '~anthropic/claude-sonnet-latest[1m]', ''])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('uses a WSL-only key and refuses an empty key before launching', () => {
    const spec = wsl('claude')
    const script = routeOpenRouter(spec, null, 'win32').args[3]
    expect(script).not.toContain('HD_OPENROUTER_API_KEY')
    expect(() => execFileSync('bash', ['-c', script], { env: { ...process.env,
      OPENROUTER_API_KEY: '', HD_CWD: tmpdir() }, stdio: 'pipe' })).toThrow('No OpenRouter key')
  })
  it('retains Claude hooks and permissions while pinning the routing endpoint over project settings', () => {
    const spec = { ...pane('claude'), args: ['--settings', JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://old.invalid', OTHER: 'keep' },
      hooks: { SessionStart: ['keep'] }, permissions: { defaultMode: 'default' }
    }), '--model', 'old'], openRouter: { model: 'anthropic/test' } }
    const routed = routeOpenRouter(spec, 'dummy')
    const settings = JSON.parse(routed.args[routed.args.indexOf('--settings') + 1])
    expect(settings).toMatchObject({ env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', OTHER: 'keep' },
      hooks: { SessionStart: ['keep'] }, permissions: { defaultMode: 'default' } })
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(routed.args.filter(arg => arg === '--model')).toHaveLength(1)
    expect(routed.args).not.toContain('old')
  })
})
