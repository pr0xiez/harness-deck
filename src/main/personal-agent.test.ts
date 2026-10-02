import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersonalAgent, type PersonalNotifyAction } from './personal-agent'
import { PersonalStore } from './personal-store'
import { PersonalGoogle } from './personal-google'
import { WorkBoardService } from './work-board'
import type { AgentRun } from './personal-ai'
import type { DeckSignals, GoogleSnapshot, PersonalSuggestion, PersonalSuggestionBody } from '@shared/personal-agent'
let dir: string
let store: PersonalStore
let work: WorkBoardService
let googleState: GoogleSnapshot
let now: Date
const changed = vi.fn()
const notify = vi.fn<(title: string, text: string, actions?: PersonalNotifyAction[]) => void>()
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
  store = new PersonalStore(dir, () => {}, () => now.getTime()); work = new WorkBoardService(dir)
  now = new Date('2026-09-30T12:30:00Z')
  store.commit(d => { d.settings.provider = 'openrouter'; d.settings.model = 'provider/model'; d.settings.timeZone = 'America/New_York' })
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
  expect(run.mock.calls[0][0].tools.map(t => t.name)).toEqual(['set_priorities', 'suggest_actions', 'gmail_search', 'gmail_read', 'calendar_list'])
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
it('uses either subscription for chat and scheduled check-ins without reading an API key', async () => {
  const key = vi.fn(() => null)
  agent.dispose()
  agent = new PersonalAgent({ store, work, google, key, changed, notify, now: () => now, run })
  mutate({ operation: 'settings', patch: { provider: 'chatgpt', model: '', proactive: true } })
  await agent.chat('Help me focus')
  expect(run.mock.calls[0][0]).toMatchObject({ provider: 'chatgpt', model: '', key: '', cliEnvironment: 'auto' })
  mutate({ operation: 'settings', patch: { provider: 'claude', subscriptionModel: 'sonnet', cliEnvironment: 'wsl' } })
  await agent.tick()
  expect(run.mock.calls[1][0]).toMatchObject({ provider: 'claude', model: 'sonnet', key: '', cliEnvironment: 'wsl' })
  expect(key).not.toHaveBeenCalled()
  expect(store.snapshot().messages).toHaveLength(3)
})
it('enforces background read/planning tools inside the executor for all providers', async () => {
  mutate({ operation: 'settings', patch: { provider: 'chatgpt', proactive: true } })
  run.mockImplementationOnce(async r => {
    await expect(r.execute('add_task', { title: 'Unrequested task' })).rejects.toThrow('Unknown agent tool')
    await expect(r.execute('propose_google_action', { operation: 'gmail_send', args: {} })).rejects.toThrow('Unknown agent tool')
    return 'Choose a focus.'
  })
  await agent.tick()
  expect(store.snapshot().tasks).toEqual([])
  expect(store.snapshot().actions).toEqual([])
})
it('records completion time and deletes tasks from focus and plans, without a model delete tool', async () => {
  mutate({ operation: 'task_add', title: 'Draft outline' })
  const id = store.snapshot().tasks[0].id
  mutate({ operation: 'task_edit', id, done: true })
  expect(store.snapshot().tasks[0].completedAt).toBe(now.toISOString())
  mutate({ operation: 'task_edit', id, done: false })
  expect(store.snapshot().tasks[0].completedAt).toBeUndefined()
  mutate({ operation: 'plan', intention: '', priorities: [{ source: 'personal', id }] })
  mutate({ operation: 'focus_start', priority: { source: 'personal', id }, minutes: 25 })
  run.mockImplementationOnce(async r => {
    expect(r.tools.map(t => t.name)).not.toContain('task_delete')
    await expect(r.execute('task_delete', { id })).rejects.toThrow('Unknown agent tool')
    await expect(r.execute('delete_task', { id })).rejects.toThrow('Unknown agent tool')
    return 'Kept.'
  })
  await agent.chat('Delete my task')
  expect(store.snapshot().tasks).toHaveLength(1)
  mutate({ operation: 'task_delete', id })
  expect(store.snapshot()).toMatchObject({ tasks: [], focus: null, plans: [{ priorities: [] }] })
  expect(() => mutate({ operation: 'task_delete', id })).toThrow('no longer exists')
})
it('refuses new Google proposals once 20 await review but still returns duplicates', async () => {
  store.commit(d => { for (let i = 0; i < 20; i++) d.actions.push({ id: `p${i}`, operation: 'gmail_archive', title: 'Archive', account: 'owner@example.com', args: { messageId: `m${i}` }, status: i < 18 ? 'pending' : 'uncertain', createdAt: now.toISOString() }) })
  run.mockImplementationOnce(async r => {
    await expect(r.execute('propose_google_action', { operation: 'gmail_archive', args: { messageId: 'new' } })).rejects.toThrow('awaiting review')
    await expect(r.execute('propose_google_action', { operation: 'gmail_archive', args: { messageId: 'm0' } })).resolves.toMatchObject({ proposal: { id: 'p0' } })
    return 'Review your proposals first.'
  })
  await agent.chat('Archive more mail')
  expect(store.snapshot().actions).toHaveLength(20)
  expect(store.snapshot().messages.at(-1)?.text).toBe('Review your proposals first.')
  mutate({ operation: 'action_reject', id: 'p0' })
  run.mockImplementationOnce(async r => { await r.execute('propose_google_action', { operation: 'gmail_archive', args: { messageId: 'new' } }); return 'Ready.' })
  await agent.chat('Archive it now')
  expect(store.snapshot().actions).toHaveLength(21)
})
it('lets scheduled check-ins save a plan only when the user has none for today', async () => {
  mutate({ operation: 'task_add', title: 'User pick' }); mutate({ operation: 'task_add', title: 'Agent pick' })
  const [user, other] = store.snapshot().tasks.map(t => ({ source: 'personal', id: t.id }))
  mutate({ operation: 'settings', patch: { proactive: true } })
  run.mockImplementationOnce(async r => { await r.execute('set_priorities', { intention: 'Agent plan', priorities: [other] }); return 'Saved a plan.' })
  await agent.tick()
  expect(store.snapshot().plans).toMatchObject([{ intention: 'Agent plan', priorities: [other] }])
  mutate({ operation: 'plan', intention: 'Mine', priorities: [user] })
  now = new Date('2026-09-30T17:00:00Z')
  run.mockImplementationOnce(async r => {
    await expect(r.execute('set_priorities', { intention: 'Overwrite', priorities: [other] })).rejects.toThrow('already set today')
    return 'Consider swapping priorities.'
  })
  await agent.tick()
  expect(store.snapshot().plans).toMatchObject([{ intention: 'Mine', priorities: [user] }])
  run.mockImplementationOnce(async r => { await r.execute('set_priorities', { intention: 'Changed in chat', priorities: [other] }); return 'Updated.' })
  await agent.chat('Swap my priority')
  expect(store.snapshot().plans).toMatchObject([{ intention: 'Changed in chat', priorities: [other] }])
})
it('tells the user once when a scheduled check-in fails, without retrying the slot', async () => {
  mutate({ operation: 'settings', patch: { proactive: true } })
  run.mockRejectedValueOnce(Error('Subscription sign-in expired.'))
  await agent.tick(); await agent.tick()
  expect(run).toHaveBeenCalledOnce()
  const messages = store.snapshot().messages
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ role: 'assistant', kind: 'morning', text: expect.stringContaining('Subscription sign-in expired.') })
  expect(messages[0].text).toContain('try again')
  expect(notify).toHaveBeenCalledOnce()
  expect(agent.snapshot().error).toBe('Subscription sign-in expired.')
})
it('reports failed check-ins silently when notifications are off and not at all after a user stop', async () => {
  mutate({ operation: 'settings', patch: { proactive: true, notifications: false } })
  run.mockRejectedValueOnce(Error('Offline'))
  await agent.tick()
  expect(store.snapshot().messages).toHaveLength(1); expect(notify).not.toHaveBeenCalled()
  now = new Date('2026-09-30T17:00:00Z')
  run.mockImplementationOnce(async r => new Promise((_, reject) => r.signal.addEventListener('abort', () => reject(Error('aborted')))))
  const pending = agent.tick()
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
  agent.stop(); await pending
  expect(store.snapshot().messages).toHaveLength(1)
})

