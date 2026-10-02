import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { boundedText, isObject, type GoogleAction, type GoogleEvent, type GoogleMail, type GoogleOperation, type GoogleSnapshot } from '@shared/personal-agent'
import { PersonalSecrets } from './personal-secrets'

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events']
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
type Json = Record<string, any>
const dateTime = (s: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(s) && Number.isFinite(Date.parse(s))
const resourceId = (s: unknown): s is string => boundedText(s, 300, true) && /^[\w-]+$/.test(s)
const TOKEN = 'https://oauth2.googleapis.com/token'
const EXPIRED = 'Google sign-in expired. Reconnect Gmail & Calendar.'
/** Carries the HTTP status and, for the token endpoint only, Google's OAuth error code. Messages never include response bodies. */
class GoogleError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message) } }

/** This allowlist is shared by proposals and execution; a model cannot supply URLs or HTTP methods. */
export function googleActionArgs(operation: GoogleOperation, input: unknown): Record<string, string> {
  if (!isObject(input)) throw Error('Expected action fields.')
  const fields = operation === 'gmail_send' || operation === 'gmail_draft' ? ['to', 'subject', 'body', 'threadId', 'inReplyTo'] :
    operation === 'gmail_archive' || operation === 'gmail_mark_read' ? ['messageId'] :
      operation === 'calendar_create' ? ['title', 'start', 'end', 'description'] :
        operation === 'calendar_update' ? ['eventId', 'title', 'start', 'end', 'description'] :
          operation === 'calendar_delete' ? ['eventId'] : []
  if (!fields.length || Object.keys(input).some(k => !fields.includes(k)) || Object.values(input).some(v => !boundedText(v, 16000))) throw Error('Invalid Google action fields.')
  const a = input as Record<string, string>
  if (operation === 'gmail_send' || operation === 'gmail_draft') {
    const recipients = a.to?.split(',').map(s => s.trim())
    if (!recipients?.length || recipients.length > 5 || recipients.some(s => s.length > 320 || !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(s)) ||
      !boundedText(a.subject, 300, true) || /[\r\n]/.test(a.subject) || !boundedText(a.body, 16000, true) ||
      (a.threadId !== undefined && !resourceId(a.threadId)) || (a.inReplyTo !== undefined && (!/^<[^<>\s]+@[^<>\s]+>$/.test(a.inReplyTo) || a.inReplyTo.length > 300))) throw Error('Provide valid recipients, subject, and body. Email headers cannot contain line breaks.')
  } else if (operation.startsWith('gmail_') && !resourceId(a.messageId)) throw Error('Invalid Gmail message ID.')
  if (operation.startsWith('calendar_')) {
    if (operation !== 'calendar_create' && !resourceId(a.eventId)) throw Error('Invalid Calendar event ID.')
    if (operation !== 'calendar_delete' && (!boundedText(a.title, 200, true) || !dateTime(a.start || '') || !dateTime(a.end || '') || Date.parse(a.end) <= Date.parse(a.start))) throw Error('Use a title and a start/end with explicit time-zone offsets; end must follow start.')
  }
  return { ...a }
}
export function rawEmail(a: Record<string, string>): string {
  const chunks: string[] = []; let chunk = ''
  for (const char of a.subject) {
    if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = '' }
    chunk += char
  }
  if (chunk) chunks.push(chunk)
  const subject = chunks.map(c => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join('\r\n ')
  const headers = [`To: ${a.to.split(',').map(s => s.trim()).join(',\r\n ')}`, `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']
  if (a.inReplyTo) headers.push(`In-Reply-To: ${a.inReplyTo}`, `References: ${a.inReplyTo}`)
  const body = Buffer.from(a.body.replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g)?.join('\r\n') || ''
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body).toString('base64url')
}
const header = (payload: Json, name: string): string => payload?.headers?.find((h: Json) => h.name?.toLowerCase() === name)?.value || ''
export function plainMail(payload: Json): string {
  const text: string[] = []
  const html: string[] = []
  const visit = (part: Json, depth: number): void => {
    if (depth > 12 || text.join('').length > 16000) return
    if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string' && !part.filename) text.push(Buffer.from(part.body.data, 'base64url').toString('utf8'))
    if (part.mimeType === 'text/html' && typeof part.body?.data === 'string' && !part.filename && !html.length) html.push(Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 64000))
    if (Array.isArray(part.parts)) part.parts.slice(0, 30).forEach((p: Json) => visit(p, depth + 1))
  }
  visit(payload, 0)
  if (text.length) return text.join('\n').slice(0, 16000)
  // HTML-only messages are converted to inert text; no imported markup is rendered.
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return (html[0] || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name: string) => entities[name.toLowerCase()])
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    }).trim().slice(0, 16000)
}

export class PersonalGoogle {
  private cache: GoogleSnapshot = { configured: false, connected: false, connecting: false, mail: [], events: [] }
  private server?: Server
  private cancelAuth?: () => void
  private refreshFlight?: Promise<string>
  private syncFlight?: Promise<GoogleSnapshot>
  private generation = 0
  private requests = new AbortController()
  constructor(private secrets: PersonalSecrets, private openBrowser: (url: string) => Promise<unknown>, private changed: () => void = () => {}, private request: typeof fetch = fetch,
    private expired: (account: string) => void = () => {}) {
    try { const saved = secrets.read(); this.cache.configured = !!saved?.clientId; this.cache.connected = !!saved?.token; this.cache.account = saved?.token?.account }
    catch (e) { this.cache.error = (e as Error).message }
  }
  snapshot(): GoogleSnapshot { return structuredClone(this.cache) }
  private publish(): void { this.changed() }
  configure(input: unknown): GoogleSnapshot {
    if (this.cache.connecting || this.syncFlight) throw Error('Wait for the Google connection to finish first.')
    if (!isObject(input) || !boundedText(input.clientId, 300, true) || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(input.clientId) || !boundedText(input.clientSecret, 1000)) throw Error('Enter a Google Desktop app client ID and client secret.')
    const old = this.secrets.read()
    if (old?.token && old.clientId !== input.clientId) throw Error('Disconnect Google before changing its OAuth client.')
    this.secrets.write({ clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim(), token: old?.token })
    this.cache.configured = true; this.cache.error = undefined; this.publish(); return this.snapshot()
  }
  async connect(): Promise<GoogleSnapshot> {
    if (this.cache.connecting) throw Error('Google sign-in is already open.')
    const saved = this.secrets.read()
    if (!saved?.clientId) throw Error('Configure a Google Desktop app OAuth client first.')
    this.cache.connecting = true; this.cache.error = undefined; this.publish()
    const generation = this.generation
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      let resolveCode!: (code: string) => void
      let rejectCode!: (error: Error) => void
      const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
      // Install a rejection observer before asynchronous browser/server setup.
      void codePromise.catch(() => {})
      this.cancelAuth = () => rejectCode(Error('Google sign-in canceled.'))
      this.server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Security-Policy', "default-src 'none'")
        if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Invalid sign-in callback.'); return }
        const code = url.searchParams.get('code')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><title>Harness Deck</title><h1>Return to Harness Deck</h1><p>You may close this tab.</p>')
        if (!code || url.searchParams.has('error')) rejectCode(Error('Google access was not granted.'))
        else resolveCode(code)
      })
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
      const address = this.server.address()
      if (!address || typeof address === 'string') throw Error('Could not start Google sign-in.')
      const redirect = `http://127.0.0.1:${address.port}`
      const params = new URLSearchParams({ client_id: saved.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
        state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })
      timer = setTimeout(() => rejectCode(Error('Google sign-in timed out. Try connecting again.')), 180000)
      await this.openBrowser('https://accounts.google.com/o/oauth2/v2/auth?' + params)
      const code = await codePromise
      const token = await this.tokenRequest({ client_id: saved.clientId, client_secret: saved.clientSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' })
      if (typeof token.scope === 'string' && !SCOPES.every(scope => token.scope.split(' ').includes(scope))) throw Error('Grant both Gmail and Calendar permissions to connect the agent.')
      const profile = await this.http(GMAIL + '/profile', { headers: { Authorization: `Bearer ${token.access_token}` } })
      if (generation !== this.generation) throw Error('Google sign-in canceled.')
      if (!boundedText(profile.emailAddress, 320, true) || !boundedText(token.refresh_token, 4000, true)) throw Error('Google did not grant offline access. Reconnect and grant all requested permissions.')
      this.secrets.write({ ...saved, token: { access: token.access_token, refresh: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000, account: profile.emailAddress } })
      this.cache = { configured: true, connected: true, connecting: false, account: profile.emailAddress, mail: [], events: [] }
    } catch (e) { this.cache.error = (e as Error).message }
    finally { if (timer) clearTimeout(timer); this.server?.close(); this.server = undefined; this.cancelAuth = undefined; this.cache.connecting = false; this.publish() }
    if (this.cache.connected && !this.cache.error) await this.sync()
    return this.snapshot()
  }
  async disconnect(): Promise<GoogleSnapshot> {
    this.generation++; this.cancelAuth?.(); this.server?.close(); this.requests.abort(); this.requests = new AbortController()
    const saved = this.secrets.read()
    if (saved) this.secrets.write({ clientId: saved.clientId, clientSecret: saved.clientSecret })
    this.cache = { configured: !!saved?.clientId, connected: false, connecting: false, mail: [], events: [] }; this.publish()
    // Forget locally even when the user is offline. Best-effort revocation is bounded.
    if (saved?.token) {
      try { await this.request('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: saved.token.refresh }), signal: AbortSignal.timeout(10000), redirect: 'error' }) } catch { /* Local disconnect has succeeded. */ }
    }
    return this.snapshot()
  }
  cancelConnect(): GoogleSnapshot { this.cancelAuth?.(); this.server?.close(); return this.snapshot() }
  private async http(url: string, options: RequestInit = {}): Promise<Json> {
    let response: Response
    try { response = await this.request(url, { ...options, redirect: 'error', signal: AbortSignal.any([this.requests.signal, AbortSignal.timeout(20000)]) }) }
    catch { throw Error('Google request interrupted or timed out. Check your connection and try again.') }
    if (!response.ok) {
      // Only the token endpoint's OAuth error code is inspected; bodies never reach messages.
      const code = url === TOKEN ? await response.json().then((b: any) => typeof b?.error === 'string' ? b.error : undefined, () => undefined) : undefined
      throw new GoogleError(response.status === 401 ? 'Google authorization expired. Reconnect your account.' :
        response.status === 403 ? 'Google denied access. Enable Gmail and Calendar APIs and grant the requested permissions.' :
          response.status === 412 ? 'This Calendar event changed since the proposal. Ask the agent to prepare a fresh change.' : `Google returned HTTP ${response.status}.`, response.status, code)
    }
    if (response.status === 204) return {}
    try { return await response.json() as Json } catch { throw Error('Google returned an invalid response. Try again.') }
  }
  private async tokenRequest(fields: Record<string, string>): Promise<Json> {
    const token = await this.http(TOKEN, { method: 'POST', body: new URLSearchParams(fields) })
    if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in)) throw Error('Google returned an invalid access token.')
    return token
  }
  /** `rejected` is an access token an API just refused with 401; it forces one refresh unless a newer token is already stored. */
  private async accessToken(rejected?: string): Promise<string> {
    const saved = this.secrets.read()
    if (!saved?.token) throw Error(this.cache.error === EXPIRED ? EXPIRED : 'Connect Google first.')
    if (saved.token.account !== this.cache.account) throw Error('Stored Google account changed. Reconnect before using this proposal.')
    if (rejected ? saved.token.access !== rejected : saved.token.expiresAt > Date.now() + 60000) return saved.token.access
    if (!this.refreshFlight) {
      const generation = this.generation
      this.refreshFlight = (async () => {
        let token: Json
        try { token = await this.tokenRequest({ client_id: saved.clientId, client_secret: saved.clientSecret, refresh_token: saved.token!.refresh, grant_type: 'refresh_token' }) }
        catch (e) {
          if (!(e instanceof GoogleError && e.code === 'invalid_grant')) throw e
          throw Error(this.expire(generation, saved.token!.refresh) ? EXPIRED : 'Google sign-in changed. Try again.')
        }
        if (generation !== this.generation) throw Error('Google was disconnected.')
        this.secrets.write({ ...saved, token: { ...saved.token!, access: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 } })
        return token.access_token as string
      })().finally(() => { this.refreshFlight = undefined })
    }
    return this.refreshFlight
  }
  /** Refresh-token expiry/revocation: forget the token locally (no revocation needed), keep the OAuth client and account for same-account reconnects. */
  private expire(generation: number, refresh: string): boolean {
    const saved = this.secrets.read()
    // A disconnect or a fresh sign-in since the refresh began owns the state; the token check also makes this fire once.
    if (generation !== this.generation || !saved?.token || saved.token.refresh !== refresh) return false
    const account = saved.token.account
    this.secrets.write({ clientId: saved.clientId, clientSecret: saved.clientSecret })
    this.cache = { configured: true, connected: false, connecting: this.cache.connecting, account, mail: [], events: [], error: EXPIRED }
    this.publish()
    try { this.expired(account) } catch { /* Notification failures must not mask expiry. */ }
    return true
  }
  private async api(url: string, method = 'GET', body?: unknown, etag?: string): Promise<Json> {
    const send = (token: string): Promise<Json> => this.http(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const token = await this.accessToken()
    try { return await send(token) } catch (e) {
      if (!(e instanceof GoogleError && e.status === 401)) throw e
      // A refused access token gets one forced refresh; invalid_grant there marks the sign-in expired.
      // Only reads are retried (once); a refused write had no effect but is never automatically resent.
      const fresh = await this.accessToken(token)
      if (method !== 'GET') throw e
      return send(fresh)
    }
  }
  async searchMail(query: string): Promise<{ items: GoogleMail[]; limited: boolean }> {
    if (!boundedText(query, 500, true)) throw Error('Enter a Gmail search query.')
    const list = await this.api(GMAIL + '/messages?' + new URLSearchParams({ q: query, maxResults: '20' }))
    const items: GoogleMail[] = []
    // Keep Google request fan-out bounded to four at a time.
    const ids: Json[] = Array.isArray(list.messages) ? list.messages.slice(0, 20) : []
    for (let offset = 0; offset < ids.length; offset += 4) {
      items.push(...await Promise.all(ids.slice(offset, offset + 4).map(async row => {
        if (!resourceId(row.id)) throw Error('Invalid Gmail response.')
        const m = await this.api(GMAIL + '/messages/' + row.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject')
        return { id: m.id, threadId: m.threadId, from: header(m.payload, 'from').slice(0, 300), subject: header(m.payload, 'subject').slice(0, 500), snippet: String(m.snippet || '').slice(0, 1000), unread: m.labelIds?.includes('UNREAD') === true }
      })))
    }
    return { items, limited: !!list.nextPageToken }
  }
  async readMail(id: string): Promise<Json> {
    if (!resourceId(id)) throw Error('Invalid Gmail message ID.')
    const m = await this.api(GMAIL + '/messages/' + id + '?format=full')
    return { id: m.id, threadId: m.threadId, from: header(m.payload, 'from'), to: header(m.payload, 'to'), subject: header(m.payload, 'subject'),
      replyTo: header(m.payload, 'reply-to') || header(m.payload, 'from'), inReplyTo: header(m.payload, 'message-id'), body: plainMail(m.payload || {}), snippet: m.snippet }
  }
  async listEvents(start: string, end: string): Promise<{ items: GoogleEvent[]; limited: boolean }> {
    if (!dateTime(start) || !dateTime(end) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 31 * 86400000) throw Error('Calendar queries need a start/end with offsets and a range of at most 31 days.')
    const list = await this.api(CALENDAR + '?' + new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '100' }))
    return { items: (Array.isArray(list.items) ? list.items : []).map((e: Json) => ({ id: e.id, title: String(e.summary || 'Untitled event').slice(0, 200), start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, link: e.htmlLink })), limited: !!list.nextPageToken }
  }
  async sync(): Promise<GoogleSnapshot> {
    if (!this.cache.connected) return this.snapshot()
    if (this.syncFlight) return this.syncFlight
    const generation = this.generation
    this.syncFlight = (async () => {
      try {
        const now = Date.now()
        const [mail, events] = await Promise.all([this.searchMail('in:inbox newer_than:14d'), this.listEvents(new Date(now - 86400000).toISOString(), new Date(now + 7 * 86400000).toISOString())])
        if (generation === this.generation) { this.cache.mail = mail.items; this.cache.events = events.items; this.cache.syncedAt = new Date().toISOString(); this.cache.error = undefined }
      } catch (e) { if (generation === this.generation) this.cache.error = (e as Error).message }
      this.publish(); return this.snapshot()
    })().finally(() => { this.syncFlight = undefined })
    return this.syncFlight
  }
  async prepare(operation: GoogleOperation, input: unknown): Promise<{ args: Record<string, string>; title: string; account: string }> {
    if (!this.cache.connected || !this.cache.account) throw Error('Connect Google first.')
    const args = googleActionArgs(operation, input)
    const account = this.cache.account
    let title: string
    if (operation === 'gmail_send' || operation === 'gmail_draft') title = `${operation === 'gmail_send' ? 'Send email' : 'Save Gmail draft'} to ${args.to}: ${args.subject}`
    else if (operation.startsWith('gmail_')) {
      const mail = await this.readMail(args.messageId)
      args.originalSubject = String(mail.subject || '(no subject)').slice(0, 500)
      title = `${operation === 'gmail_archive' ? 'Archive' : 'Mark read'}: ${args.originalSubject}`
    } else if (operation === 'calendar_create') title = `Schedule: ${args.title}`
    else {
      const event = await this.api(CALENDAR + '/' + args.eventId)
      if (event.recurringEventId || event.recurrence || event.eventType && event.eventType !== 'default') throw Error('Manage recurring and special Calendar events in Google Calendar directly.')
      if (!boundedText(event.etag, 1000, true)) throw Error('Google did not return an event revision. Prepare this change again.')
      args.etag = event.etag
      args.originalTitle = String(event.summary || 'Untitled event').slice(0, 200)
      args.originalStart = event.start?.dateTime || event.start?.date || ''
      args.guests = (event.attendees || []).map((a: Json) => a.email).join(', ').slice(0, 2000)
      title = `${operation === 'calendar_delete' ? 'Delete' : 'Update'} event: ${args.originalTitle}`
    }
    if (account !== this.cache.account || !this.cache.connected) throw Error('Google account changed. Prepare this action again.')
    return { args, title: title.slice(0, 300), account }
  }
  async execute(action: GoogleAction): Promise<string> {
    if (!this.cache.connected || action.account !== this.cache.account) throw Error('This proposal belongs to a different or disconnected Google account. Reconnect that account or prepare a new proposal.')
    const { etag, originalTitle: _title, originalStart: _start, guests: _guests, originalSubject: _subject, ...fields } = action.args
    const a = googleActionArgs(action.operation, fields)
    if (action.operation === 'gmail_send' || action.operation === 'gmail_draft') {
      const message = { raw: rawEmail(a), ...(a.threadId ? { threadId: a.threadId } : {}) }
      await this.api(GMAIL + (action.operation === 'gmail_send' ? '/messages/send' : '/drafts'), 'POST', action.operation === 'gmail_send' ? message : { message })
      return action.operation === 'gmail_send' ? 'Email sent.' : 'Draft saved in Gmail.'
    }
    if (action.operation === 'gmail_archive' || action.operation === 'gmail_mark_read') {
      await this.api(GMAIL + '/messages/' + a.messageId + '/modify', 'POST', { removeLabelIds: [action.operation === 'gmail_archive' ? 'INBOX' : 'UNREAD'] }); return 'Gmail updated.'
    }
    if (action.operation === 'calendar_delete') { await this.api(CALENDAR + '/' + a.eventId + '?sendUpdates=all', 'DELETE', undefined, etag); return 'Calendar event deleted.' }
    await this.api(CALENDAR + (action.operation === 'calendar_update' ? '/' + a.eventId : '') + '?sendUpdates=all', action.operation === 'calendar_update' ? 'PATCH' : 'POST', {
      summary: a.title, ...(a.description !== undefined ? { description: a.description } : {}), start: { dateTime: a.start }, end: { dateTime: a.end }
    }, etag)
    return 'Calendar event saved.'
  }
  dispose(): void { this.generation++; this.cancelAuth?.(); this.server?.close(); this.requests.abort() }
}
