import { expect, it } from 'vitest'
import { personalCliLaunch, runPersonalCli, subscriptionEnvironment, type PersonalCliRequest } from './personal-cli'

const request = (): PersonalCliRequest => ({ cli: { provider: 'chatgpt', environment: 'native', command: process.execPath },
  args: [], signal: new AbortController().signal, timeout: 3000 })

it('strips inherited API routes and keys without changing the CLI credential home', () => {
  const env = subscriptionEnvironment({ PATH: '/tools', CODEX_HOME: '/private/codex', CLAUDE_CONFIG_DIR: '/private/claude',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_BASE_URL: 'https://other-provider', OPENROUTER_API_KEY: 'secret', WSLENV: 'OPENROUTER_API_KEY:HD_CWD/p' })
  expect(env).toEqual({ PATH: '/tools', CODEX_HOME: '/private/codex', CLAUDE_CONFIG_DIR: '/private/claude' })
})

it('uses WSL positional arguments for schemas and quoted Windows shims', () => {
  const r = request(); r.cli = { provider: 'chatgpt', environment: 'wsl', command: 'wsl.exe' }; r.cwd = 'C:\\private files'; r.controlDir = 'C:\\temporary files'
  r.args = ['exec', '--output-schema', 'C:\\temporary files\\reply.json', '-']
  const launch = personalCliLaunch(r, 'win32')
  expect(launch.args).toContain(r.cwd)
  expect(launch.args).toContain(r.controlDir)
  expect(launch.args.at(-1)).toBe('-')
  expect(launch.args[3]).toContain('unset OPENAI_API_KEY')
  expect(launch.args[3]).toContain('wslpath -u "$2"')
  expect(launch.args[3]).toContain('setsid timeout')
  expect(launch.args[3]).not.toContain(r.cwd)
  r.cli = { ...r.cli, environment: 'native', command: "C:\\some folder\\codex.cmd" }
  r.args = ['exec', '--model', "a'$()`b"]
  expect(personalCliLaunch(r, 'win32').args.at(-1)).toContain("'a''$()`b'; exit $LASTEXITCODE")
})

it('pipes prompts through stdin and preserves unicode output', async () => {
  const r = request(); r.input = 'private prompt $() `code` — café'
  r.args = ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>process.stdout.write(s))']
  expect(await runPersonalCli(r)).toEqual({ ok: true, stdout: r.input, stderr: '' })
})

it('bounds hung children and cancels an active CLI process', async () => {
  const r = request(); r.args = ['-e', 'setInterval(()=>{},1000)']; r.timeout = 150
  expect((await runPersonalCli(r)).ok).toBe(false)
  const controller = new AbortController(); r.timeout = 3000; r.signal = controller.signal
  const running = runPersonalCli(r)
  setTimeout(() => controller.abort(), 100)
  await expect(running).rejects.toThrow()
})

it('returns a bounded failure for missing binaries and excess output', async () => {
  const r = request(); r.cli.command = '/no/such/hd-agent'
  expect((await runPersonalCli(r)).ok).toBe(false)
  r.cli.command = process.execPath; r.args = ['-e', 'process.stdout.write("x".repeat(3*1024*1024))']
  const result = await runPersonalCli(r)
  expect(result.ok).toBe(false)
  expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024)
})
