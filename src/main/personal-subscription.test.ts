import { existsSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import type { AgentRun } from './personal-ai'
import type { PersonalCli, PersonalCliRunner } from './personal-cli'
import { resolvePersonalCli } from './personal-cli'
import { parseSubscriptionReply, personalSubscriptionStatus, runPersonalSubscription, SUBSCRIPTION_CACHE_MS, subscriptionArgs, type SubscriptionConnectionCache } from './personal-subscription'

const cli: PersonalCli = { provider: 'chatgpt', command: '/test/codex', environment: 'native' }
const run = (): AgentRun => ({ provider: 'chatgpt', model: '', key: '', system: 'Personal coach', context: '{}', history: [], prompt: 'Plan today',
  tools: [{ name: 'add_task', description: 'Capture a task', parameters: { type: 'object' } }], execute: vi.fn(async () => ({ saved: true })), signal: new AbortController().signal })
const reply = (value: unknown): string => [
  { type: 'thread.started', thread_id: 'private-session' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed' }
].map(e => JSON.stringify(e)).join('\n')
const dependencies = () => ({ resolve: vi.fn<typeof resolvePersonalCli>(async () => cli as PersonalCli | null),
  run: vi.fn<PersonalCliRunner>().mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Logged in using ChatGPT' }) })

it('uses subscription auth and feeds only allowlisted tools back to the CLI', async () => {
  const r = run(); r.key = 'must-not-reach-cli'
  const deps = dependencies()
  deps.run.mockResolvedValueOnce({ ok: true, stderr: '', stdout: reply({ reply: '', tool_calls: [
    { name: 'add_task', arguments: '{"title":"Ship release"}' }, { name: 'shell', arguments: '{"command":"evil"}' }
  ] }) }).mockResolvedValueOnce({ ok: true, stderr: '', stdout: reply({ reply: 'Start with the release.', tool_calls: [] }) })
  expect(await runPersonalSubscription(r, deps)).toBe('Start with the release.')
  expect(r.execute).toHaveBeenCalledExactlyOnceWith('add_task', { title: 'Ship release' })
  const second = JSON.parse(deps.run.mock.calls[2][0].input!)
  expect(second.messages.at(-1).output).toContain('Unknown agent tool')
  expect(JSON.stringify(deps.run.mock.calls)).not.toContain(r.key)
  const request = deps.run.mock.calls[1][0]
  expect(request.cwd).toContain('hd-personal-subscription-')
  expect(existsSync(request.cwd!)).toBe(false)
})

it('auto detect prefers a signed-in WSL subscription over a native API login', async () => {
  const deps = dependencies()
  deps.resolve.mockImplementation(async (_provider, environment) => ({ ...cli, environment: environment as 'native' | 'wsl' }))
  deps.run.mockReset().mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Logged in using an API key: SECRET' })
    .mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Logged in using ChatGPT' })
  const status = await personalSubscriptionStatus('chatgpt', 'auto', deps)
  expect(status).toMatchObject({ signedIn: true, environment: 'wsl' })
  expect(JSON.stringify(status)).not.toContain('SECRET')
})

it('refuses API authentication and never falls back to a paid provider', async () => {
  const deps = dependencies()
  deps.run.mockReset().mockResolvedValue({ ok: true, stdout: '', stderr: 'Logged in using an API key: SECRET' })
  await expect(runPersonalSubscription(run(), deps)).rejects.toThrow('codex login')
  expect(deps.run.mock.calls.every(([request]) => request.args.includes('status'))).toBe(true)
  expect(JSON.stringify(await personalSubscriptionStatus('chatgpt', 'native', deps))).not.toContain('SECRET')
})

it('checks Claude subscription auth and reads its structured output', async () => {
  const deps = dependencies()
  deps.resolve.mockResolvedValue({ ...cli, provider: 'claude' })
  deps.run.mockReset().mockResolvedValueOnce({ ok: true, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) })
    .mockResolvedValueOnce({ ok: true, stderr: '', stdout: JSON.stringify({ is_error: false, structured_output: { reply: 'One thing at a time.', tool_calls: [] } }) })
  expect(await runPersonalSubscription({ ...run(), provider: 'claude' }, deps)).toBe('One thing at a time.')
  expect(deps.run.mock.calls[1][0].args).toContain('--no-session-persistence')
})

it('rejects Claude API credentials even when the CLI is logged in', async () => {
  const deps = dependencies()
  deps.run.mockReset().mockResolvedValue({ ok: true, stderr: '', stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }) })
  expect(await personalSubscriptionStatus('claude', 'native', deps)).toMatchObject({ available: true, signedIn: false, message: expect.stringContaining('claude auth login') })
})

it('reports missing CLIs and validates requests before discovery', async () => {
  const deps = dependencies(); deps.resolve.mockResolvedValue(null)
  expect(await personalSubscriptionStatus('claude', 'wsl', deps)).toMatchObject({ available: false, signedIn: false, message: expect.stringContaining('in WSL') })
  await expect(personalSubscriptionStatus('shell', 'native', deps)).rejects.toThrow('Choose a subscription')
  expect(deps.run).not.toHaveBeenCalled()
})

it('does not expose raw CLI errors and cleans up temporary schema files', async () => {
  const deps = dependencies(); deps.run.mockResolvedValueOnce({ ok: false, stdout: 'private prompt', stderr: 'SECRET credentials' })
  await expect(runPersonalSubscription(run(), deps)).rejects.toThrow('has not switched to API billing')
  expect(existsSync(deps.run.mock.calls[1][0].cwd!)).toBe(false)
})

it('rejects failed, oversized and malformed structured replies', () => {
  expect(() => parseSubscriptionReply('chatgpt', reply({ reply: 'Premature', tool_calls: [] }) + '\n{"type":"turn.failed"}')).toThrow('complete structured reply')
  expect(() => parseSubscriptionReply('claude', JSON.stringify({ is_error: true, result: 'secret failure' }))).toThrow('complete structured reply')
  expect(() => parseSubscriptionReply('chatgpt', reply({ reply: 'x'.repeat(24001), tool_calls: [] }))).toThrow('invalid reply')
  expect(() => parseSubscriptionReply('chatgpt', reply({ reply: '', tool_calls: Array(9).fill({ name: 'add_task', arguments: '{}' }) }))).toThrow('invalid reply')
})

it('cancels before tool effects and keeps the request bound', async () => {
  const deps = dependencies(); const controller = new AbortController(); const r = { ...run(), signal: controller.signal }
  deps.run.mockImplementationOnce(async () => ({ ok: true, stdout: '', stderr: 'Logged in using ChatGPT' }))
    .mockImplementationOnce(async () => { controller.abort(); return { ok: true, stderr: '', stdout: reply({ reply: '', tool_calls: [{ name: 'add_task', arguments: '{}' }] }) } })
  await expect(runPersonalSubscription(r, deps)).rejects.toThrow()
  expect(r.execute).not.toHaveBeenCalled()
})

it('limits repeated tools to five batches and makes the sixth request reply-only', async () => {
  const deps = dependencies(); const r = run()
  deps.run.mockResolvedValue({ ok: true, stderr: '', stdout: reply({ reply: '', tool_calls: [{ name: 'add_task', arguments: '{}' }] }) })
  await expect(runPersonalSubscription(r, deps)).rejects.toThrow('tool limit')
  expect(deps.run).toHaveBeenCalledTimes(7)
  expect(r.execute).toHaveBeenCalledTimes(5)
  expect(JSON.parse(deps.run.mock.calls[6][0].input!).tools).toEqual([])
})

it('isolates coding tools, configuration and native provider selection', () => {
  const codex = subscriptionArgs('chatgpt', '', 'reply.json')
  expect(codex).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--ephemeral', 'read-only', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.plugins=false', 'features.hooks=false']))
  expect(codex).not.toContain('--model')
  const claude = subscriptionArgs('claude', 'sonnet', 'reply.json')
  expect(claude).toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--strict-mcp-config', '--model', 'sonnet']))
  expect(claude[claude.indexOf('--tools') + 1]).toBe('')
})

