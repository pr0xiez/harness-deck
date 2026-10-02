import { createHash, randomUUID } from 'node:crypto'
import { boundedText, dueCheckIn, isObject, localClock, MAX_SUGGESTIONS, personalModelConfigured, timeMinutes, validDeckSignals, validDue, validSettings,
  type DeckSignals, type PersonalCommand, type PersonalData, type PersonalMessage, type PersonalSnapshot, type PersonalSuggestion,
  type PersonalSuggestionBody, type Priority, type GoogleOperation } from '@shared/personal-agent'
import type { WorkResult } from '@shared/work-board'
import { WorkBoardService } from './work-board'
import { PersonalStore, validFocusInput, validPlanInput, validTaskInput } from './personal-store'
import { PersonalGoogle } from './personal-google'
import { PERSONAL_SYSTEM, PERSONAL_TOOLS, runPersonalAI, type AgentRun } from './personal-ai'
import { runPersonalSubscription } from './personal-subscription'

/** Unresolved proposals block storage pruning; cap them so chat commits never hit the action limit. */
const MAX_OPEN_PROPOSALS = 20
const MINUTE = 60000
/** Deck signals older than this are ignored (waiting agents, nudges). */
const SIGNAL_FRESH = 3 * MINUTE
const NUDGE_GAP = 10 * MINUTE
const NUDGES_PER_DAY = 8
/** A desktop-notification button (at most two are shown). run() never throws. */
export interface PersonalNotifyAction { label: string; run: () => void }
interface Dependencies {
  store: PersonalStore; google: PersonalGoogle; work: WorkBoardService
  key: () => string | null
  changed: (snapshot: PersonalSnapshot) => void
  notify: (title: string, text: string, actions?: PersonalNotifyAction[]) => void
  now?: () => Date
  run?: (run: AgentRun) => Promise<string>
}
const hash = (v: string): string => createHash('sha1').update(v).digest('hex').slice(0, 12)
/** One line of (possibly untrusted) display text for local templates and notification buttons. */
const clip = (v: string, max: number): string => { const t = v.replace(/\p{Cc}+/gu, ' ').trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t }
/** The user command a suggestion stands for; accepting runs exactly this. */
const suggestionCommand = (s: PersonalSuggestionBody): PersonalCommand => s.type === 'add_task' ? { operation: 'task_add', title: s.title, notes: s.notes, due: s.due } :
  s.type === 'start_focus' ? { operation: 'focus_start', priority: s.priority, minutes: s.minutes } : { operation: 'plan', intention: s.intention, priorities: s.priorities }