const lastMessage = () => store.snapshot().messages.at(-1)!
const taskId = (title: string): string => { mutate({ operation: 'task_add', title }); return store.snapshot().tasks.at(-1)!.id }
/** Seeds an assistant message with open suggestions, as a model run would. */
const seedSuggestions = (suggestions: (PersonalSuggestionBody & { id: string; label: string })[]): string => {
  const id = 'm-suggest'
  store.commit(d => { d.messages.push({ id, role: 'assistant', text: 'Options.', at: now.toISOString(), suggestions: suggestions.map((s): PersonalSuggestion => ({ ...s, state: 'open' })) }) })
  return id
}
const suggestionState = (messageId: string, id: string) => store.snapshot().messages.find(m => m.id === messageId)!.suggestions!.find(s => s.id === id)!.state
it('validates model suggestions and attaches them, deduplicated and capped, to the final reply without executing them', async () => {
  const id = taskId('Write proposal')
  const focus = { type: 'start_focus', label: 'Start 25-min focus', priority: { source: 'personal', id }, minutes: 25 }
  run.mockImplementationOnce(async r => {
    await expect(r.execute('suggest_actions', { suggestions: [{ ...focus, priority: { source: 'personal', id: 'missing' } }] })).rejects.toThrow('unfinished')
    await expect(r.execute('suggest_actions', { suggestions: [{ ...focus, minutes: 4 }] })).rejects.toThrow('5 to 180')
    await expect(r.execute('suggest_actions', { suggestions: [{ ...focus, label: 'x'.repeat(81) }] })).rejects.toThrow('label')
    await expect(r.execute('suggest_actions', { suggestions: [{ type: 'add_task', label: 'Add', title: ' ' }] })).rejects.toThrow('task title')
    await expect(r.execute('suggest_actions', { suggestions: [{ type: 'add_task', label: 'Add', title: 'Ok', due: '2026-02-30' }] })).rejects.toThrow('due date')
    await expect(r.execute('suggest_actions', { suggestions: [{ type: 'set_plan', label: 'Plan', intention: '', priorities: [{ source: 'personal', id }, { source: 'personal', id }] }] })).rejects.toThrow('different priorities')
    await expect(r.execute('suggest_actions', { suggestions: [{ type: 'delete_task', label: 'Delete', id }] })).rejects.toThrow('type')
    await expect(r.execute('suggest_actions', { suggestions: [focus, focus, focus, focus] })).rejects.toThrow('between 1 and 3')
    await expect(r.execute('suggest_actions', { suggestions: [{ type: 'add_task', label: 'Add task: Call dentist', title: 'Call dentist', notes: null, due: '' }, focus] }))
      .resolves.toMatchObject({ offered: ['Add task: Call dentist', 'Start 25-min focus'] })
    const capped = await r.execute('suggest_actions', { suggestions: [focus, { type: 'set_plan', label: 'Use this plan', intention: 'Ship it', priorities: [{ source: 'personal', id }] }, { type: 'add_task', label: 'Add task: Extra', title: 'Extra' }] })
    expect(capped).toMatchObject({ offered: ['Add task: Call dentist', 'Start 25-min focus', 'Use this plan'], note: expect.stringContaining('Only 3') })
    return 'Here are a few options.'
  })
  await agent.chat('What next?')
  const reply = lastMessage()
  expect(reply).toMatchObject({ role: 'assistant', text: 'Here are a few options.' })
  expect(reply.suggestions).toMatchObject([
    { type: 'add_task', title: 'Call dentist', state: 'open', label: 'Add task: Call dentist' },
    { type: 'start_focus', priority: { source: 'personal', id }, minutes: 25, state: 'open' },
    { type: 'set_plan', intention: 'Ship it', priorities: [{ source: 'personal', id }], state: 'open' }])
  expect(reply.suggestions![0]).not.toHaveProperty('notes')
  expect(new Set(reply.suggestions!.map(s => s.id)).size).toBe(3)
  expect(store.snapshot()).toMatchObject({ tasks: [{ title: 'Write proposal' }], plans: [], focus: null })
  expect(new PersonalStore(dir).snapshot().messages.at(-1)!.suggestions).toHaveLength(3)
  // A run without suggestions attaches none.
  await agent.chat('Thanks')
  expect(lastMessage()).not.toHaveProperty('suggestions')
})
it('lets scheduled check-ins offer a plan instead of overwriting one, and accepts it from the notification', async () => {
  const mine = taskId('Mine'); const other = taskId('Other')
  mutate({ operation: 'plan', intention: 'My plan', priorities: [{ source: 'personal', id: mine }] })
  mutate({ operation: 'settings', patch: { proactive: true } })
  run.mockImplementationOnce(async r => {
    expect(JSON.parse(r.context).deck).toEqual({ waitingAgents: [], githubAttention: [], staleBoardCards: [] })
    await expect(r.execute('set_priorities', { intention: 'Agent plan', priorities: [{ source: 'personal', id: other }] })).rejects.toThrow('suggest_actions')
    await r.execute('suggest_actions', { suggestions: [{ type: 'set_plan', label: 'Use this plan', intention: 'Agent plan', priorities: [{ source: 'personal', id: other }] }] })
    return 'Consider switching to Other.'
  })
  await agent.tick()
  expect(run.mock.calls[0][0].prompt).toMatch(/blocked on me/)
  const message = lastMessage()
  expect(message).toMatchObject({ kind: 'morning', suggestions: [{ type: 'set_plan', state: 'open' }] })
  expect(store.snapshot().plans).toMatchObject([{ intention: 'My plan' }])
  const [, , actions] = notify.mock.calls[0]
  expect(actions!.map(a => a.label)).toEqual(['Use this plan', 'Snooze 1h'])
  actions![0].run()
  expect(store.snapshot().plans).toMatchObject([{ intention: 'Agent plan', priorities: [{ source: 'personal', id: other }] }])
  expect(lastMessage().suggestions![0].state).toBe('accepted')
  // A second click is reported, not applied twice.
  actions![0].run()
  expect(agent.snapshot().error).toContain('already handled')
})
it('accepts each suggestion type in the same commit and leaves failed ones open', () => {
  const a = taskId('Task A'); const b = taskId('Task B')
  const messageId = seedSuggestions([
    { id: 's-task', label: 'Add task: Call dentist', type: 'add_task', title: 'Call dentist', due: '2026-10-01' },
    { id: 's-focus', label: 'Start 25-min focus', type: 'start_focus', priority: { source: 'personal', id: a }, minutes: 25 },
    { id: 's-plan', label: 'Use this plan', type: 'set_plan', intention: 'Do A', priorities: [{ source: 'personal', id: a }] }])
  const accept = (suggestionId: string) => mutate({ operation: 'suggestion_accept', messageId, suggestionId })
  expect(() => mutate({ operation: 'suggestion_accept', messageId, suggestionId: 's-task', extra: true })).toThrow('fields')
  const before = store.snapshot().revision
  accept('s-task')
  expect(store.snapshot().revision).toBe(before + 1)
  expect(store.snapshot().tasks.at(-1)).toMatchObject({ title: 'Call dentist', due: '2026-10-01', done: false })
  expect(suggestionState(messageId, 's-task')).toBe('accepted')
  expect(() => accept('s-task')).toThrow('already handled')
  expect(store.snapshot().tasks).toHaveLength(3)
  // Focus already running: the error is clear and the suggestion stays open.
  mutate({ operation: 'focus_start', priority: { source: 'personal', id: b }, minutes: 10 })
  const revision = store.snapshot().revision
  expect(() => accept('s-focus')).toThrow(/Couldn’t apply “Start 25-min focus”: Finish or end the current focus/)
  expect(store.snapshot().revision).toBe(revision)
  expect(suggestionState(messageId, 's-focus')).toBe('open')
  mutate({ operation: 'focus_stop' })
  // Finished task: refused, still open.
  mutate({ operation: 'task_edit', id: a, done: true })
  expect(() => accept('s-focus')).toThrow('unfinished')
  expect(() => accept('s-plan')).toThrow('unfinished')
  expect(suggestionState(messageId, 's-focus')).toBe('open'); expect(store.snapshot().focus).toBeNull()
  mutate({ operation: 'task_edit', id: a, done: false })
  accept('s-focus')
  expect(store.snapshot().focus).toMatchObject({ source: 'personal', id: a, title: 'Task A', endsAt: now.getTime() + 25 * 60000 })
  expect(suggestionState(messageId, 's-focus')).toBe('accepted')
  // The user's accepted plan may replace today's plan.
  mutate({ operation: 'plan', intention: 'Do B', priorities: [{ source: 'personal', id: b }] })
  accept('s-plan')
  expect(store.snapshot().plans).toMatchObject([{ day: '2026-09-30', intention: 'Do A', priorities: [{ source: 'personal', id: a }] }])
  expect(() => accept('missing')).toThrow('no longer exists')
  expect(() => mutate({ operation: 'suggestion_accept', messageId: 'nope', suggestionId: 's-plan' })).toThrow('no longer exists')
})
it('dismisses an open suggestion once', () => {
  const messageId = seedSuggestions([{ id: 's', label: 'Add task: Call dentist', type: 'add_task', title: 'Call dentist' }])
  mutate({ operation: 'suggestion_dismiss', messageId, suggestionId: 's' })
  expect(suggestionState(messageId, 's')).toBe('dismissed')
  expect(() => mutate({ operation: 'suggestion_dismiss', messageId, suggestionId: 's' })).toThrow('already handled')
  expect(() => mutate({ operation: 'suggestion_accept', messageId, suggestionId: 's' })).toThrow('already handled')
  expect(store.snapshot().tasks).toEqual([])
})
const signals = (overrides: Partial<DeckSignals> = {}): DeckSignals => ({ reportedAt: now.getTime(), github: [],
  waitingAgents: [{ paneId: 'p1', label: 'Claude · api', workspace: 'SqFt', waitingSince: now.getTime() - 20 * 60000 }], ...overrides })