it('tolerates login-shell banners around structured CLI output', () => {
  const banner = 'Welcome to Ubuntu\nnvm: using node v24 {not json}\n'
  expect(parseSubscriptionReply('chatgpt', banner + reply({ reply: 'Done.', tool_calls: [] }) + '\n[] trailing noise\n')).toEqual({ reply: 'Done.', tool_calls: [] })
  const claude = { type: 'result', is_error: false, structured_output: { reply: 'Hi.', tool_calls: [] } }
  expect(parseSubscriptionReply('claude', banner + JSON.stringify(claude) + '\nbye\n')).toEqual({ reply: 'Hi.', tool_calls: [] })
  expect(parseSubscriptionReply('claude', banner + JSON.stringify(claude, null, 2) + '\n')).toEqual({ reply: 'Hi.', tool_calls: [] })
  expect(() => parseSubscriptionReply('claude', banner + '{"other":1}\n')).toThrow('complete structured reply')
  expect(() => parseSubscriptionReply('chatgpt', banner + reply({ reply: 'x', tool_calls: [] }) + '\n{"type":"error"}\nnoise')).toThrow('complete structured reply')
  expect(() => parseSubscriptionReply('claude', banner + JSON.stringify({ ...claude, structured_output: { reply: 1 } }))).toThrow('invalid reply')
})

