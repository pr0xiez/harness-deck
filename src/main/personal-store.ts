import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundedText, emptyPersonalData, isObject, validDue, validPriority, validSettings, type PersonalData } from '@shared/personal-agent'

const timestamp = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v))
const id = (v: unknown): boolean => boundedText(v, 200, true)
/** Existing OpenRouter agents keep their provider and model after upgrading. */
function migratePersonalData(value: unknown): unknown {
  if (isObject(value) && value.version === 1 && isObject(value.settings)) {
    value.settings = { provider: 'openrouter', cliEnvironment: 'auto', subscriptionModel: '', ...value.settings }
  }
  return value
}
const rows = (v: unknown, max: number, validate: (v: Record<string, unknown>) => boolean): boolean => {
  if (!Array.isArray(v) || v.length > max) return false
  const ids = new Set<unknown>()
  return v.every(row => isObject(row) && id(row.id) && !ids.has(row.id) && (ids.add(row.id), validate(row)))
}
export function validPersonalData(v: unknown): v is PersonalData {
  if (!isObject(v) || v.version !== 1 || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !validSettings(v.settings)) return false
  return rows(v.tasks, 1000, t => boundedText(t.title, 200, true) && boundedText(t.notes, 8000) && validDue(t.due) && typeof t.done === 'boolean' && timestamp(t.createdAt) && (t.completedAt === undefined || timestamp(t.completedAt))) &&
    rows(v.memories, 100, m => boundedText(m.text, 2000, true) && timestamp(m.createdAt)) &&
    rows(v.messages, 300, m => ['user', 'assistant'].includes(String(m.role)) && boundedText(m.text, 24000, true) && timestamp(m.at) &&
      (m.kind === undefined || ['morning', 'checkIn', 'evening', 'focus'].includes(String(m.kind)))) &&
    rows(v.actions, 200, a => ['gmail_draft', 'gmail_send', 'gmail_archive', 'gmail_mark_read', 'calendar_create', 'calendar_update', 'calendar_delete'].includes(String(a.operation)) &&
      boundedText(a.title, 300, true) && boundedText(a.account, 320, true) && timestamp(a.createdAt) &&
      ['pending', 'running', 'done', 'rejected', 'uncertain'].includes(String(a.status)) && isObject(a.args) &&
      Object.keys(a.args).length <= 12 && Object.values(a.args).every(x => boundedText(x, 16000)) && (a.result === undefined || boundedText(a.result, 1000))) &&
    Array.isArray(v.plans) && v.plans.length <= 60 && v.plans.every(p => isObject(p) && validDue(p.day) && p.day && boundedText(p.intention, 2000) && Array.isArray(p.priorities) && p.priorities.length <= 3 && p.priorities.every(validPriority)) &&
    Array.isArray(v.runs) && v.runs.length <= 200 && v.runs.every(r => boundedText(r, 100, true)) &&
    (v.focus === null || (isObject(v.focus) && boundedText(v.focus.title, 200, true) &&
      typeof v.focus.startedAt === 'number' && Number.isFinite(v.focus.startedAt) && typeof v.focus.endsAt === 'number' &&
      Number.isFinite(v.focus.endsAt) && v.focus.endsAt > v.focus.startedAt && typeof v.focus.reminded === 'boolean' && validPriority(v.focus)))
}

const TASK_RETENTION = 30 * 86400000
const TASK_LIMIT = 1000
/** Completed tasks expire 30 days after completion (legacy: creation); planned/focused tasks are kept. Over the cap, oldest completions go first. */
export function pruneTasks(data: PersonalData, now: number): void {
  const kept = new Set([...data.plans.flatMap(p => p.priorities), ...(data.focus ? [data.focus] : [])].filter(p => p.source === 'personal').map(p => p.id))
  const completed = (t: PersonalData['tasks'][number]): number => Date.parse(t.completedAt || t.createdAt)
  data.tasks = data.tasks.filter(t => !t.done || kept.has(t.id) || completed(t) >= now - TASK_RETENTION)
  if (data.tasks.length <= TASK_LIMIT) return
  const drop = new Set(data.tasks.filter(t => t.done && !kept.has(t.id)).sort((a, b) => completed(a) - completed(b)).slice(0, data.tasks.length - TASK_LIMIT).map(t => t.id))
  data.tasks = data.tasks.filter(t => !drop.has(t.id))
}

/** Atomic, main-process-only persistence. Failed writes never advance in-memory state. */
export class PersonalStore {
  private data = emptyPersonalData()
  readonly file: string
  error?: string
  /** Known-valid primary (loaded or written by us). Only then may it replace the recovery backup. */
  private primaryValid = false
  constructor(base: string, private changed: () => void = () => {}, private now: () => number = Date.now) {
    this.file = join(base, 'personal-agent.json')
    for (const file of [this.file, this.file + '.bak']) {
      if (!existsSync(file)) continue
      try {
        const value = migratePersonalData(JSON.parse(readFileSync(file, 'utf8')))
        if (isObject(value) && value.version !== 1) {
          this.error = 'Unsupported personal-agent data version. Restore a compatible file before editing.'; return
        }
        if (validPersonalData(value)) { this.data = value; this.error = undefined; this.primaryValid = file === this.file; return }
      } catch { /* Try backup. */ }
      this.error = 'Personal-agent data is unreadable. Restore personal-agent.json from a valid backup and restart Deck.'
    }
  }
  snapshot(): PersonalData { return structuredClone(this.data) }
  commit(change: (next: PersonalData) => void): PersonalData {
    if (this.error) throw Error(this.error)
    const next = this.snapshot()
    change(next)
    next.revision++
    next.messages = next.messages.slice(-300)
    next.plans = next.plans.slice(-60)
    next.runs = next.runs.slice(-200)
    pruneTasks(next, this.now())
    // Retain unresolved actions; only prune old, resolved history.
    if (next.actions.length > 200) {
      const removable = next.actions.findIndex(a => a.status === 'done' || a.status === 'rejected')
      if (removable >= 0) next.actions.splice(removable, 1)
    }
    if (!validPersonalData(next)) throw Error('Invalid personal-agent data or storage limit reached.')
    mkdirSync(join(this.file, '..'), { recursive: true })
    if (this.primaryValid) copyFileSync(this.file, this.file + '.bak')
    writeFileSync(this.file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
    this.primaryValid = true
    this.data = next
    this.changed()
    return this.snapshot()
  }
}
