import { randomUUID } from 'node:crypto'
import { boundedText, dueCheckIn, isObject, localClock, personalModelConfigured, timeMinutes, validDue, validPriority, validSettings,
  type PersonalCommand, type PersonalMessage, type PersonalSnapshot, type Priority, type GoogleOperation } from '@shared/personal-agent'
import { WorkBoardService } from './work-board'
import { PersonalStore } from './personal-store'
import { PersonalGoogle } from './personal-google'
import { PERSONAL_SYSTEM, PERSONAL_TOOLS, runPersonalAI, type AgentRun } from './personal-ai'
import { runPersonalSubscription } from './personal-subscription'

/** Unresolved proposals block storage pruning; cap them so chat commits never hit the action limit. */
const MAX_OPEN_PROPOSALS = 20
interface Dependencies {
  store: PersonalStore; google: PersonalGoogle; work: WorkBoardService
  key: () => string | null
  changed: (snapshot: PersonalSnapshot) => void
  notify: (title: string, text: string) => void
  now?: () => Date
  run?: (run: AgentRun) => Promise<string>
}
export class PersonalAgent {
  private busy = false
  private error?: string
  private controller?: AbortController
  private timer?: ReturnType<typeof setInterval>
  private lastSync = 0
  private disposed = false
  private now: () => Date
  constructor(private deps: Dependencies) {
    this.now = deps.now || (() => new Date())
    if (!deps.store.error && deps.store.snapshot().actions.some(a => a.status === 'running')) {
      try { deps.store.commit(d => { for (const a of d.actions) if (a.status === 'running') { a.status = 'uncertain'; a.result = 'Deck stopped during this action. Check Google before preparing a replacement.' } }) }
      catch { this.error = 'Could not save interrupted-action recovery. Restore writable personal-agent storage before continuing.' }
    }
  }
  snapshot(): PersonalSnapshot { return { data: this.deps.store.snapshot(), google: this.deps.google.snapshot(), busy: this.busy, error: this.deps.store.error || this.error } }
  publish(): void { if (!this.disposed) this.deps.changed(this.snapshot()) }
  private title(priority: Priority, data = this.deps.store.snapshot()): string {
    if (priority.source === 'personal') {
      const task = data.tasks.find(t => t.id === priority.id && !t.done)
      if (task) return task.title
    } else {
      const board = this.deps.work.snapshot()
      if (board.ok) { const task = board.board.items.find(t => t.id === priority.id && ['ideas', 'in_progress'].includes(t.status)); if (task) return task.title }
    }
    throw Error('Choose an existing, unfinished task or board card.')
  }
  mutate(input: unknown, expectedRevision: unknown): PersonalSnapshot {
    const current = this.deps.store.snapshot()
    if (expectedRevision !== current.revision) throw Error('Your agent data changed. Reload it and try again.')
    if (!isObject(input)) throw Error('Invalid personal-agent operation.')
    const command = input as unknown as PersonalCommand
    const allowed: Record<string, string[]> = {
      settings: ['patch'], task_add: ['title', 'notes', 'due'], task_edit: ['id', 'title', 'notes', 'due', 'done'], task_delete: ['id'],
      memory_add: ['text'], memory_remove: ['id'], plan: ['intention', 'priorities'], focus_start: ['priority', 'minutes'],
      focus_stop: [], action_reject: ['id'], action_resolve: ['id', 'applied']
    }
    if (!allowed[command.operation] || Object.keys(input).some(k => k !== 'operation' && !allowed[command.operation].includes(k))) throw Error('Invalid personal-agent fields.')
    this.deps.store.commit(data => {
      switch (command.operation) {
        case 'settings': {
          if (!isObject(command.patch) || Object.keys(command.patch).some(k => !(k in data.settings))) throw Error('Invalid agent settings.')
          const settings = { ...data.settings, ...command.patch }
          if (!validSettings(settings)) throw Error('Choose a valid model ID, time zone, and ordered morning/check-in/evening times.')
          data.settings = settings; break
        }
        case 'task_add': {
          if (!boundedText(command.title, 200, true) || !boundedText(command.notes ?? '', 8000) || !validDue(command.due ?? '')) throw Error('Invalid task title, notes, or due date.')
          data.tasks.push({ id: randomUUID(), title: command.title.trim(), notes: command.notes || '', due: command.due || '', done: false, createdAt: this.now().toISOString() }); break
        }
        case 'task_edit': {
          const task = data.tasks.find(t => t.id === command.id)
          if (!task) throw Error('Task no longer exists.')
          if (command.title !== undefined) { if (!boundedText(command.title, 200, true)) throw Error('Invalid task title.'); task.title = command.title.trim() }
          if (command.notes !== undefined) { if (!boundedText(command.notes, 8000)) throw Error('Invalid task notes.'); task.notes = command.notes }
          if (command.due !== undefined) { if (!validDue(command.due)) throw Error('Invalid due date.'); task.due = command.due }
          if (command.done !== undefined) {
            if (typeof command.done !== 'boolean') throw Error('Invalid task status.')
            if (command.done && !task.done) task.completedAt = this.now().toISOString()
            if (!command.done) delete task.completedAt
            task.done = command.done
          }
          if (task.done && data.focus?.source === 'personal' && data.focus.id === task.id) data.focus = null
          break
        }
        case 'task_delete': {
          if (!data.tasks.some(t => t.id === command.id)) throw Error('Task no longer exists.')
          data.tasks = data.tasks.filter(t => t.id !== command.id)
          for (const plan of data.plans) plan.priorities = plan.priorities.filter(p => p.source !== 'personal' || p.id !== command.id)
          if (data.focus?.source === 'personal' && data.focus.id === command.id) data.focus = null
          break
        }
        case 'memory_add':
          if (!boundedText(command.text, 2000, true)) throw Error('Memory must be between 1 and 2000 characters.')
          if (!data.memories.some(m => m.text === command.text.trim())) data.memories.push({ id: randomUUID(), text: command.text.trim(), createdAt: this.now().toISOString() })
          break
        case 'memory_remove': data.memories = data.memories.filter(m => m.id !== command.id); break
        case 'plan': {
          if (!boundedText(command.intention, 2000) || !Array.isArray(command.priorities) || command.priorities.length > 3 || !command.priorities.every(validPriority) || new Set(command.priorities.map(p => p.source + ':' + p.id)).size !== command.priorities.length) throw Error('Choose up to three different priorities.')
          command.priorities.forEach(p => this.title(p, data))
          const day = localClock(this.now(), data.settings.timeZone).day
          data.plans = data.plans.filter(p => p.day !== day)
          data.plans.push({ day, intention: command.intention, priorities: command.priorities }); break
        }
        case 'focus_start': {
          if (!validPriority(command.priority) || !Number.isInteger(command.minutes) || command.minutes < 5 || command.minutes > 180) throw Error('Choose a task and a focus length from 5 to 180 minutes.')
          if (data.focus) throw Error('Finish or end the current focus block first.')
          data.focus = { ...command.priority, title: this.title(command.priority, data), startedAt: this.now().getTime(), endsAt: this.now().getTime() + command.minutes * 60000, reminded: false }; break
        }
        case 'focus_stop': data.focus = null; break
        case 'action_reject': {
          const action = data.actions.find(a => a.id === command.id)
          if (!action || action.status !== 'pending') throw Error('This action is no longer pending.')
          action.status = 'rejected'; break
        }
        case 'action_resolve': {
          const action = data.actions.find(a => a.id === command.id)
          if (!action || action.status !== 'uncertain' || typeof command.applied !== 'boolean') throw Error('Only uncertain actions can be reconciled after checking Google.')
          action.status = command.applied ? 'done' : 'rejected'
          action.result = command.applied ? 'Verified in Google by the user.' : 'User verified this change was not applied.'
          break
        }
      }
    })
    this.error = undefined; this.publish(); return this.snapshot()
  }
  async chat(input: unknown, kind?: PersonalMessage['kind']): Promise<PersonalSnapshot> {
    if (!boundedText(input, 8000, true)) throw Error('Enter a message of at most 8000 characters.')
    if (this.busy) throw Error('The agent is working. Wait or stop its current reply.')
    if (this.deps.store.error) throw Error(this.deps.store.error)
    const data = this.deps.store.snapshot()
    const settings = data.settings
    const key = settings.provider === 'openrouter' ? this.deps.key() : ''
    if (settings.provider === 'openrouter' && (!key || !settings.model)) throw Error('Choose a model and save an OpenRouter key in agent settings first.')
    this.busy = true; this.error = undefined; this.controller = new AbortController(); this.publish()
    try {
      if (!kind) this.deps.store.commit(d => { d.messages.push({ id: randomUUID(), role: 'user', text: input.trim(), at: this.now().toISOString() }) })
      if (this.deps.google.snapshot().connected) await this.deps.google.sync()
      this.controller.signal.throwIfAborted()
      const board = this.deps.work.snapshot()
      const google = this.deps.google.snapshot()
      const current = this.deps.store.snapshot()
      const clock = localClock(this.now(), current.settings.timeZone)
      const context = JSON.stringify({ now: this.now().toISOString(), localDay: clock.day, localMinutes: clock.minutes, timeZone: current.settings.timeZone,
        goalsAndPreferences: current.settings.context, memories: current.memories, tasks: current.tasks.filter(t => !t.done).slice(0, 150),
        recentlyCompleted: current.tasks.filter(t => t.done).slice(-20), plans: current.plans.slice(-7), focus: current.focus,
        board: board.ok ? { items: board.board.items.filter(t => ['ideas', 'in_progress'].includes(t.status)).slice(0, 100).map(t => ({ ...t, description: t.description.slice(0, 1000) })), total: board.board.items.length } : { error: board.error },
        google: { ...google, note: 'Cached inbox covers up to 20 recent inbox messages; primary calendar covers the next 7 days, up to 100 events. Search/list tools can query other ranges.' },
        recentActions: current.actions.slice(-20) })
      const history = current.messages.slice(kind ? -24 : -25, kind ? undefined : -1)
      const tools = kind ? PERSONAL_TOOLS.filter(t => ['set_priorities', 'gmail_search', 'gmail_read', 'calendar_list'].includes(t.name)) : PERSONAL_TOOLS
      const text = await (this.deps.run || (settings.provider === 'openrouter' ? runPersonalAI : runPersonalSubscription))({
        provider: settings.provider, cliEnvironment: settings.cliEnvironment,
        model: settings.provider === 'openrouter' ? settings.model : settings.subscriptionModel,
        key: key || '', system: PERSONAL_SYSTEM, context, history, prompt: input, tools,
        signal: this.controller.signal, execute: (name, args) => {
          this.controller!.signal.throwIfAborted()
          if (!tools.some(t => t.name === name)) throw Error('Unknown agent tool.')
          return this.executeTool(name, args, !!kind)
        } })
      this.controller.signal.throwIfAborted()
      this.deps.store.commit(d => { d.messages.push({ id: randomUUID(), role: 'assistant', text, at: this.now().toISOString(), ...(kind ? { kind } : {}) }) })
      const latest = this.deps.store.snapshot().settings
      if (kind && latest.proactive && latest.notifications && latest.snoozedUntil <= this.now().getTime()) this.deps.notify(kind === 'morning' ? 'Your daily focus' : kind === 'evening' ? 'Wrap up your day' : 'Time for a check-in', text.slice(0, 180))
    } catch (e) {
      const aborted = this.controller.signal.aborted
      this.error = aborted ? 'Agent reply stopped. Saved tasks and proposals are kept.' : e instanceof Error ? e.message : 'The agent could not finish its reply.'
      // A failed check-in keeps its slot (no retry burst); tell the user instead of failing silently.
      if (kind && !aborted) {
        const label = kind === 'morning' ? 'morning plan' : kind === 'evening' ? 'evening wrap-up' : 'check-in'
        const text = `Your scheduled ${label} couldn’t run: ${this.error.slice(0, 500)} Ask me here when you’d like to try again.`
        try {
          this.deps.store.commit(d => { d.messages.push({ id: randomUUID(), role: 'assistant', text, kind, at: this.now().toISOString() }) })
          const latest = this.deps.store.snapshot().settings
          if (latest.proactive && latest.notifications && latest.snoozedUntil <= this.now().getTime()) this.deps.notify('Check-in couldn’t run', text.slice(0, 180))
        } catch { /* this.error already reports the failure. */ }
      }
    }
    finally { this.busy = false; this.controller = undefined; this.publish() }
    return this.snapshot()
  }
  /** scheduled: a background check-in; it may not replace a plan the user already has for today. */
  private async executeTool(name: string, input: unknown, scheduled: boolean): Promise<unknown> {
    if (!isObject(input)) throw Error('Invalid tool fields.')
    const google = this.deps.google
    if (name === 'gmail_search') return google.searchMail(input.query as string)
    if (name === 'gmail_read') return google.readMail(input.id as string)
    if (name === 'calendar_list') return google.listEvents(input.start as string, input.end as string)
    if (name === 'propose_google_action') {
      const prepared = await google.prepare(input.operation as GoogleOperation, input.args)
      this.controller?.signal.throwIfAborted()
      let proposalId = ''
      const data = this.deps.store.commit(d => {
        const duplicate = d.actions.find(a => a.status === 'pending' && a.account === prepared.account && a.operation === input.operation && JSON.stringify(a.args) === JSON.stringify(prepared.args))
        if (!duplicate && d.actions.filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'uncertain').length >= MAX_OPEN_PROPOSALS) {
          throw Error(`There are already ${MAX_OPEN_PROPOSALS} Google proposals awaiting review. Do not prepare more; ask the user to approve, dismiss, or verify the pending proposals first.`)
        }
        proposalId = duplicate?.id || randomUUID()
        if (!duplicate) d.actions.push({ id: proposalId, operation: input.operation as GoogleOperation, ...prepared, status: 'pending', createdAt: this.now().toISOString() })
      })
      return { status: 'awaiting_user_approval', proposal: data.actions.find(a => a.id === proposalId) }
    }
    const commands: Record<string, string> = { add_task: 'task_add', edit_task: 'task_edit', remember: 'memory_add', set_priorities: 'plan' }
    if (!commands[name]) throw Error('Unknown agent tool.')
    if (scheduled && name === 'set_priorities') {
      const data = this.deps.store.snapshot()
      const day = localClock(this.now(), data.settings.timeZone).day
      if (data.plans.some(p => p.day === day)) throw Error('The user already set today’s plan. Do not change it from a scheduled check-in; suggest any changes in your reply instead.')
    }
    const snapshot = this.mutate({ ...input, operation: commands[name] }, this.deps.store.snapshot().revision)
    return { saved: true, tasks: snapshot.data.tasks.filter(t => !t.done).slice(-20), memories: snapshot.data.memories.slice(-5), plan: snapshot.data.plans.at(-1) }
  }
  stop(): PersonalSnapshot { this.controller?.abort(); return this.snapshot() }
  async approve(id: unknown): Promise<PersonalSnapshot> {
    if (typeof id !== 'string') throw Error('Invalid action.')
    const action = this.deps.store.snapshot().actions.find(a => a.id === id)
    if (!action || action.status !== 'pending') throw Error('This proposal has already been handled.')
    // Persist before any remote side effect. A restart never blindly retries a write.
    this.deps.store.commit(d => { d.actions.find(a => a.id === id)!.status = 'running' }); this.publish()
    try {
      const result = await this.deps.google.execute(action)
      this.deps.store.commit(d => { const a = d.actions.find(a => a.id === id)!; a.status = 'done'; a.result = result })
    } catch (e) {
      // Even a network error may have happened after the remote write committed.
      this.deps.store.commit(d => { const a = d.actions.find(a => a.id === id)!; a.status = 'uncertain'; a.result = (e instanceof Error ? e.message : 'Google action failed.') + ' Check Google before preparing a replacement.' })
    }
    this.publish(); await this.deps.google.sync(); return this.snapshot()
  }
  start(): void { this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 30000); this.timer.unref(); void this.tick().catch(() => {}) }
  async tick(): Promise<void> {
    if (this.disposed || this.deps.store.error) return
    const data = this.deps.store.snapshot()
    const now = this.now()
    if (this.deps.google.snapshot().connected && now.getTime() - this.lastSync >= 15 * 60000) {
      this.lastSync = now.getTime(); void this.deps.google.sync().catch(() => {})
    }
    const clock = localClock(now, data.settings.timeZone)
    const awake = clock.minutes >= timeMinutes(data.settings.morning) && clock.minutes < Math.min(1440, timeMinutes(data.settings.evening) + 90)
    if (data.focus && !data.focus.reminded && now.getTime() >= data.focus.endsAt && now.getTime() >= data.settings.snoozedUntil && awake) {
      const text = `Your focus block for “${data.focus.title}” has ended. What did you finish? Mark it done, choose the next step, or take a break.`
      this.deps.store.commit(d => { if (d.focus) d.focus.reminded = true; d.messages.push({ id: randomUUID(), role: 'assistant', text, kind: 'focus', at: now.toISOString() }) })
      this.publish(); if (data.settings.notifications) this.deps.notify('Focus block finished', text)
      return
    }
    if (this.busy || data.focus && now.getTime() < data.focus.endsAt || !personalModelConfigured(data.settings) || data.settings.provider === 'openrouter' && !this.deps.key()) return
    const kind = dueCheckIn(data, now)
    if (!kind) return
    this.deps.store.commit(d => { d.runs.push(`${clock.day}:${kind}`) })
    const prompts = { morning: 'Give me my morning briefing and save a realistic plan for today. What should I focus on first?', checkIn: 'Check in on today’s plan. Help me refocus and identify the next small step; ask about progress without assuming completion.', evening: 'Help me wrap up today, review what is actually done, and decide what deserves attention tomorrow.', focus: 'Check in on my focus block.' }
    await this.chat(prompts[kind], kind)
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.controller?.abort(); this.deps.google.dispose() }
}