it('reads Claude auth status through shell noise', async () => {
  const deps = dependencies()
  deps.run.mockReset().mockResolvedValue({ ok: true, stderr: '', stdout: 'motd banner\n' + JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, null, 2) + '\n' })
  expect(await personalSubscriptionStatus('claude', 'native', deps)).toMatchObject({ signedIn: true })
  deps.run.mockResolvedValue({ ok: true, stderr: '', stdout: '{"banner":true}\n' + JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }) + '\nbye' })
  expect(await personalSubscriptionStatus('claude', 'native', deps)).toMatchObject({ signedIn: false })
})

const done = { ok: true, stderr: '', stdout: reply({ reply: 'Done.', tool_calls: [] }) }
const cached = () => { let time = 1000; const deps = { ...dependencies(), cache: new Map() as SubscriptionConnectionCache, now: () => time }; return { deps, tick: (ms: number) => { time += ms } } }

it('reuses a signed-in connection for five minutes', async () => {
  const { deps, tick } = cached()
  deps.run.mockResolvedValue(done)
  expect(await runPersonalSubscription(run(), deps)).toBe('Done.')
  expect(await runPersonalSubscription(run(), deps)).toBe('Done.')
  expect(deps.resolve).toHaveBeenCalledTimes(1)
  expect(deps.run.mock.calls.filter(([r]) => r.args.includes('status'))).toHaveLength(1)
  tick(SUBSCRIPTION_CACHE_MS)
  deps.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Logged in using ChatGPT' })
  await runPersonalSubscription(run(), deps)
  expect(deps.resolve).toHaveBeenCalledTimes(2)
})

it('forgets the cached connection after a failed or unparseable run', async () => {
  for (const failure of [{ ok: false, stdout: '', stderr: 'logged out' }, { ok: true, stdout: 'banner only', stderr: '' }]) {
    const { deps } = cached()
    deps.run.mockResolvedValueOnce(done).mockResolvedValueOnce(failure)
    await runPersonalSubscription(run(), deps)
    await expect(runPersonalSubscription(run(), deps)).rejects.toThrow()
    expect(deps.cache.size).toBe(0)
    deps.run.mockResolvedValue({ ok: true, stdout: '', stderr: 'Not logged in' })
    await expect(runPersonalSubscription(run(), deps)).rejects.toThrow('codex login')
    expect(deps.resolve).toHaveBeenCalledTimes(3) // auto re-probes native and WSL
  }
})

it('explicit status checks bypass and refresh the cache', async () => {
  const { deps } = cached()
  deps.run.mockResolvedValue(done)
  await runPersonalSubscription(run(), deps)
  deps.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Not logged in' }).mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Not logged in' })
  expect(await personalSubscriptionStatus('chatgpt', 'auto', deps)).toMatchObject({ signedIn: false })
  expect(deps.resolve).toHaveBeenCalledTimes(3)
  expect(deps.cache.size).toBe(0)
  deps.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: 'Logged in using ChatGPT' })
  expect(await personalSubscriptionStatus('chatgpt', 'auto', deps)).toMatchObject({ signedIn: true })
  expect(await runPersonalSubscription(run(), deps)).toBe('Done.')
  expect(deps.resolve).toHaveBeenCalledTimes(4)
})