export class PersonalAgent {
  private busy = false
  private error?: string
  private controller?: AbortController
  private timer?: ReturnType<typeof setInterval>
  private lastSync = 0
  private disposed = false
  private now: () => Date
  /** Latest renderer-reported Deck status; memory only, never persisted or logged. */
  private signals?: DeckSignals
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
      focus_stop: [], action_reject: ['id'], action_resolve: ['id', 'applied'],
      suggestion_accept: ['messageId', 'suggestionId'], suggestion_dismiss: ['messageId', 'suggestionId']
    }
    if (!Object.hasOwn(allowed, command.operation) || Object.keys(input).some(k => k !== 'operation' && !allowed[command.operation].includes(k))) throw Error('Invalid personal-agent fields.')
    this.deps.store.commit(data => this.apply(data, command))
    this.error = undefined; this.publish(); return this.snapshot()
  }
  /** Applies one command to a draft. A throw discards the whole commit, so an accepted suggestion and its effect save together. */
  private apply(data: PersonalData, command: PersonalCommand): void {
    switch (command.operation) {
      case 'settings': {
        if (!isObject(command.patch) || Object.keys(command.patch).some(k => !(k in data.settings))) throw Error('Invalid agent settings.')
        const settings = { ...data.settings, ...command.patch }
        if (!validSettings(settings)) throw Error('Choose a valid model ID, time zone, and ordered morning/check-in/evening times.')
        data.settings = settings; break
      }
      case 'task_add': {
        if (!validTaskInput(command.title, command.notes ?? '', command.due ?? '')) throw Error('Invalid task title, notes, or due date.')
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
        if (!validPlanInput(command.intention, command.priorities)) throw Error('Choose up to three different priorities.')
        command.priorities.forEach(p => this.title(p, data))
        const day = localClock(this.now(), data.settings.timeZone).day
        data.plans = data.plans.filter(p => p.day !== day)
        data.plans.push({ day, intention: command.intention, priorities: command.priorities }); break
      }
      case 'focus_start': {
        if (!validFocusInput(command.priority, command.minutes)) throw Error('Choose a task and a focus length from 5 to 180 minutes.')
        if (data.focus) throw Error('Finish or end the current focus block first.')
        data.focus = { ...command.priority, title: this.title(command.priority, data), startedAt: this.now().getTime(), endsAt: this.now().getTime() + command.minutes * MINUTE, reminded: false }; break
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
      case 'suggestion_accept': {
        // The user's own action: a set_plan suggestion may replace today's plan.
        const suggestion = this.openSuggestion(data, command.messageId, command.suggestionId)
        try { this.apply(data, suggestionCommand(suggestion)) }
        catch (e) { throw Error(`Couldn’t apply “${suggestion.label}”: ${e instanceof Error ? e.message : 'invalid suggestion.'}`) }
        suggestion.state = 'accepted'; break
      }
      case 'suggestion_dismiss': this.openSuggestion(data, command.messageId, command.suggestionId).state = 'dismissed'; break
    }
  }
  private openSuggestion(data: PersonalData, messageId: unknown, suggestionId: unknown): PersonalSuggestion {
    const suggestion = data.messages.find(m => m.id === messageId)?.suggestions?.find(s => s.id === suggestionId)
    if (!suggestion || suggestion.state !== 'open') throw Error('This suggestion was already handled or no longer exists.')
    return suggestion
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
    const offered: PersonalSuggestion[] = []
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
        recentActions: current.actions.slice(-20), deck: this.deckContext(board, this.now().getTime()) })
      const history = current.messages.slice(kind ? -24 : -25, kind ? undefined : -1)
      const tools = kind ? PERSONAL_TOOLS.filter(t => ['set_priorities', 'suggest_actions', 'gmail_search', 'gmail_read', 'calendar_list'].includes(t.name)) : PERSONAL_TOOLS
      const text = await (this.deps.run || (settings.provider === 'openrouter' ? runPersonalAI : runPersonalSubscription))({
        provider: settings.provider, cliEnvironment: settings.cliEnvironment,
        model: settings.provider === 'openrouter' ? settings.model : settings.subscriptionModel,
        key: key || '', system: PERSONAL_SYSTEM, context, history, prompt: input, tools,
        signal: this.controller.signal, execute: (name, args) => {
          this.controller!.signal.throwIfAborted()
          if (!tools.some(t => t.name === name)) throw Error('Unknown agent tool.')
          return this.executeTool(name, args, !!kind, offered)
        } })
      this.controller.signal.throwIfAborted()
      // Suggestions offered during the run attach to its final reply.
      const message: PersonalMessage = { id: randomUUID(), role: 'assistant', text, at: this.now().toISOString(), ...(kind ? { kind } : {}), ...(offered.length ? { suggestions: offered } : {}) }
      this.deps.store.commit(d => { d.messages.push(message) })
      const latest = this.deps.store.snapshot().settings
      if (kind && latest.proactive && latest.notifications && latest.snoozedUntil <= this.now().getTime()) this.deps.notify(kind === 'morning' ? 'Your daily focus' : kind === 'evening' ? 'Wrap up your day' : 'Time for a check-in', text.slice(0, 180), this.messageActions(message))
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
          if (latest.proactive && latest.notifications && latest.snoozedUntil <= this.now().getTime()) this.deps.notify('Check-in couldn’t run', text.slice(0, 180), [this.snoozeAction()])
        } catch { /* this.error already reports the failure. */ }
      }
    }
    finally { this.busy = false; this.controller = undefined; this.publish() }
    return this.snapshot()
  }
  /** scheduled: a background check-in; it may not replace a plan the user already has for today. offered collects this run's suggestions. */
  private async executeTool(name: string, input: unknown, scheduled: boolean, offered: PersonalSuggestion[] = []): Promise<unknown> {
    if (!isObject(input)) throw Error('Invalid tool fields.')
    if (name === 'suggest_actions') return this.offer(input.suggestions, offered)
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
      if (data.plans.some(p => p.day === day)) throw Error('The user already set today’s plan. Do not change it from a scheduled check-in; offer a set_plan suggestion with suggest_actions instead.')
    }
    const snapshot = this.mutate({ ...input, operation: commands[name] }, this.deps.store.snapshot().revision)
    return { saved: true, tasks: snapshot.data.tasks.filter(t => !t.done).slice(-20), memories: snapshot.data.memories.slice(-5), plan: snapshot.data.plans.at(-1) }
  }
  /** Validates model suggestions for this run. Nothing executes until the user accepts one. */
  private offer(input: unknown, offered: PersonalSuggestion[]): unknown {
    if (!Array.isArray(input) || !input.length || input.length > MAX_SUGGESTIONS) throw Error(`Offer between 1 and ${MAX_SUGGESTIONS} suggestions.`)
    const data = this.deps.store.snapshot()
    const valid = input.map((v, i) => { try { return this.suggestion(v, data) } catch (e) { throw Error(`Suggestion ${i + 1} was not offered: ${e instanceof Error ? e.message : 'invalid.'} No suggestions from this call were offered.`) } })
    const key = (s: PersonalSuggestion): string => JSON.stringify(suggestionCommand(s))
    let dropped = false
    for (const s of valid) {
      if (offered.some(o => key(o) === key(s))) continue
      if (offered.length >= MAX_SUGGESTIONS) dropped = true; else offered.push(s)
    }
    return { offered: offered.map(s => s.label), note: 'Shown as buttons under your final reply. Nothing is saved unless the user accepts; do not describe these as done.' + (dropped ? ` Only ${MAX_SUGGESTIONS} suggestions are shown per reply.` : '') }
  }
  /** Same field rules as the equivalent user command; priorities must name existing, unfinished work. */
  private suggestion(v: unknown, data: PersonalData): PersonalSuggestion {
    if (!isObject(v) || !boundedText(v.label, 80, true)) throw Error('Give each suggestion a short label (at most 80 characters).')
    let body: PersonalSuggestionBody
    if (v.type === 'add_task') {
      const notes = v.notes ?? '', due = v.due ?? ''
      if (!validTaskInput(v.title, notes, due)) throw Error('Invalid task title, notes, or due date.')
      body = { type: 'add_task', title: String(v.title).trim(), ...(notes ? { notes: String(notes) } : {}), ...(due ? { due: String(due) } : {}) }
    } else if (v.type === 'start_focus') {
      if (!validFocusInput(v.priority, v.minutes)) throw Error('Choose a task and a focus length from 5 to 180 minutes.')
      const { source, id } = v.priority as Priority
      this.title({ source, id }, data)
      body = { type: 'start_focus', priority: { source, id }, minutes: Number(v.minutes) }
    } else if (v.type === 'set_plan') {
      const intention = v.intention ?? '', priorities = v.priorities
      if (!validPlanInput(intention, priorities)) throw Error('Choose up to three different priorities.')
      priorities.forEach(p => this.title(p, data))
      body = { type: 'set_plan', intention: String(intention), priorities: priorities.map(({ source, id }) => ({ source, id })) }
    } else throw Error('Suggestion type must be add_task, start_focus or set_plan.')
    return { id: randomUUID(), label: v.label.trim(), state: 'open', ...body }
  }
  /** Status-only Deck signals from the renderer. Only the latest report is kept, in memory. */
  reportSignals(signals: unknown): void {
    if (!validDeckSignals(signals)) throw Error('Invalid Deck signals.')
    this.signals = { reportedAt: signals.reportedAt,
      waitingAgents: signals.waitingAgents.map(({ paneId, label, workspace, waitingSince }) => ({ paneId, label, workspace, waitingSince })),
      github: signals.github.map(({ id, repository, number, title, signals }) => ({ id, repository, number, title, signals: [...signals] })) }
  }
  private freshSignals(now: number): DeckSignals | undefined {
    return this.signals && Math.abs(now - this.signals.reportedAt) <= SIGNAL_FRESH ? this.signals : undefined
  }
  /** What is blocked on the user: waiting agents (fresh reports only), GitHub attention, and in-progress cards untouched for 3+ days. */
  private deckContext(board: WorkResult, now: number): unknown {
    const age = (iso: string): number => now - Date.parse(iso)
    return {
      waitingAgents: (this.freshSignals(now)?.waitingAgents || []).map(a => ({ label: a.label, workspace: a.workspace, minutesWaiting: Math.max(0, Math.floor((now - a.waitingSince) / MINUTE)) })),
      githubAttention: (this.signals?.github || []).map(({ repository, number, title, signals }) => ({ repository, number, title, signals })),
      staleBoardCards: board.ok ? board.board.items.filter(t => t.status === 'in_progress' && age(t.updatedAt) > 3 * 86400000).sort((a, b) => age(b.updatedAt) - age(a.updatedAt))
        .slice(0, 10).map(t => ({ id: t.id, title: t.title, daysStale: Math.floor(age(t.updatedAt) / 86400000) })) : []
    }
  }
  /** Notification buttons: accept the message's first open suggestion, then snooze. */
  private messageActions(message: PersonalMessage): PersonalNotifyAction[] {
    const open = message.suggestions?.find(s => s.state === 'open')
    return [...(open ? [{ label: clip(open.label, 30), run: () => this.act({ operation: 'suggestion_accept', messageId: message.id, suggestionId: open.id }) }] : []), this.snoozeAction()]
  }
  private snoozeAction(): PersonalNotifyAction {
    return { label: 'Snooze 1h', run: () => this.act({ operation: 'settings', patch: { snoozedUntil: this.now().getTime() + 60 * MINUTE } }) }
  }
  /** Runs a notification button against the current revision; failures surface on the agent page. */
  private act(command: PersonalCommand): void {
    if (this.disposed) return
    try { this.mutate(command, this.deps.store.snapshot().revision) }
    catch (e) { this.error = e instanceof Error ? e.message : 'That action could not be applied.'; this.publish() }
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
      const focus = data.focus
      const text = `Your focus block for “${focus.title}” has ended. What did you finish? Mark it done, choose the next step, or take a break.`
      this.deps.store.commit(d => { if (d.focus) d.focus.reminded = true; d.messages.push({ id: randomUUID(), role: 'assistant', text, kind: 'focus', at: now.toISOString() }) })
      this.publish()
      // Completion stays explicit: "Mark done" is the user's click on a personal task, never inferred from the timer.
      if (data.settings.notifications) this.deps.notify('Focus block finished', text, [...(focus.source === 'personal' ? [{ label: 'Mark done', run: () => this.act({ operation: 'task_edit', id: focus.id, done: true }) }] : []), this.snoozeAction()])
      return
    }
    if (this.nudge(data, now, clock, awake)) return
    if (this.busy || data.focus && now.getTime() < data.focus.endsAt || !personalModelConfigured(data.settings) || data.settings.provider === 'openrouter' && !this.deps.key()) return
    const kind = dueCheckIn(data, now)
    const prompts: Partial<Record<NonNullable<PersonalMessage['kind']>, string>> = {
      morning: 'Give me my morning briefing. Lead with anything blocked on me: agents waiting for my input, pull requests needing my review, and stalled in-progress cards (skip what is empty). Then save a realistic plan for today, or suggest changes if I already set one. What should I focus on first?',
      checkIn: 'Check in on today’s plan. Help me refocus and identify the next small step; ask about progress without assuming completion.',
      evening: 'Help me wrap up today, review what is actually done, and decide what deserves attention tomorrow.' }
    const prompt = kind && prompts[kind]
    if (!kind || !prompt) return
    this.deps.store.commit(d => { d.runs.push(`${clock.day}:${kind}`) })
    await this.chat(prompt, kind)
  }
  /**
   * Event-driven nudges: local templates, no model call. At most one per tick, 10 minutes apart and 8 per local day,
   * deduplicated in runs as n:<day>:<type>:<hash>. Only meetings may interrupt focus or a recent conversation.
   */
  private nudge(data: PersonalData, now: Date, clock: ReturnType<typeof localClock>, awake: boolean): boolean {
    const s = data.settings, t = now.getTime()
    if (!s.proactive || !s.nudges || t < s.snoozedUntil || s.weekdaysOnly && clock.weekend || !awake) return false
    const sent = data.messages.filter(m => m.kind === 'nudge' && t - Date.parse(m.at) < 86400000)
    if (sent.length && t - Date.parse(sent.at(-1)!.at) < NUDGE_GAP) return false
    if (sent.filter(m => localClock(new Date(m.at), s.timeZone).day === clock.day).length >= NUDGES_PER_DAY) return false
    const key = (type: string, id: string): string => `n:${clock.day}:${type}:${hash(id)}`
    const fresh = (k: string): boolean => !data.runs.includes(k)
    const google = this.deps.google.snapshot()
    if (google.connected) {
      const soon = google.events.filter(e => typeof e.start === 'string' && e.start.includes('T')).map(e => ({ e, start: Date.parse(e.start), key: key('meeting', `${e.id}@${e.start}`) }))
        .filter(x => x.start > t && x.start - t <= 10 * MINUTE && fresh(x.key)).sort((a, b) => a.start - b.start)[0]
      if (soon) {
        const at = new Intl.DateTimeFormat('en-GB', { timeZone: s.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(soon.start)
        return this.sendNudge('Meeting soon', `“${clip(soon.e.title, 120)}” starts at ${at}. Anything to prep?`, [soon.key])
      }
    }
    const lastUser = data.messages.findLast(m => m.role === 'user')
    if (this.busy || data.focus && t < data.focus.endsAt || lastUser && t - Date.parse(lastUser.at) < NUDGE_GAP) return false
    const waiting = (this.freshSignals(t)?.waitingAgents || []).map(a => ({ a, key: key('agentWaiting', `${a.paneId}@${a.waitingSince}`) }))
      .filter(x => t - x.a.waitingSince >= 15 * MINUTE && fresh(x.key)).sort((a, b) => a.a.waitingSince - b.a.waitingSince).slice(0, 3)
    if (waiting.length) {
      const list = waiting.map(({ a }) => `${clip(a.label, 60)}${a.workspace.trim() ? ` (${clip(a.workspace, 40)})` : ''}, ${Math.floor((t - a.waitingSince) / MINUTE)} min`)
      return this.sendNudge('Agents waiting on you', `${waiting.length === 1 ? 'An agent is' : `${waiting.length} agents are`} waiting for your input: ${list.join('; ')}.`, waiting.map(x => x.key))
    }
    if (clock.minutes >= timeMinutes(s.checkIn) + 120 && clock.minutes < timeMinutes(s.evening)) {
      const dueKey = key('dueToday', clock.day)
      const due = data.tasks.filter(task => !task.done && task.due && task.due <= clock.day).sort((a, b) => a.due.localeCompare(b.due))
      if (due.length && fresh(dueKey)) {
        const names = due.slice(0, 3).map(task => `“${clip(task.title, 80)}”`).join(', ') + (due.length > 3 ? ` and ${due.length - 3} more` : '')
        const first = due[0]
        const suggestions: PersonalSuggestion[] = data.focus ? [] : [{ id: randomUUID(), label: 'Start 25-min focus', state: 'open', type: 'start_focus', priority: { source: 'personal', id: first.id }, minutes: 25 }]
        return this.sendNudge('Due today', `Still open and due today or earlier: ${names}.${suggestions.length ? ` Start a 25-minute focus on “${clip(first.title, 80)}”?` : ''}`, [dueKey], suggestions)
      }
    }
    return false
  }
  private sendNudge(title: string, text: string, keys: string[], suggestions: PersonalSuggestion[] = []): true {
    const message: PersonalMessage = { id: randomUUID(), role: 'assistant', text, kind: 'nudge', at: this.now().toISOString(), ...(suggestions.length ? { suggestions } : {}) }
    this.deps.store.commit(d => { d.runs.push(...keys); d.messages.push(message) })
    this.publish()
    if (this.deps.store.snapshot().settings.notifications) this.deps.notify(title, text.slice(0, 180), this.messageActions(message))
    return true
  }
  dispose(): void { this.disposed = true; if (this.timer) clearInterval(this.timer); this.controller?.abort(); this.deps.google.dispose() }
}
