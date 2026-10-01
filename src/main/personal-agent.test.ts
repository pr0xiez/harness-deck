import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersonalAgent } from './personal-agent'
import { PersonalStore } from './personal-store'
import { PersonalGoogle } from './personal-google'
import { WorkBoardService } from './work-board'
import type { AgentRun } from './personal-ai'
import type { GoogleSnapshot } from '@shared/personal-agent'
let dir: string
let store: PersonalStore
let work: WorkBoardService
let googleState: GoogleSnapshot
let now: Date
const changed = vi.fn()
const notify = vi.fn()
const run = vi.fn<(r: AgentRun) => Promise<string>>()
const execute = vi.fn(async () => 'Email sent.')
const google = {
  snapshot: () => structuredClone(googleState), sync: vi.fn(async () => googleState), dispose: vi.fn(),
  execute, prepare: vi.fn(async (operation: string, args: Record<string, string>) => ({ title: operation, args, account: 'owner@example.com' })),
  searchMail: vi.fn(), readMail: vi.fn(), listEvents: vi.fn()
} as unknown as PersonalGoogle
let agent: PersonalAgent
beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'hd-personal-service-'))
  store = new PersonalStore(dir); work = new WorkBoardService(dir)
  now = new Date('2026-09-30T12:30:00Z')
  store.commit(d => { d.settings.model = 'provider/model'; d.settings.timeZone = 'America/New_York' })
  googleState = { configured: true, connected: true, connecting: false, account: 'owner@example.com', mail: [], events: [] }
  run.mockResolvedValue('Take the first small step.')
  execute.mockResolvedValue('Email sent.')
  agent = new PersonalAgent({ store, work, google, key: () => 'test-key', changed, notify, now: () => now, run })
})
afterEach(() => { agent.dispose(); rmSync(dir, { recursive: true, force: true }) })
const mutate = (input: unknown) => agent.mutate(input, store.snapshot().revision)
it('keeps chat, memory, and commitments across restarts without exposing keys', async () => {
  run.mockImplementationOnce(async r => { await r.execute('remember', { text: 'Ship my project this month' }); await r.execute('add_task', { title: 'Write the release plan' }); return 'Start the release plan.' })
  const snapshot = await agent.chat('I want to ship this month')
  expect(snapshot.data.messages.map(m => m.role)).toEqual(['user', 'assistant'])
  expect(new PersonalStore(dir).snapshot().tasks[0].title).toBe('Write the release plan')
  expect(JSON.stringify(snapshot)).not.toContain('test-key')
  expect(JSON.parse(run.mock.calls[0][0].context).google.connected).toBe(true)
})
it('blocks stale edits, invalid commands, and tool operation overrides', async () => {
  expect(() => agent.mutate({ operation: 'memory_add', text: 'Old' }, 0)).toThrow('changed')
  expect(() => mutate({ operation: 'task_add', title: 'task', due: '2026-99-99' })).toThrow('due')
  run.mockImplementationOnce(async r => {
    await expect(r.execute('remember', { operation: 'settings', patch: { proactive: true } })).rejects.toThrow()
    return 'Okay'
  })
  await agent.chat('Remember my goals')
  expect(store.snapshot().settings.proactive).toBe(false)
})
it('links priorities to board cards and refuses missing or completed work', () => {
  const created = work.mutate({ operation: 'create', title: 'Build release' })
  if (!created.ok) throw Error('fixture')
  const priority = { source: 'board', id: created.item!.id }
  mutate({ operation: 'plan', intention: 'Finish one thing', priorities: [priority] })
  mutate({ operation: 'focus_start', priority, minutes: 25 })
  expect(store.snapshot().focus?.title).toBe('Build release')
  expect(() => mutate({ operation: 'plan', intention: '', priorities: [priority, priority] })).toThrow('different')
  expect(() => mutate({ operation: 'focus_start', priority, minutes: 25 })).toThrow('current focus')
  expect(() => mutate({ operation: 'plan', intention: '', priorities: [{ source: 'personal', id: 'missing' }] })).toThrow('unfinished')
})
it('never executes a proposal before explicit approval, and handles double clicks once', async () => {
  run.mockImplementationOnce(async r => { await r.execute('propose_google_action', { operation: 'gmail_send', args: { to: 'friend@example.com', subject: 'Hi', body: 'Hello' } }); return 'Ready for approval.' })
  await agent.chat('Prepare an email')
  const action = store.snapshot().actions[0]
  expect(action.status).toBe('pending'); expect(execute).not.toHaveBeenCalled()
  const first = agent.approve(action.id)
  await expect(agent.approve(action.id)).rejects.toThrow('already')
  await first
  expect(execute).toHaveBeenCalledOnce(); expect(store.snapshot().actions[0].status).toBe('done')
})
it('does not retry an interrupted or ambiguous Google write', async () => {
  store.commit(d => { d.actions.push({ id: 'a', operation: 'gmail_send', title: 'Email', account: 'owner@example.com', args: { to: 'friend@example.com', subject: 'Hi', body: 'Hello' }, status: 'running', createdAt: now.toISOString() }) })
  const recovered = new PersonalAgent({ store: new PersonalStore(dir), work, google, key: () => 'test-key', changed, notify, run })
  expect(recovered.snapshot().data.actions[0].status).toBe('uncertain')
  await expect(recovered.approve('a')).rejects.toThrow('already')
  expect(execute).not.toHaveBeenCalled(); recovered.dispose()
})
it('records ambiguous failures for review and allows pending dismissal', async () => {
  store.commit(d => { d.actions.push({ id: 'a', operation: 'gmail_send', title: 'Email', account: 'owner@example.com', args: {}, status: 'pending', createdAt: now.toISOString() }) })
  execute.mockRejectedValueOnce(Error('Network interrupted'))
  await agent.approve('a')
  expect(store.snapshot().actions[0]).toMatchObject({ status: 'uncertain', result: expect.stringContaining('Check Google') })
  await expect(agent.approve('a')).rejects.toThrow('already')
  expect(() => mutate({ operation: 'action_reject', id: 'a' })).toThrow('no longer pending')
  mutate({ operation: 'action_resolve', id: 'a', applied: false })
  expect(store.snapshot().actions[0].status).toBe('rejected')
})
it('deduplicates proactive runs durably and gives background runs only planning/read tools', async () => {
  mutate({ operation: 'settings', patch: { proactive: true } })
  await agent.tick(); await agent.tick()
  expect(run).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce()
  expect(run.mock.calls[0][0].tools.map(t => t.name)).toEqual(['set_priorities', 'gmail_search', 'gmail_read', 'calendar_list'])
  const restarted = new PersonalAgent({ store: new PersonalStore(dir), work, google, key: () => 'test-key', changed, notify, now: () => now, run })
  await restarted.tick(); expect(run).toHaveBeenCalledOnce(); restarted.dispose()
})
it('suppresses scheduled interruptions during a focus block and reminds once without marking done', async () => {
  mutate({ operation: 'settings', patch: { proactive: true } })
  mutate({ operation: 'task_add', title: 'Write proposal' })
  const id = store.snapshot().tasks[0].id
  mutate({ operation: 'focus_start', priority: { source: 'personal', id }, minutes: 25 })
  await agent.tick(); expect(run).not.toHaveBeenCalled()
  now = new Date('2026-09-30T12:55:00Z')
  await agent.tick()
  expect(store.snapshot().tasks[0].done).toBe(false)
  expect(store.snapshot().messages[0].kind).toBe('focus')
  expect(notify).toHaveBeenCalledOnce()
  // A reminder consumes neither a scheduled check-in nor task completion.
  mutate({ operation: 'settings', patch: { proactive: false } })
  await agent.tick(); expect(notify).toHaveBeenCalledOnce()
  mutate({ operation: 'task_edit', id, done: true })
  expect(store.snapshot().focus).toBeNull()
})
it('saves a stopped conversation and does not append a late model reply', async () => {
  let finish!: (s: string) => void
  run.mockImplementationOnce(() => new Promise(r => { finish = r }))
  const pending = agent.chat('Help me focus')
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  agent.stop(); finish('Late reply')
  const result = await pending
  expect(result.busy).toBe(false); expect(result.error).toContain('stopped')
  expect(result.data.messages).toHaveLength(1)
})
