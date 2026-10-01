import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyPersonalData } from '@shared/personal-agent'
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
