/** Personal-agent data is independent of terminal/workspace snapshots. No credentials cross IPC. */
export interface PersonalSettings {
  model: string
  timeZone: string
  context: string
  proactive: boolean
  notifications: boolean
  weekdaysOnly: boolean
  morning: string
  checkIn: string
  evening: string
  snoozedUntil: number
}
export interface PersonalTask {
  id: string; title: string; notes: string; due: string; done: boolean; createdAt: string
}
export interface PersonalMemory { id: string; text: string; createdAt: string }
export interface Priority { source: 'personal' | 'board'; id: string }
export interface DailyPlan { day: string; intention: string; priorities: Priority[] }
export interface FocusSession extends Priority { title: string; startedAt: number; endsAt: number; reminded: boolean }
export interface PersonalMessage {
  id: string; role: 'user' | 'assistant'; text: string; at: string
  kind?: 'morning' | 'checkIn' | 'evening' | 'focus'
}
export type GoogleOperation = 'gmail_draft' | 'gmail_send' | 'gmail_archive' | 'gmail_mark_read' |
  'calendar_create' | 'calendar_update' | 'calendar_delete'
export interface GoogleAction {
  id: string; operation: GoogleOperation; title: string; account: string
  args: Record<string, string>; createdAt: string
  status: 'pending' | 'running' | 'done' | 'rejected' | 'uncertain'
  result?: string
}
export interface PersonalData {
  version: 1; revision: number; settings: PersonalSettings
  tasks: PersonalTask[]; memories: PersonalMemory[]; plans: DailyPlan[]
  messages: PersonalMessage[]; actions: GoogleAction[]; focus: FocusSession | null
  runs: string[]
}
export interface GoogleMail { id: string; threadId: string; from: string; subject: string; snippet: string; unread: boolean }
export interface GoogleEvent { id: string; title: string; start: string; end: string; link?: string }
export interface GoogleSnapshot {
  configured: boolean; connected: boolean; connecting: boolean; account?: string
  mail: GoogleMail[]; events: GoogleEvent[]; syncedAt?: string; error?: string
}
export interface PersonalSnapshot {
  data: PersonalData; google: GoogleSnapshot; busy: boolean; error?: string
}
export type PersonalCommand =
  | { operation: 'settings'; patch: Partial<PersonalSettings> }
  | { operation: 'task_add'; title: string; notes?: string; due?: string }
  | { operation: 'task_edit'; id: string; title?: string; notes?: string; due?: string; done?: boolean }
  | { operation: 'memory_add'; text: string }
  | { operation: 'memory_remove'; id: string }
  | { operation: 'plan'; intention: string; priorities: Priority[] }
  | { operation: 'focus_start'; priority: Priority; minutes: number }
  | { operation: 'focus_stop' }
  | { operation: 'action_reject'; id: string }
  | { operation: 'action_resolve'; id: string; applied: boolean }

export function emptyPersonalData(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): PersonalData {
  return { version: 1, revision: 0, settings: {
    model: '', timeZone, context: '', proactive: false, notifications: true, weekdaysOnly: true,
    morning: '08:30', checkIn: '13:00', evening: '17:30', snoozedUntil: 0
  }, tasks: [], memories: [], plans: [], messages: [], actions: [], focus: null, runs: [] }
}
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const boundedText = (v: unknown, max: number, required = false): v is string =>
  typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0)
export const validDue = (v: unknown): v is string => typeof v === 'string' && (v === '' ||
  (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v))
const validTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
export function validSettings(v: unknown): v is PersonalSettings {
  if (!isObject(v) || !boundedText(v.model, 200) || (v.model !== '' && !/^[\w.-]+\/[\w./:@+-]+$/.test(v.model)) ||
    !boundedText(v.context, 12000) || !boundedText(v.timeZone, 100, true) ||
    !['proactive', 'notifications', 'weekdaysOnly'].every(k => typeof v[k] === 'boolean') ||
    !validTime(v.morning) || !validTime(v.checkIn) || !validTime(v.evening) ||
    !(v.morning < v.checkIn && v.checkIn < v.evening) ||
    typeof v.snoozedUntil !== 'number' || !Number.isFinite(v.snoozedUntil) || v.snoozedUntil < 0) return false
  try { new Intl.DateTimeFormat('en', { timeZone: v.timeZone }); return true } catch { return false }
}
export const validPriority = (v: unknown): v is Priority => isObject(v) &&
  (v.source === 'personal' || v.source === 'board') && boundedText(v.id, 200, true)
export function localClock(now: Date, timeZone: string): { day: string; minutes: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now)
  const value = (key: string): string => parts.find(p => p.type === key)!.value
  return { day: `${value('year')}-${value('month')}-${value('day')}`, minutes: Number(value('hour')) * 60 + Number(value('minute')),
    weekend: ['Sat', 'Sun'].includes(value('weekday')) }
}
export const timeMinutes = (v: string): number => Number(v.slice(0, 2)) * 60 + Number(v.slice(3))
/** A bounded catch-up window prevents overnight notification bursts after a restart. */
export function dueCheckIn(data: PersonalData, now: Date): PersonalMessage['kind'] | undefined {
  const s = data.settings
  if (!s.proactive || now.getTime() < s.snoozedUntil) return
  const clock = localClock(now, s.timeZone)
  if (s.weekdaysOnly && clock.weekend) return
  for (const kind of ['evening', 'checkIn', 'morning'] as const) {
    const delta = clock.minutes - timeMinutes(s[kind])
    if (delta >= 0) return delta < 90 && !data.runs.includes(`${clock.day}:${kind}`) ? kind : undefined
  }
}