it('keeps only the latest valid Deck signals in memory and adds fresh ones, with stale cards, to chat context', async () => {
  expect(() => agent.reportSignals({ waitingAgents: [], github: [] })).toThrow('Invalid')
  expect(() => agent.reportSignals({ ...signals(), waitingAgents: Array(21).fill(signals().waitingAgents[0]) })).toThrow('Invalid')
  expect(() => agent.reportSignals({ ...signals(), github: [{ id: 'g', repository: 'o/r', number: 0, title: 'x', signals: [] }] })).toThrow('Invalid')
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'))
    work.mutate({ operation: 'create', title: 'Stalled card', status: 'in_progress' })
    work.mutate({ operation: 'create', title: 'Old idea', status: 'ideas' })
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
    work.mutate({ operation: 'create', title: 'Older stall', status: 'in_progress' })
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'))
    work.mutate({ operation: 'create', title: 'Active card', status: 'in_progress' })
  } finally { vi.useRealTimers() }
  agent.reportSignals({ ...signals(), github: [{ id: 'o/r#7', repository: 'o/r', number: 7, title: 'Fix login', signals: ['review requested'] }] })
  agent.reportSignals(signals({ github: [{ id: 'o/r#8', repository: 'o/r', number: 8, title: 'Add search', signals: ['review requested'] }], extra: 'ignored' } as Partial<DeckSignals>))
  await agent.chat('What is blocked?')
  const deck = JSON.parse(run.mock.calls[0][0].context).deck
  expect(deck).toEqual({
    waitingAgents: [{ label: 'Claude · api', workspace: 'SqFt', minutesWaiting: 20 }],
    githubAttention: [{ repository: 'o/r', number: 8, title: 'Add search', signals: ['review requested'] }],
    staleBoardCards: [{ id: expect.any(String), title: 'Stalled card', daysStale: 10 }, { id: expect.any(String), title: 'Older stall', daysStale: 4 }] })
  now = new Date(now.getTime() + 4 * 60000)
  await agent.chat('And now?')
  expect(JSON.parse(run.mock.calls[1][0].context).deck).toMatchObject({ waitingAgents: [], githubAttention: [{ number: 8 }] })
  expect(JSON.stringify(agent.snapshot())).not.toContain('Claude · api')
  expect(JSON.stringify(new PersonalStore(dir).snapshot())).not.toContain('Claude · api')
})
const today = ['2026-09-30:morning', '2026-09-30:checkIn', '2026-09-30:evening']
/** Proactive with today's scheduled check-ins already consumed, so ticks only nudge. */
const nudgeReady = (patch: Record<string, unknown> = {}): void => {
  mutate({ operation: 'settings', patch: { proactive: true, ...patch } })
  store.commit(d => { d.runs.push(...today) })
}
const nudges = () => store.snapshot().messages.filter(m => m.kind === 'nudge')
const event = (id: string, title: string, start: string) => ({ id, title, start, end: start })
it('nudges once before a timed meeting, even during focus, with the local start time', async () => {
  nudgeReady()
  const id = taskId('Deep work')
  mutate({ operation: 'focus_start', priority: { source: 'personal', id }, minutes: 60 })
  googleState.events = [event('all-day', 'Holiday', '2026-09-30'), event('later', 'Lunch', '2026-09-30T12:00:00-04:00'),
    event('e1', 'Design\nreview', '2026-09-30T08:38:00-04:00'), event('started', 'Standup', '2026-09-30T08:30:00-04:00')]
  await agent.tick()
  expect(nudges()).toMatchObject([{ role: 'assistant', kind: 'nudge', text: '“Design review” starts at 08:38. Anything to prep?' }])
  expect(notify).toHaveBeenCalledExactlyOnceWith('Meeting soon', '“Design review” starts at 08:38. Anything to prep?', [expect.objectContaining({ label: 'Snooze 1h' })])
  expect(store.snapshot().runs.filter(r => r.startsWith('n:'))).toEqual([expect.stringMatching(/^n:2026-09-30:meeting:[0-9a-f]{12}$/)])
  expect(run).not.toHaveBeenCalled()
  // Deduplicated per event even if the earlier nudge message is gone.
  store.commit(d => { d.messages = [] })
  await agent.tick()
  expect(nudges()).toHaveLength(0)
  // The time is formatted in the agent's time zone.
  mutate({ operation: 'settings', patch: { timeZone: 'Europe/London' } })
  googleState.events = [event('e2', 'Sync', '2026-09-30T12:39:00Z')]
  now = new Date('2026-09-30T12:31:00Z')
  await agent.tick()
  expect(nudges()).toMatchObject([{ text: '“Sync” starts at 13:39. Anything to prep?' }])
})
it('respects the nudge gates: nudges off, snooze, weekends, the active window, and a disconnected Google', async () => {
  googleState.events = [event('e1', 'Review', '2026-09-30T08:38:00-04:00')]
  nudgeReady({ nudges: false })
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'settings', patch: { nudges: true, snoozedUntil: now.getTime() + 60000 } })
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'settings', patch: { snoozedUntil: 0, proactive: false } })
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'settings', patch: { proactive: true, morning: '08:45', checkIn: '13:00' } })
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'settings', patch: { morning: '08:30' } })
  googleState.connected = false
  await agent.tick(); expect(nudges()).toHaveLength(0)
  // Saturday, weekdays only.
  googleState.connected = true
  now = new Date('2026-10-03T12:30:00Z'); googleState.events = [event('sat', 'Brunch', '2026-10-03T08:38:00-04:00')]
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'settings', patch: { weekdaysOnly: false } })
  store.commit(d => { d.runs.push('2026-10-03:morning') })
  await agent.tick(); expect(nudges()).toHaveLength(1)
  expect(notify).toHaveBeenCalledOnce()
})
it('rate-limits nudges to one per tick, ten minutes apart and eight per local day, and notifies only when enabled', async () => {
  nudgeReady({ notifications: false })
  googleState.events = [event('a', 'First', '2026-09-30T08:35:00-04:00'), event('b', 'Second', '2026-09-30T08:36:00-04:00')]
  await agent.tick()
  expect(nudges()).toMatchObject([{ text: expect.stringContaining('First') }])
  expect(notify).not.toHaveBeenCalled()
  now = new Date(now.getTime() + 60000)
  await agent.tick()
  expect(nudges()).toHaveLength(1)
  // Eight already today: nothing more, even ten minutes later.
  store.commit(d => { d.messages = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, role: 'assistant' as const, kind: 'nudge' as const, text: 'Earlier', at: new Date(Date.parse('2026-09-30T12:00:00Z') - i * 60000).toISOString() })) })
  now = new Date('2026-09-30T12:40:00Z'); googleState.events = [event('c', 'Third', '2026-09-30T08:45:00-04:00')]
  await agent.tick()
  expect(nudges()).toHaveLength(8)
  // Yesterday's nudges don't count toward today.
  store.commit(d => { for (const m of d.messages) m.at = new Date(Date.parse(m.at) - 13 * 3600000).toISOString() })
  await agent.tick()
  expect(nudges().at(-1)!.text).toContain('Third')
})
it('nudges about agents waiting 15+ minutes from fresh reports, grouped and deduplicated per wait', async () => {
  nudgeReady()
  const t = now.getTime()
  const wait = (paneId: string, minutes: number) => ({ paneId, label: `Agent ${paneId}`, workspace: paneId === 'p2' ? '' : 'Deck', waitingSince: t - minutes * 60000 })
  agent.reportSignals(signals({ waitingAgents: [wait('p1', 16), wait('p2', 30), wait('p3', 20), wait('p4', 25), wait('p5', 10)] }))
  await agent.tick()
  expect(nudges()).toMatchObject([{ text: '3 agents are waiting for your input: Agent p2, 30 min; Agent p4 (Deck), 25 min; Agent p3 (Deck), 20 min.' }])
  expect(notify).toHaveBeenCalledExactlyOnceWith('Agents waiting on you', expect.any(String), [expect.objectContaining({ label: 'Snooze 1h' })])
  expect(store.snapshot().runs.filter(r => r.startsWith('n:2026-09-30:agentWaiting:'))).toHaveLength(3)
  // Ten minutes later the report is stale: no nudge until Deck reports again.
  now = new Date(t + 10 * 60000)
  await agent.tick(); expect(nudges()).toHaveLength(1)
  agent.reportSignals(signals({ waitingAgents: [wait('p1', 16), wait('p2', 30), wait('p3', 20), wait('p4', 25), wait('p5', 10)] }))
  await agent.tick()
  expect(nudges().at(-1)!.text).toBe('2 agents are waiting for your input: Agent p1 (Deck), 26 min; Agent p5 (Deck), 20 min.')
  now = new Date(t + 20 * 60000)
  agent.reportSignals(signals({ waitingAgents: [wait('p1', 16), wait('p2', 30)] }))
  await agent.tick(); expect(nudges()).toHaveLength(2)
  // A new wait on the same pane is a new nudge.
  agent.reportSignals(signals({ waitingAgents: [{ ...wait('p1', 0), waitingSince: now.getTime() - 15 * 60000 }] }))
  await agent.tick(); expect(nudges().at(-1)!.text).toBe('An agent is waiting for your input: Agent p1 (Deck), 15 min.')
})
it('holds non-meeting nudges during focus and right after the user writes', async () => {
  nudgeReady()
  agent.reportSignals(signals())
  const id = taskId('Deep work')
  mutate({ operation: 'focus_start', priority: { source: 'personal', id }, minutes: 25 })
  await agent.tick(); expect(nudges()).toHaveLength(0)
  mutate({ operation: 'focus_stop' })
  await agent.chat('Quick question')
  now = new Date(now.getTime() + 9 * 60000); agent.reportSignals(signals())
  await agent.tick(); expect(nudges()).toHaveLength(0)
  now = new Date(now.getTime() + 60000); agent.reportSignals(signals())
  await agent.tick(); expect(nudges()).toHaveLength(1)
})
it('nudges once a day about due and overdue tasks after midday, offering focus on the first from the notification', async () => {
  nudgeReady()
  const overdue = taskId('Pay invoice'); mutate({ operation: 'task_edit', id: overdue, due: '2026-09-29' })
  const dueToday = taskId('Call dentist'); mutate({ operation: 'task_edit', id: dueToday, due: '2026-09-30' })
  const later = taskId('Plan trip'); mutate({ operation: 'task_edit', id: later, due: '2026-10-01' })
  const done = taskId('Done thing'); mutate({ operation: 'task_edit', id: done, due: '2026-09-30', done: true })
  taskId('Someday')
  now = new Date('2026-09-30T18:59:00Z')
  await agent.tick(); expect(nudges()).toHaveLength(0)
  now = new Date('2026-09-30T19:00:00Z')
  await agent.tick()
  expect(nudges()).toMatchObject([{ text: 'Still open and due today or earlier: “Pay invoice”, “Call dentist”. Start a 25-minute focus on “Pay invoice”?',
    suggestions: [{ type: 'start_focus', priority: { source: 'personal', id: overdue }, minutes: 25, state: 'open', label: 'Start 25-min focus' }] }])
  const [title, , actions] = notify.mock.calls[0]
  expect(title).toBe('Due today'); expect(actions!.map(a => a.label)).toEqual(['Start 25-min focus', 'Snooze 1h'])
  actions![0].run()
  expect(store.snapshot().focus).toMatchObject({ id: overdue, title: 'Pay invoice' })
  expect(nudges()[0].suggestions![0].state).toBe('accepted')
  mutate({ operation: 'focus_stop' })
  now = new Date('2026-09-30T19:30:00Z')
  await agent.tick(); expect(nudges()).toHaveLength(1)
  // Not after the evening slot.
  store.commit(d => { d.runs = d.runs.filter(r => !r.includes('dueToday')) })
  now = new Date('2026-09-30T21:30:00Z')
  await agent.tick(); expect(nudges()).toHaveLength(1)
})
it('gives notification buttons for snooze and marking a focused personal task done, and reports failures', async () => {
  mutate({ operation: 'settings', patch: { proactive: true } })
  store.commit(d => { d.runs.push(...today) })
  const id = taskId('Write proposal')
  mutate({ operation: 'focus_start', priority: { source: 'personal', id }, minutes: 25 })
  now = new Date(now.getTime() + 25 * 60000)
  await agent.tick()
  const [title, , actions] = notify.mock.calls[0]
  expect(title).toBe('Focus block finished'); expect(actions!.map(a => a.label)).toEqual(['Mark done', 'Snooze 1h'])
  actions![1].run()
  expect(store.snapshot().settings.snoozedUntil).toBe(now.getTime() + 3600000)
  actions![0].run()
  expect(store.snapshot()).toMatchObject({ tasks: [{ id, done: true, completedAt: now.toISOString() }], focus: null })
  mutate({ operation: 'task_delete', id })
  actions![0].run()
  expect(agent.snapshot().error).toBe('Task no longer exists.')
  // Board-card focus: only snooze.
  const card = work.mutate({ operation: 'create', title: 'Card' })
  if (!card.ok) throw Error('fixture')
  mutate({ operation: 'settings', patch: { snoozedUntil: 0 } })
  mutate({ operation: 'focus_start', priority: { source: 'board', id: card.item!.id }, minutes: 5 })
  now = new Date(now.getTime() + 5 * 60000)
  await agent.tick()
  expect(notify.mock.calls[1][2]!.map(a => a.label)).toEqual(['Snooze 1h'])
})
