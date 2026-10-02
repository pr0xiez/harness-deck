import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { googleActionArgs, PersonalGoogle, plainMail, rawEmail } from './personal-google'
import { PersonalSecrets } from './personal-secrets'
import type { GoogleAction } from '@shared/personal-agent'
let dir: string
let secrets: PersonalSecrets
let google: PersonalGoogle
const response = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200 })
const request = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'hd-google-'))
  secrets = new PersonalSecrets(dir, { available: () => true, encrypt: s => Buffer.from(s), decrypt: b => b.toString() })
  secrets.write({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'client-secret', token: { access: 'access-secret', refresh: 'refresh-secret', expiresAt: Date.now() + 3600000, account: 'owner@example.com' } })
  request.mockImplementation(async url => {
    const u = String(url)
    if (u.includes('/token')) return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 })
    if (u.includes('/profile')) return response({ emailAddress: 'owner@example.com' })
    if (u.includes('/messages?')) return response({ messages: [] })
    if (u.includes('/events?')) return response({ items: [] })
    return response({})
  })
  google = new PersonalGoogle(secrets, vi.fn(async () => {}), vi.fn(), request)
})
afterEach(() => { google.dispose(); rmSync(dir, { recursive: true, force: true }) })
const action = (operation: GoogleAction['operation'], args: Record<string, string>): GoogleAction => ({ id: 'a', operation, args, account: 'owner@example.com', title: 'Review', status: 'pending', createdAt: new Date().toISOString() })
it('validates action fields and prevents arbitrary URLs, headers, and calendar ranges', () => {
  expect(() => googleActionArgs('gmail_send', { to: 'a@example.com\r\nBcc: other@example.com', subject: 'Hi', body: 'Hi' })).toThrow('recipients')
  expect(() => googleActionArgs('gmail_send', { to: 'a@example.com', subject: 'Hi\nBcc: b@example.com', body: 'Hi' })).toThrow('headers')
  expect(() => googleActionArgs('gmail_archive', { messageId: '../profile' })).toThrow('ID')
  expect(() => googleActionArgs('calendar_create', { title: 'Focus', start: '2026-09-30T09:00:00', end: '2026-09-30T10:00:00' })).toThrow('offsets')
  expect(() => googleActionArgs('calendar_create', { title: 'Focus', start: '2026-09-30T10:00:00Z', end: '2026-09-30T09:00:00Z' })).toThrow('end must')
  expect(() => googleActionArgs('calendar_create', { title: 'Focus', start: '2026-09-30T09:00:00Z', end: '2026-09-30T10:00:00Z', url: 'https://example.com' })).toThrow('fields')
})
it('encodes Unicode MIME safely and only reads plain text from messages', () => {
  const a = googleActionArgs('gmail_send', { to: 'a@example.com', subject: 'Hello ✦', body: 'Good morning\nOne step', inReplyTo: '<abc@example.com>' })
  const raw = Buffer.from(rawEmail(a), 'base64url').toString()
  expect(raw).toContain('To: a@example.com\r\nSubject: =?UTF-8?B?')
  expect(raw).toContain('In-Reply-To: <abc@example.com>')
  expect(Buffer.from(raw.split('\r\n\r\n')[1].replaceAll('\r\n', ''), 'base64').toString()).toBe('Good morning\r\nOne step')
  expect(plainMail({ mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/html', body: { data: Buffer.from('<script>attack()</script>').toString('base64url') } },
    { mimeType: 'text/plain', body: { data: Buffer.from('Message text').toString('base64url') } },
    { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('not the body').toString('base64url') } }
  ] })).toBe('Message text')
  expect(plainMail({ mimeType: 'text/html', body: { data: Buffer.from('<style>bad</style><p>One &amp; two</p><script>attack()</script><p>Next</p>').toString('base64url') } })).toBe('One & two\nNext')
  const long = rawEmail({ ...a, subject: '✦'.repeat(200) })
  expect(Buffer.from(long, 'base64url').toString().split('\r\n').every(line => line.length <= 320)).toBe(true)
})
it('never includes secrets in snapshots', () => {
  expect(google.snapshot()).toMatchObject({ connected: true, configured: true, account: 'owner@example.com' })
  expect(JSON.stringify(google.snapshot())).not.toMatch(/access-secret|refresh-secret|client-secret/)
})
it('blocks writes if a restored credential file belongs to another account', async () => {
  const saved = secrets.read()!; saved.token!.account = 'another@example.com'; secrets.write(saved)
  await expect(google.execute(action('gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'Hi' }))).rejects.toThrow('Stored Google account changed')
  expect(request).not.toHaveBeenCalled()
})
it('uses one refresh request across concurrent Google API reads', async () => {
  const saved = secrets.read()!; saved.token!.expiresAt = 0; secrets.write(saved)
  await Promise.all([google.searchMail('in:inbox'), google.listEvents('2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z')])
  expect(request.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1)
  expect(secrets.read()!.token!.access).toBe('new-access')
})
it('bounds inbox reads and returns an explicit truncation signal', async () => {
  request.mockImplementation(async url => String(url).includes('/messages?') ? response({ messages: [{ id: 'abc' }], nextPageToken: 'more' }) : response({ id: 'abc', threadId: 'def', labelIds: ['UNREAD'], snippet: 'Preview', payload: { headers: [{ name: 'From', value: 'a@example.com' }, { name: 'Subject', value: 'Next step' }] } }))
  const mail = await google.searchMail('from:a@example.com newer_than:7d')
  expect(mail).toEqual({ items: [{ id: 'abc', threadId: 'def', from: 'a@example.com', subject: 'Next step', snippet: 'Preview', unread: true }], limited: true })
  expect(String(request.mock.calls[0][0])).toContain('maxResults=20')
  expect(String(request.mock.calls[1][0])).toContain('format=metadata')
})
it('prepares calendar edits without writes and uses the reviewed event ETag when applied', async () => {
  request.mockImplementation(async () => response({ id: 'event1', summary: 'Old title', etag: '"v1"', start: { dateTime: '2026-09-30T09:00:00Z' }, attendees: [{ email: 'guest@example.com' }] }))
  const p = await google.prepare('calendar_update', { eventId: 'event1', title: 'New title', start: '2026-09-30T10:00:00Z', end: '2026-09-30T11:00:00Z' })
  expect(p.args).toMatchObject({ etag: '"v1"', guests: 'guest@example.com' })
  expect(request.mock.calls.every(([, options]) => options!.method === 'GET')).toBe(true)
  await google.execute(action('calendar_update', p.args))
  const options = request.mock.calls.at(-1)![1]!
  expect(options.method).toBe('PATCH'); expect(options.headers).toMatchObject({ 'If-Match': '"v1"' })
  expect(JSON.parse(String(options.body))).toEqual({ summary: 'New title', start: { dateTime: '2026-09-30T10:00:00Z' }, end: { dateTime: '2026-09-30T11:00:00Z' } })
})
it('blocks recurring event changes and proposals for another account', async () => {
  request.mockResolvedValue(response({ recurringEventId: 'series' }))
  await expect(google.prepare('calendar_delete', { eventId: 'occurrence' })).rejects.toThrow('recurring')
  await expect(google.execute({ ...action('gmail_archive', { messageId: 'abc' }), account: 'someone@example.com' })).rejects.toThrow('different')
  expect(request).toHaveBeenCalledOnce()
})
it('uses Gmail drafts and label changes without deleting messages', async () => {
  await google.execute(action('gmail_draft', { to: 'a@example.com', subject: 'Draft', body: 'Message', threadId: 'def' }))
  expect(String(request.mock.calls[0][0])).toContain('/drafts')
  expect(JSON.parse(String(request.mock.calls[0][1]!.body)).message.threadId).toBe('def')
  await google.execute(action('gmail_archive', { messageId: 'abc' }))
  expect(JSON.parse(String(request.mock.calls[1][1]!.body))).toEqual({ removeLabelIds: ['INBOX'] })
})
it('uses PKCE and rejects a forged callback before accepting the valid browser response', async () => {
  secrets.write({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'client-secret' })
  let authorization!: URL
  google.dispose()
  google = new PersonalGoogle(secrets, async url => {
    authorization = new URL(url)
    const redirect = authorization.searchParams.get('redirect_uri')!
    expect((await fetch(redirect + '/?state=forged&code=bad')).status).toBe(400)
    expect((await fetch(redirect + '/?' + new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'valid' }))).status).toBe(200)
  }, vi.fn(), request)
  const result = await google.connect()
  expect(result).toMatchObject({ connected: true, error: undefined })
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorization.searchParams.get('scope')).toContain('gmail.modify')
  const exchange = request.mock.calls.find(([url]) => String(url).includes('/token'))![1]!
  const fields = exchange.body as URLSearchParams
  expect(createHash('sha256').update(fields.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
  expect(fields.get('code')).toBe('valid')
})
it('forgets credentials and clears cached data on disconnect, even if revocation is offline', async () => {
  request.mockRejectedValueOnce(Error('offline'))
  await google.disconnect()
  expect(secrets.read()!.token).toBeUndefined()
  expect(google.snapshot()).toMatchObject({ connected: false, mail: [], events: [] })
  await expect(google.execute(action('gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'Hi' }))).rejects.toThrow('disconnected')
})
it('cancels browser sign-in without saving a token or leaving the listener open', async () => {
  secrets.write({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'client-secret' })
  google.dispose()
  let redirect = ''
  google = new PersonalGoogle(secrets, async url => {
    redirect = new URL(url).searchParams.get('redirect_uri')!
    google.cancelConnect()
  }, vi.fn(), request)
  const result = await google.connect()
  expect(result).toMatchObject({ connecting: false, connected: false, error: 'Google sign-in canceled.' })
  expect(secrets.read()!.token).toBeUndefined()
  await expect(fetch(redirect)).rejects.toThrow()
})
const expire = (): void => { const saved = secrets.read()!; saved.token!.expiresAt = 0; secrets.write(saved) }
const invalidGrant = (): Response => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })
it('disconnects once and keeps the OAuth client when Google expires the refresh token', async () => {
  const expired = vi.fn(); const changed = vi.fn()
  google.dispose(); google = new PersonalGoogle(secrets, vi.fn(async () => {}), changed, request, expired)
  expire()
  request.mockImplementation(async url => String(url).includes('/token') ? invalidGrant() : response({ messages: [], items: [] }))
  const result = await google.sync()
  expect(request.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1)
  expect(result).toMatchObject({ configured: true, connected: false, account: 'owner@example.com', mail: [], events: [], error: 'Google sign-in expired. Reconnect Gmail & Calendar.' })
  expect(JSON.stringify(result)).not.toMatch(/revoked|invalid_grant/)
  expect(secrets.read()).toEqual({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'client-secret' })
  expect(expired).toHaveBeenCalledOnce(); expect(expired).toHaveBeenCalledWith('owner@example.com'); expect(changed).toHaveBeenCalled()
  request.mockClear()
  await google.sync()
  await expect(google.searchMail('in:inbox')).rejects.toThrow('sign-in expired')
  await expect(google.execute(action('gmail_send', { to: 'a@example.com', subject: 'Hi', body: 'Hi' }))).rejects.toThrow('disconnected')
  expect(request).not.toHaveBeenCalled(); expect(expired).toHaveBeenCalledOnce()
})
it('treats a refused access token as revoked when the forced refresh is also refused', async () => {
  const expired = vi.fn()
  google.dispose(); google = new PersonalGoogle(secrets, vi.fn(async () => {}), vi.fn(), request, expired)
  request.mockImplementation(async url => String(url).includes('/token') ? invalidGrant() : new Response('{}', { status: 401 }))
  await expect(google.execute(action('gmail_archive', { messageId: 'abc' }))).rejects.toThrow('sign-in expired')
  expect(request.mock.calls.filter(([url]) => String(url).includes('/modify'))).toHaveLength(1)
  expect(google.snapshot()).toMatchObject({ connected: false }); expect(expired).toHaveBeenCalledOnce()
})
it('retries a refused read once after refreshing, but never resends a refused write', async () => {
  let refused = true
  request.mockImplementation(async (url, options) => {
    const u = String(url)
    if (u.includes('/token')) { refused = false; return response({ access_token: 'new-access', expires_in: 3600 }) }
    if (refused || (options?.headers as Record<string, string>).Authorization !== 'Bearer new-access') return new Response('{}', { status: 401 })
    return response({ items: [] })
  })
  await expect(google.listEvents('2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z')).resolves.toEqual({ items: [], limited: false })
  expect(request).toHaveBeenCalledTimes(3)
  const saved = secrets.read()!; saved.token!.access = 'stale'; secrets.write(saved); refused = true; request.mockClear()
  await expect(google.execute(action('gmail_archive', { messageId: 'abc' }))).rejects.toThrow('authorization expired')
  expect(request.mock.calls.filter(([url]) => String(url).includes('/modify'))).toHaveLength(1)
  expect(google.snapshot().connected).toBe(true)
})
it('does not let an expired refresh clobber a disconnect that happened during it', async () => {
  const expired = vi.fn()
  google.dispose(); google = new PersonalGoogle(secrets, vi.fn(async () => {}), vi.fn(), request, expired)
  expire()
  let release!: () => void
  request.mockImplementation(async url => {
    if (!String(url).includes('/token')) return response({})
    await new Promise<void>(resolve => { release = resolve }); return invalidGrant()
  })
  const pending = google.searchMail('in:inbox')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  await google.disconnect()
  google.configure({ clientId: 'example.apps.googleusercontent.com', clientSecret: 'client-secret' })
  release()
  await expect(pending).rejects.toThrow('sign-in changed')
  expect(expired).not.toHaveBeenCalled()
  expect(google.snapshot()).toMatchObject({ connected: false, error: undefined })
})
