import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyPersonalData, type PersonalSuggestion } from '@shared/personal-agent'
import { PersonalStore } from './personal-store'
import { PersonalSecrets } from './personal-secrets'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hd-personal-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
it('persists independently and only publishes successfully saved commits', () => {
  const changed = vi.fn(); const store = new PersonalStore(dir, changed)
  store.commit(d => { d.memories.push({ id: 'a', text: 'Protect mornings', createdAt: new Date().toISOString() }) })
  expect(new PersonalStore(dir).snapshot().memories[0].text).toBe('Protect mornings')
  expect(changed).toHaveBeenCalledOnce()
  const copy = store.snapshot(); copy.memories.length = 0
  expect(store.snapshot().memories).toHaveLength(1)
  expect(() => store.commit(d => { d.settings.timeZone = 'invalid' })).toThrow()
  expect(store.snapshot().revision).toBe(1)
  expect(changed).toHaveBeenCalledOnce()
})
it('recovers a valid backup and preserves it while repairing a corrupt primary', () => {
  const store = new PersonalStore(dir)
  store.commit(d => { d.settings.context = 'First' }); store.commit(d => { d.settings.context = 'Second' })
  writeFileSync(store.file, 'broken')
  const recovered = new PersonalStore(dir)
  expect(recovered.snapshot().settings.context).toBe('First')
  recovered.commit(d => { d.settings.context = 'Repaired' })
  expect(JSON.parse(readFileSync(store.file + '.bak', 'utf8')).settings.context).toBe('First')
})
it('blocks writes when data is unreadable or newer than this app', () => {
  const file = join(dir, 'personal-agent.json')
  writeFileSync(file, 'broken')
  expect(() => new PersonalStore(dir).commit(() => {})).toThrow('unreadable')
  writeFileSync(file + '.bak', JSON.stringify(emptyPersonalData()))
  writeFileSync(file, JSON.stringify({ version: 99 }))
  expect(() => new PersonalStore(dir).commit(() => {})).toThrow('Unsupported')
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(99)
})
it('keeps Google credentials encrypted and refuses plaintext fallback', () => {
  const codec = { available: () => true, encrypt: (s: string) => Buffer.from([...s].reverse().join('')), decrypt: (b: Buffer) => [...b.toString()].reverse().join('') }
  const secrets = new PersonalSecrets(dir, codec)
  const value = { clientId: 'example', clientSecret: 'private-client-secret', token: { access: 'access-secret', refresh: 'refresh-secret', expiresAt: Date.now() + 10000, account: 'owner@example.com' } }
  secrets.write(value)
  const raw = readFileSync(join(dir, 'personal-google-key.json'), 'utf8')
  expect(raw).not.toContain(value.clientSecret); expect(raw).not.toContain(value.token.refresh)
  expect(secrets.read()).toEqual(value)
  expect(() => new PersonalSecrets(dir, { ...codec, available: () => false }).write(value)).toThrow('OS keychain')
})
it('migrates existing OpenRouter settings without resetting conversation or recovery backups', () => {
  const legacy = emptyPersonalData('America/New_York')
  legacy.settings.model = 'provider/model'
  legacy.messages.push({ id: 'm', role: 'assistant', text: 'Existing conversation', at: new Date().toISOString() })
  const value = JSON.parse(JSON.stringify(legacy))
  delete value.settings.provider; delete value.settings.cliEnvironment; delete value.settings.subscriptionModel
  const file = join(dir, 'personal-agent.json')
  writeFileSync(file, JSON.stringify(value))
  const store = new PersonalStore(dir)
  expect(store.error).toBeUndefined()
  expect(store.snapshot().settings).toMatchObject({ provider: 'openrouter', model: 'provider/model', cliEnvironment: 'auto', subscriptionModel: '' })
  store.commit(d => { d.settings.provider = 'chatgpt' })
  expect(JSON.parse(readFileSync(file + '.bak', 'utf8')).messages).toEqual(legacy.messages)
  expect(new PersonalStore(dir).snapshot()).toMatchObject({ messages: legacy.messages, settings: { provider: 'chatgpt' } })
})
it('prunes completed tasks after 30 days, keeping planned/focused ones and legacy data without completedAt', () => {
  const now = Date.parse('2026-09-30T12:00:00Z'); const day = 86400000
  const old = new Date(now - 40 * day).toISOString(); const recent = new Date(now - 5 * day).toISOString()
  const legacy = emptyPersonalData('America/New_York')
  legacy.tasks.push({ id: 'open', title: 'Open', notes: '', due: '', done: false, createdAt: old },
    { id: 'legacy-old', title: 'Legacy', notes: '', due: '', done: true, createdAt: old },
    { id: 'recent', title: 'Recent', notes: '', due: '', done: true, createdAt: old, completedAt: recent },
    { id: 'expired', title: 'Expired', notes: '', due: '', done: true, createdAt: old, completedAt: old },
    { id: 'planned', title: 'Planned', notes: '', due: '', done: true, createdAt: old, completedAt: old },
    { id: 'focused', title: 'Focused', notes: '', due: '', done: true, createdAt: old, completedAt: old })
  legacy.plans.push({ day: '2026-09-30', intention: '', priorities: [{ source: 'personal', id: 'planned' }] })
  legacy.focus = { source: 'personal', id: 'focused', title: 'Focused', startedAt: now, endsAt: now + 1000, reminded: false }
  writeFileSync(join(dir, 'personal-agent.json'), JSON.stringify(legacy))
  const store = new PersonalStore(dir, () => {}, () => now)
  expect(store.error).toBeUndefined(); expect(store.snapshot().tasks).toHaveLength(6)
  store.commit(() => {})
  expect(store.snapshot().tasks.map(t => t.id)).toEqual(['open', 'recent', 'planned', 'focused'])
  expect(() => store.commit(d => { d.tasks[0].completedAt = 'not a date' })).toThrow('Invalid')
})
it('drops the oldest completions instead of blocking new tasks at the task limit', () => {
  const now = Date.parse('2026-09-30T12:00:00Z')
  const store = new PersonalStore(dir, () => {}, () => now)
  store.commit(d => { for (let i = 0; i < 1000; i++) d.tasks.push({ id: `t${i}`, title: 'Task', notes: '', due: '', done: i < 3, createdAt: new Date(now).toISOString(), ...(i < 3 ? { completedAt: new Date(now - (10 - i) * 1000).toISOString() } : {}) }) })
  store.commit(d => { d.tasks.push({ id: 'new', title: 'New', notes: '', due: '', done: false, createdAt: new Date(now).toISOString() }) })
  const ids = store.snapshot().tasks.map(t => t.id)
  expect(ids).toHaveLength(1000); expect(ids).not.toContain('t0'); expect(ids).toContain('t1'); expect(ids).toContain('new')
})
it('backs up only a primary it knows is valid', () => {
  const store = new PersonalStore(dir)
  store.commit(d => { d.settings.context = 'First' })
  expect(existsSync(store.file + '.bak')).toBe(false)
  store.commit(d => { d.settings.context = 'Second' })
  expect(JSON.parse(readFileSync(store.file + '.bak', 'utf8')).settings.context).toBe('First')
  // Primary missing: recovered from backup, which must survive the next write untouched.
  rmSync(store.file)
  const recovered = new PersonalStore(dir)
  expect(recovered.snapshot().settings.context).toBe('First')
  recovered.commit(d => { d.settings.context = 'Third' })
  expect(JSON.parse(readFileSync(store.file + '.bak', 'utf8')).settings.context).toBe('First')
  recovered.commit(d => { d.settings.context = 'Fourth' })
  expect(JSON.parse(readFileSync(store.file + '.bak', 'utf8')).settings.context).toBe('Third')
})
it('migrates existing settings to onboarded with nudges on, while new data starts un-onboarded', () => {
  const value = JSON.parse(JSON.stringify(emptyPersonalData('America/New_York')))
  delete value.settings.onboarded; delete value.settings.nudges
  writeFileSync(join(dir, 'personal-agent.json'), JSON.stringify(value))
  const store = new PersonalStore(dir)
  expect(store.error).toBeUndefined()
  expect(store.snapshot().settings).toMatchObject({ onboarded: true, nudges: true })
  expect(emptyPersonalData().settings).toMatchObject({ onboarded: false, nudges: true })
  expect(() => store.commit(d => { (d.settings as unknown as Record<string, unknown>).nudges = 'yes' })).toThrow('Invalid')
})
it('validates nudge messages and suggestions, refusing malformed ones without losing saved data', () => {
  const store = new PersonalStore(dir)
  const at = new Date().toISOString()
  const priority = { source: 'personal' as const, id: 't1' }
  const valid: PersonalSuggestion[] = [
    { id: 'a', label: 'Add task: Call dentist', state: 'open', type: 'add_task', title: 'Call dentist', notes: 'Ask about Friday', due: '2026-10-01' },
    { id: 'b', label: 'Start 25-min focus', state: 'accepted', type: 'start_focus', priority, minutes: 25 },
    { id: 'c', label: 'Use this plan', state: 'dismissed', type: 'set_plan', intention: '', priorities: [priority, { source: 'board', id: 'card' }] }]
  store.commit(d => { d.messages.push({ id: 'm', role: 'assistant', kind: 'nudge', text: 'Due today', at, suggestions: valid }) })
  expect(new PersonalStore(dir).snapshot().messages[0]).toMatchObject({ kind: 'nudge', suggestions: valid })
  const invalid: [string, unknown][] = [
    ['too many', [...valid, { ...valid[0], id: 'd' }]],
    ['duplicate ids', [valid[0], { ...valid[1], id: 'a' }]],
    ['missing label', [{ ...valid[0], label: ' ' }]],
    ['long label', [{ ...valid[0], label: 'x'.repeat(81) }]],
    ['unknown state', [{ ...valid[0], state: 'done' }]],
    ['unknown type', [{ ...valid[0], type: 'delete_task' }]],
    ['extra field', [{ ...valid[0], command: 'rm' }]],
    ['missing title', [{ ...valid[0], title: '' }]],
    ['long notes', [{ ...valid[0], notes: 'x'.repeat(8001) }]],
    ['bad due', [{ ...valid[0], due: '2026-02-30' }]],
    ['short focus', [{ ...valid[1], minutes: 4 }]],
    ['fractional focus', [{ ...valid[1], minutes: 25.5 }]],
    ['bad priority', [{ ...valid[1], priority: { source: 'shell', id: 'x' } }]],
    ['four priorities', [{ ...valid[2], priorities: [1, 2, 3, 4].map(i => ({ source: 'board', id: `c${i}` })) }]],
    ['repeated priority', [{ ...valid[2], priorities: [priority, priority] }]],
    ['long intention', [{ ...valid[2], intention: 'x'.repeat(2001) }]],
    ['not an array', valid[0]]
  ]
  for (const [, suggestions] of invalid) expect(() => store.commit(d => { (d.messages[0] as unknown as Record<string, unknown>).suggestions = suggestions })).toThrow('Invalid')
  expect(() => store.commit(d => { d.messages.push({ id: 'u', role: 'user', text: 'Hi', at, suggestions: [valid[0]] }) })).toThrow('Invalid')
  expect(() => store.commit(d => { (d.messages[0] as unknown as Record<string, unknown>).kind = 'alarm' })).toThrow('Invalid')
  expect(store.snapshot().messages[0].suggestions).toEqual(valid)
})
