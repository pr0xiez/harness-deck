import { useEffect, useRef, useState } from 'react'
import { emptyPersonalData, localClock, personalModelConfigured, type PersonalCliEnvironment, type PersonalProvider, type PersonalSubscriptionStatus, type PersonalCommand, type PersonalMessage, type PersonalSettings, type PersonalSnapshot, type Priority, type GoogleAction } from '@shared/personal-agent'
import type { WorkBoard, WorkItem } from '@shared/work-board'
import { useDeck } from '../store'
import { usePersonal, usePersonalFeed } from '../personal'
import { OpenRouterKey } from './OpenRouterKey'
import { PersonalSetup } from './PersonalSetup'
import { Modal } from './ui'
import { Icon } from './Icon'

const api = window.harness
const empty: PersonalSnapshot = { data: emptyPersonalData(), google: { configured: false, connected: false, connecting: false, mail: [], events: [] }, busy: false }
const same = (a: Priority, b: Priority): boolean => a.source === b.source && a.id === b.id
const duration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const kindLabels: Record<NonNullable<PersonalMessage['kind']>, string> = { morning: 'Morning', checkIn: 'Check-in', evening: 'Wrap-up', focus: 'Focus', nudge: 'Nudge' }
function eventTime(value: string, timeZone: string): string {
  if (value.length === 10) return value + ' · All day'
  return new Date(value).toLocaleString(undefined, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export function PersonalAgentPage(): React.JSX.Element {
  // The title-bar chip follows the same snapshot; the page still asks for a fresh copy on open.
  usePersonalFeed(true)
  const stored = usePersonal(s => s.snapshot)
  const loadError = usePersonal(s => s.error)
  const snapshot = stored ?? empty
  const loaded = !!stored
  const [board, setBoard] = useState<WorkBoard>({ version: 1, revision: -1, items: [] })
  const [error, setError] = useState('')
  const [acting, setActing] = useState(false)
  const [draft, setDraft] = useState('')
  const [memory, setMemory] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [taskEditor, setTaskEditor] = useState<string | null | undefined>()
  const [minutes, setMinutes] = useState(25)
  const [now, setNow] = useState(Date.now())
  const chatEnd = useRef<HTMLDivElement>(null)
  const workspaces = useDeck(s => s.workspaces)
  const setActiveWorkspace = useDeck(s => s.setActiveWorkspace)
  const receive = (value: PersonalSnapshot): void => usePersonal.getState().receive(value)
  const latest = (): PersonalSnapshot => usePersonal.getState().snapshot ?? empty
  useEffect(() => {
    let live = true
    const offBoard = api.work.onChanged(value => { if (live) setBoard(old => value.revision >= old.revision ? value : old) })
    void api.work.snapshot().then(value => {
      if (!live) return
      if (value.ok) setBoard(old => value.board.revision >= old.revision ? value.board : old)
      else setError(value.error)
    }).catch(e => { if (live) setError(String(e)) })
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { live = false; offBoard(); clearInterval(timer) }
  }, [])
  useEffect(() => { chatEnd.current?.scrollIntoView?.({ block: 'nearest' }) }, [snapshot.data.messages.length, snapshot.busy])
  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
    setActing(true); setError('')
    try { await action(); return true }
    catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this change.')
      try { receive(await api.personal.snapshot()) } catch { /* Keep the last visible snapshot. */ }
      return false
    } finally { setActing(false) }
  }
  const mutate = (command: PersonalCommand): Promise<boolean> => act(async () => receive(await api.personal.mutate(command, latest().data.revision)))
  const chat = async (text: string): Promise<void> => {
    if (!text.trim() || latest().busy) return
    const ok = await act(async () => receive(await api.personal.chat(text)))
    if (ok) setDraft(current => current === text ? '' : current)
  }
  const data = snapshot.data
  const google = snapshot.google
  const modelConfigured = personalModelConfigured(data.settings)
  const day = localClock(new Date(now), data.settings.timeZone).day
  const plan = data.plans.find(p => p.day === day)
  const priorities = plan?.priorities || []
  const busy = acting || !loaded
  const task = (p: Priority): { title: string; done: boolean; workspaceId?: string | null } | undefined => p.source === 'personal'
    ? data.tasks.find(t => t.id === p.id)
    : (() => { const card = board.items.find(t => t.id === p.id); return card && { title: card.title, done: card.status === 'done' || card.status === 'wont_do', workspaceId: card.workspaceId } })()
  const togglePriority = async (p: Priority): Promise<void> => {
    const next = priorities.some(i => same(i, p)) ? priorities.filter(i => !same(i, p)) : [...priorities, p]
    if (next.length > 3) { setError('Choose at most three priorities. Remove one before adding another.'); return }
    await mutate({ operation: 'plan', intention: plan?.intention || '', priorities: next.filter(p => task(p) && !task(p)!.done) })
  }
  const complete = async (p: Priority): Promise<void> => {
    if (p.source === 'personal') { await mutate({ operation: 'task_edit', id: p.id, done: true }); return }
    const card = board.items.find(i => i.id === p.id)
    if (!card) return
    await act(async () => {
      const result = await api.work.mutate({ operation: 'move', id: p.id, expectedRevision: card.revision, status: 'done' })
      if (!result.ok) { const fresh = await api.work.snapshot(); if (fresh.ok) setBoard(fresh.board); throw Error(result.error) }
      setBoard(result.board)
      if (data.focus && same(data.focus, p)) receive(await api.personal.mutate({ operation: 'focus_stop' }, latest().data.revision))
    })
  }
  const focus = (p: Priority): void => { void mutate({ operation: 'focus_start', priority: p, minutes }) }
  const pending = data.actions.filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'uncertain')
  const cards = board.items.filter(i => i.status === 'ideas' || i.status === 'in_progress')
  const onboarding = loaded && !data.settings.onboarded && !snapshot.error
  const dialogs = <>
    {settingsOpen && <AgentSettings key="settings" settings={data.settings} google={google} onClose={() => setSettingsOpen(false)} onSave={patch => mutate({ operation: 'settings', patch })} onGoogle={action => act(async () => { await action(); receive(await api.personal.snapshot()) })} />}
    {taskEditor !== undefined && <TaskEditor key={taskEditor || 'new'} task={data.tasks.find(t => t.id === taskEditor)} onClose={() => setTaskEditor(undefined)} onSave={async fields => { const ok = await mutate(taskEditor ? { operation: 'task_edit', id: taskEditor, ...fields } : { operation: 'task_add', ...fields }); if (ok) setTaskEditor(undefined); return ok }} />}
  </>

  if (onboarding) return <main className="personal-page">
    {error && <div role="alert" className="work-error">{error}</div>}
    <PersonalSetup settings={data.settings} busy={busy} onSave={patch => mutate({ operation: 'settings', patch })} onPlan={() => chat('Help me plan today.')} onOpenSettings={() => setSettingsOpen(true)} />
    {dialogs}
  </main>

  return <main className="personal-page">
    <header className="personal-head">
      <div><span className="personal-eyebrow">YOUR DAILY PARTNER</span><h1>Personal agent</h1><p>A clear direction. A small next step. Someone to keep you moving.</p></div>
      <div className="personal-head-actions">
        <span className="personal-status"><span className={`dot ${snapshot.busy ? 'running' : ''}`} />{snapshot.busy ? 'Thinking…' : data.settings.proactive ? 'Check-ins on' : 'On your terms'}</span>
        <button className="btn subtle" onClick={() => setSettingsOpen(true)}><Icon name="settings" />Agent settings</button>
      </div>
    </header>
    {(error || loadError || snapshot.error) && <div role="alert" className="work-error">{error || loadError || snapshot.error}</div>}
    {!loaded && !error && !loadError ? <p>Loading your agent…</p> : null}
    {loaded && (!modelConfigured || (!data.settings.context && !data.messages.length)) && <div className="personal-setup"><div><strong>Give your agent a place to start.</strong><p>Choose your subscription, add your goals, and connect Google when you’re ready.</p></div><button className="btn primary" disabled={busy} onClick={() => void mutate({ operation: 'settings', patch: { onboarded: false } })}>Set up your agent</button></div>}
    <div className="personal-layout">
      <div className="personal-day">
        <section className="personal-card personal-plan">
          <header><div><span className="personal-eyebrow">{day}</span><h2>Today’s focus</h2></div><span className="personal-count">{priorities.filter(p => task(p)?.done).length}/{priorities.length} done</span></header>
          {plan?.intention ? <p className="personal-intention">{plan.intention}</p> : <p className="personal-muted">Choose up to three things worth finishing. Your agent can help you make the call.</p>}
          <ol className="personal-priorities">
            {priorities.map((p, index) => {
              const item = task(p)
              return <li key={p.source + p.id} className={item?.done ? 'is-done' : ''}>
                <span className="personal-rank">{index + 1}</span><div><strong>{item?.title || 'Task unavailable'}</strong><small>{p.source === 'board' ? 'Work board' : 'Personal task'}</small>
                  {item && !item.done && <div className="personal-inline"><button className="btn ghost" disabled={busy || !!data.focus} onClick={() => focus(p)}>Focus</button><button className="btn ghost" disabled={busy} onClick={() => void complete(p)}>Mark done</button>
                    {item.workspaceId && workspaces.some(w => w.id === item.workspaceId) && <button className="btn ghost" onClick={() => setActiveWorkspace(item.workspaceId!)}>Open workspace</button>}</div>}
                </div><button className="icon-btn tiny" aria-label={`Remove priority ${index + 1}`} disabled={busy} onClick={() => void togglePriority(p)}><Icon name="close" size={12} /></button>
              </li>
            })}
          </ol>
          <div className="personal-inline"><button className="btn primary" disabled={busy || snapshot.busy || !modelConfigured} onClick={() => void chat('Help me plan today. Choose up to three realistic priorities from my tasks and board, consider my calendar and inbox, and save the plan.')}>Plan my day</button>
            <select aria-label="Focus block length" value={minutes} onChange={e => setMinutes(Number(e.target.value))}><option value={15}>15 min focus</option><option value={25}>25 min focus</option><option value={50}>50 min focus</option><option value={90}>90 min focus</option></select></div>
        </section>
        {data.focus && <section className="personal-card personal-focus"><span className="personal-eyebrow">ONE THING AT A TIME</span><h2>{data.focus.title}</h2><div className="personal-timer" aria-label="Focus time remaining">{duration(data.focus.endsAt - now)}</div><p>{now >= data.focus.endsAt ? 'Time to check in. What did you finish?' : 'Protect this time. You can check everything else afterward.'}</p><div className="personal-inline"><button className="btn primary" disabled={busy} onClick={() => void complete(data.focus!)}>Mark done</button><button className="btn subtle" disabled={busy} onClick={() => void mutate({ operation: 'focus_stop' })}>End focus</button></div></section>}
        <section className="personal-card"><header><h2>Things to move forward</h2><button className="btn ghost" disabled={busy} onClick={() => setTaskEditor(null)}>+ Add task</button></header>
          <div className="personal-task-list">{data.tasks.filter(t => !t.done).map(t => {
            const p: Priority = { source: 'personal', id: t.id }
            return <div className="personal-task" key={t.id}><input type="checkbox" aria-label={`Prioritize ${t.title}`} checked={priorities.some(i => same(i, p))} disabled={busy} onChange={() => void togglePriority(p)} /><button className="personal-task-title" onClick={() => setTaskEditor(t.id)}><strong>{t.title}</strong>{t.due && <small className={t.due < day ? 'overdue' : ''}>{t.due < day ? 'Overdue · ' : 'Due '}{t.due}</small>}</button><button className="icon-btn" aria-label={`Complete ${t.title}`} disabled={busy} onClick={() => void complete(p)}><Icon name="check" /></button><button className="icon-btn tiny" aria-label={`Delete ${t.title}`} disabled={busy} onClick={() => void mutate({ operation: 'task_delete', id: t.id })}><Icon name="close" size={12} /></button></div>
          })}</div>
          {!data.tasks.some(t => !t.done) && <p className="personal-muted">Capture a commitment here, or choose an existing board card below.</p>}
          <details className="personal-details"><summary>From your work board · {cards.length}</summary>{cards.slice(0, 50).map(card => <BoardChoice key={card.id} card={card} selected={priorities.some(p => p.source === 'board' && p.id === card.id)} disabled={busy} onToggle={() => void togglePriority({ source: 'board', id: card.id })} />)}{cards.length > 50 && <p>Showing 50 cards. Open Board to see all work.</p>}</details>
          {data.tasks.some(t => t.done) && <details className="personal-details"><summary>Completed · {data.tasks.filter(t => t.done).length}</summary>{data.tasks.filter(t => t.done).slice(-20).reverse().map(t => <div className="personal-task" key={t.id}><span>{t.title}</span><button className="btn ghost" disabled={busy} onClick={() => void mutate({ operation: 'task_edit', id: t.id, done: false })}>Reopen</button><button className="icon-btn tiny" aria-label={`Delete ${t.title}`} disabled={busy} onClick={() => void mutate({ operation: 'task_delete', id: t.id })}><Icon name="close" size={12} /></button></div>)}</details>}
        </section>
        <section className="personal-card"><header><h2>Your commitments & preferences</h2></header><p className="personal-muted">Keep the goals and boundaries your agent should remember.</p><ul className="personal-memories">{data.memories.map(m => <li key={m.id}><span>{m.text}</span><button className="icon-btn tiny" disabled={busy} aria-label={`Forget ${m.text}`} onClick={() => void mutate({ operation: 'memory_remove', id: m.id })}><Icon name="close" size={12} /></button></li>)}</ul><form className="personal-inline" onSubmit={e => { e.preventDefault(); void mutate({ operation: 'memory_add', text: memory }).then(ok => { if (ok) setMemory('') }) }}><input aria-label="New memory" value={memory} maxLength={2000} onChange={e => setMemory(e.target.value)} placeholder="What matters to you?" /><button className="btn subtle" disabled={busy || !memory.trim()}>Remember</button></form></section>
      </div>
      <div className="personal-conversation">
        <section className="personal-card personal-chat"><header><div><h2>Make progress, together</h2><p className="personal-muted">Your conversation and commitments stay with you.</p></div><Icon name="star" size={22} /></header>
          <div className="personal-chat-log" role="log" aria-label="Personal agent conversation" aria-live="polite">
            {!data.messages.length && <div className="personal-welcome"><span className="personal-orb">✦</span><h3>What would make today a good day?</h3><p>Tell me what’s on your mind. We’ll turn it into a manageable plan and start with one thing.</p></div>}
            {data.messages.map(m => <article key={m.id} className={`personal-message ${m.role}${m.kind === 'nudge' ? ' nudge' : ''}`}><header><strong>{m.role === 'user' ? 'You' : 'Deck'}{m.kind ? ` · ${kindLabels[m.kind] ?? 'Check-in'}` : ''}</strong><time dateTime={m.at}>{new Date(m.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></header><p>{m.text}</p>
              {m.role === 'assistant' && m.suggestions?.length ? <Suggestions message={m} disabled={busy || snapshot.busy} onAccept={id => void mutate({ operation: 'suggestion_accept', messageId: m.id, suggestionId: id })} onDismiss={id => void mutate({ operation: 'suggestion_dismiss', messageId: m.id, suggestionId: id })} /> : null}</article>)}
            {snapshot.busy && <p className="personal-thinking">Thinking through your next step…</p>}<div ref={chatEnd} />
          </div>
          <div className="personal-prompts">{['What should I focus on?', 'I’m stuck. Help me get moving.', 'Help me wrap up today.'].map(text => <button className="btn ghost" key={text} disabled={busy || snapshot.busy || !modelConfigured} onClick={() => void chat(text)}>{text}</button>)}</div>
          <form className="personal-composer" onSubmit={e => { e.preventDefault(); void chat(draft) }}><textarea aria-label="Message your personal agent" maxLength={8000} rows={3} value={draft} onChange={e => setDraft(e.target.value)} placeholder="A goal, a blocker, or something you need to get done…" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void chat(draft) } }} /><div><small>Ctrl/Cmd + Enter to send</small>{snapshot.busy ? <button type="button" className="btn subtle" onClick={() => void act(async () => receive(await api.personal.stop()))}>Stop reply</button> : <button className="btn primary" disabled={busy || !draft.trim() || !modelConfigured}>Send</button>}</div></form>
        </section>
        <section className="personal-card"><header><h2>Check-ins that help</h2><span className="personal-count">{data.settings.proactive ? 'On' : 'Off'}</span></header><p className="personal-muted">{data.settings.proactive ? `Morning ${data.settings.morning} · Refocus ${data.settings.checkIn} · Wrap-up ${data.settings.evening}. ${data.settings.timeZone}.` : 'Enable a morning plan, a midday nudge, and an evening review in agent settings.'} Check-ins run while Deck is open and pause during a focus block.</p><div className="personal-inline"><button className="btn subtle" disabled={busy} onClick={() => void mutate({ operation: 'settings', patch: { snoozedUntil: data.settings.snoozedUntil > now ? 0 : now + 3600000 } })}>{data.settings.snoozedUntil > now ? 'Resume check-ins' : 'Snooze for 1 hour'}</button><button className="btn ghost" onClick={() => setSettingsOpen(true)}>Adjust rhythm</button></div></section>
        {pending.length > 0 && <section className="personal-card"><header><h2>Ready for your review</h2><span className="personal-count">{pending.length}</span></header><p className="personal-muted">Review the exact change before your agent applies it.</p>{pending.map(a => <ActionCard key={a.id} action={a} disabled={busy} onApprove={() => void act(async () => receive(await api.personal.approve(a.id)))} onReject={() => void mutate({ operation: 'action_reject', id: a.id })} onResolve={applied => void mutate({ operation: 'action_resolve', id: a.id, applied })} />)}</section>}
        <section className="personal-card"><header><h2>Google, in view</h2><button className="btn ghost" disabled={busy || !google.connected} onClick={() => void act(async () => { await api.personal.google.sync(); receive(await api.personal.snapshot()) })}>Refresh</button></header>
          {google.connected && <div className="personal-inline"><button className="btn subtle" disabled={busy || snapshot.busy || !modelConfigured} onClick={() => void chat('Triage my inbox: highlight messages that need my attention, identify concrete next steps, and prepare useful replies for my review. Do not assume every message is urgent.')}>Triage inbox</button><button className="btn ghost" disabled={busy || snapshot.busy || !modelConfigured} onClick={() => void chat('Find a realistic focus block today for my top priority, around existing calendar commitments. Prepare a calendar event for my review.')}>Find focus time</button></div>}
          {google.error && <p className="oc-note bad" role="alert">{google.error}</p>}
          {!google.connected ? <div><p className="personal-muted">Bring your inbox and calendar into your daily plan. The agent can prepare replies, organize mail, and schedule focus time.</p><button className="btn subtle" onClick={() => setSettingsOpen(true)}>Connect Google</button></div> : <><p className="personal-muted">{google.account}{google.syncedAt ? ` · Synced ${new Date(google.syncedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ' · Waiting for first sync'}</p>
            <div className="personal-google-grid"><div><h3>Upcoming</h3>{google.events.filter(e => e.end.length === 10 ? e.end > day : Date.parse(e.end) > now).slice(0, 5).map(e => <button className="personal-google-item" key={e.id} onClick={() => e.link && api.openExternal(e.link)}><strong>{e.title}</strong><small>{eventTime(e.start, data.settings.timeZone)}</small></button>)}{!google.events.length && <p className="personal-muted">No events in the current snapshot.</p>}</div><div><h3>Recent inbox</h3>{google.mail.slice(0, 5).map(m => <button className="personal-google-item" key={m.id} onClick={() => api.openExternal('https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(google.account || '') + '#search/' + encodeURIComponent(m.subject))}><strong>{m.unread ? '● ' : ''}{m.subject || '(no subject)'}</strong><small>{m.from}</small></button>)}{!google.mail.length && <p className="personal-muted">No recent inbox messages.</p>}</div></div><small className="personal-muted">Snapshot: up to 20 recent inbox messages and 100 primary-calendar events over 7 days.</small></>}
        </section>
        {data.actions.some(a => a.status === 'done' || a.status === 'rejected') && <details className="personal-card personal-details"><summary>Recent Google actions</summary>{data.actions.filter(a => a.status === 'done' || a.status === 'rejected').slice(-10).reverse().map(a => <p key={a.id}>{a.title} · {a.status === 'done' ? a.result : 'Dismissed'}</p>)}</details>}
      </div>
    </div>
    {dialogs}
  </main>
}

/** One-click follow-ups the agent offered. Accepting runs the same command the user could have run by hand. */
function Suggestions({ message, disabled, onAccept, onDismiss }: { message: PersonalMessage; disabled: boolean; onAccept: (id: string) => void; onDismiss: (id: string) => void }): React.JSX.Element | null {
  const shown = (message.suggestions || []).filter(s => s.state !== 'dismissed')
  if (!shown.length) return null
  const first = shown.find(s => s.state === 'open')
  return <div className="personal-suggestions" role="group" aria-label="Suggested next steps">{shown.map(s => s.state === 'accepted'
    ? <span key={s.id} className="personal-suggestion-done">✓ {s.label}</span>
    : <span key={s.id} className="personal-suggestion"><button className={`btn ${s === first ? 'primary' : 'subtle'}`} disabled={disabled} onClick={() => onAccept(s.id)}>{s.label}</button><button className="icon-btn tiny" aria-label={`Dismiss ${s.label}`} title="Dismiss suggestion" disabled={disabled} onClick={() => onDismiss(s.id)}><Icon name="close" size={11} /></button></span>)}</div>
}

function BoardChoice({ card, selected, disabled, onToggle }: { card: WorkItem; selected: boolean; disabled: boolean; onToggle: () => void }): React.JSX.Element {
  return <label className="personal-task"><input type="checkbox" aria-label={`Prioritize board card ${card.title}`} checked={selected} disabled={disabled} onChange={onToggle} /><span><strong>{card.title}</strong><small>{card.status === 'in_progress' ? 'In progress' : 'Idea'}</small></span></label>
}
function ActionCard({ action, disabled, onApprove, onReject, onResolve }: { action: GoogleAction; disabled: boolean; onApprove: () => void; onReject: () => void; onResolve: (applied: boolean) => void }): React.JSX.Element {
  const labels: Record<string, string> = { to: 'To', subject: 'Subject', body: 'Message', title: 'Event', start: 'Start', end: 'End', description: 'Notes', originalTitle: 'Current event', originalStart: 'Current start', originalSubject: 'Email', guests: 'Guests notified' }
  const reply = action.operation.startsWith('gmail_') && !!(action.args.threadId || action.args.inReplyTo)
  return <article className="personal-action"><strong>{action.title}</strong><small>Account: {action.account}{reply ? ' · Reply in thread' : ''}</small><dl>{Object.entries(action.args).filter(([key, value]) => labels[key] && value).map(([key, value]) => <div key={key}><dt>{labels[key]}</dt><dd>{value}</dd></div>)}</dl>{action.result && <p role="status">{action.result}</p>}{action.status === 'running' && <p>Applying change…</p>}<div className="personal-inline">{action.status === 'uncertain' ? <><button className="btn subtle" disabled={disabled} onClick={() => api.openExternal(action.operation.startsWith('gmail_') ? 'https://mail.google.com/' : 'https://calendar.google.com/')}>Check in Google</button><button className="btn ghost" disabled={disabled} onClick={() => onResolve(true)}>I verified it was applied</button><button className="btn ghost" disabled={disabled} onClick={() => onResolve(false)}>I verified it wasn’t applied</button></> : <><button className="btn primary" disabled={disabled || action.status !== 'pending'} onClick={onApprove}>{action.operation === 'gmail_send' ? 'Approve & send email' : action.operation === 'calendar_delete' ? 'Approve & delete event' : 'Approve change'}</button><button className="btn ghost" disabled={disabled || action.status !== 'pending'} onClick={onReject}>Dismiss</button></>}</div></article>
}

function TaskEditor({ task, onSave, onClose }: { task?: PersonalSnapshot['data']['tasks'][number]; onSave: (fields: { title: string; notes: string; due: string }) => Promise<boolean>; onClose: () => void }): React.JSX.Element {
  const [base, setBase] = useState(task)
  const [title, setTitle] = useState(task?.title || '')
  const [notes, setNotes] = useState(task?.notes || '')
  const [due, setDue] = useState(task?.due || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const stale = base && task && (base.title !== task.title || base.notes !== task.notes || base.due !== task.due || base.done !== task.done)
  return <Modal title={task ? 'Edit personal task' : 'Capture a commitment'} onClose={() => { if (!saving) onClose() }}><form className="personal-form" onSubmit={e => { e.preventDefault(); if (stale) return; setSaving(true); void onSave({ title, notes, due }).then(ok => { if (!ok) setError('Could not save. Close this dialog to see the error and current data.') }).finally(() => setSaving(false)) }}><label>What needs to get done?<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label><label>Notes & next step<textarea rows={4} maxLength={8000} value={notes} onChange={e => setNotes(e.target.value)} /></label><label>Due date (optional)<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>{stale && <div role="alert"><p>This task changed while you were editing. Reload it before saving.</p><button type="button" className="btn subtle" onClick={() => { setBase(task); setTitle(task!.title); setNotes(task!.notes); setDue(task!.due) }}>Reload current task</button></div>}{error && <p role="alert">{error}</p>}<button className="btn primary" disabled={saving || !title.trim() || !!stale}>Save task</button></form></Modal>
}

function AgentSettings({ settings, google, onSave, onGoogle, onClose }: {
  settings: PersonalSettings; google: PersonalSnapshot['google']; onSave: (patch: Partial<PersonalSettings>) => Promise<boolean>
  onGoogle: (action: () => Promise<unknown>) => Promise<boolean>; onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(settings)
  const [models, setModels] = useState<string[]>([])
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [subscription, setSubscription] = useState<PersonalSubscriptionStatus>()
  const [checking, setChecking] = useState(false)
  const [checkVersion, setCheckVersion] = useState(0)
  const patch = (value: Partial<PersonalSettings>): void => setDraft(d => ({ ...d, ...value }))
  useEffect(() => {
    if (draft.provider === 'openrouter') return
    let live = true
    setSubscription(undefined); setChecking(true)
    void api.personal.subscriptionStatus(draft.provider, draft.cliEnvironment).then(value => { if (live) setSubscription(value) })
      .catch(() => { if (live) setSubscription({ available: false, signedIn: false, message: 'Could not check sign-in. Check your CLI installation and try again.' }) })
      .finally(() => { if (live) setChecking(false) })
    return () => { live = false }
  }, [draft.provider, draft.cliEnvironment, checkVersion])
  const googleAction = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setNote('')
    try { const ok = await onGoogle(action); if (!ok) setNote('Google setup failed. Close this dialog to see the connection error.'); else { setClientSecret(''); setNote('Google settings updated.') } }
    finally { setBusy(false) }
  }
  return <Modal title="Your personal agent" onClose={() => { if (!busy) onClose() }} wide><div className="personal-settings">
    <form className="personal-form" onSubmit={e => { e.preventDefault(); setBusy(true); setNote(''); void onSave(draft).then(ok => { setNote(ok ? 'Agent settings saved.' : 'Settings could not be saved. Check the time zone and ordered check-in times; close this dialog for details.') }).finally(() => setBusy(false)) }}>
      <h3>How your agent helps</h3><label>Goals, responsibilities & boundaries<textarea rows={4} maxLength={12000} value={draft.context} onChange={e => patch({ context: e.target.value })} placeholder="What are you working toward? What needs protecting? How direct should your agent be?" /></label>
      <label>Use for replies<select value={draft.provider} onChange={e => patch({ provider: e.target.value as PersonalProvider, subscriptionModel: '' })}>
        <option value="chatgpt">ChatGPT subscription (Codex)</option><option value="claude">Claude subscription (Claude Code)</option><option value="openrouter">OpenRouter credits</option>
      </select></label>
      {draft.provider === 'openrouter' ? <>
        <label>OpenRouter model<div className="personal-inline"><input list="personal-models" maxLength={200} value={draft.model} onChange={e => patch({ model: e.target.value })} placeholder="provider/model-id" /><button type="button" className="btn subtle" disabled={busy} onClick={() => { setBusy(true); void api.openRouter.models().then(value => { setModels(value.models); if (value.error) setNote(value.error) }).catch(() => setNote('Could not load models. Enter a model ID manually.')).finally(() => setBusy(false)) }}>Load models</button></div><datalist id="personal-models">{models.map(m => <option key={m} value={m} />)}</datalist></label>
        <p className="personal-muted">Messages and relevant task, email, and calendar context go to your chosen OpenRouter model. Replies and scheduled check-ins use OpenRouter credits.</p>
      </> : <>
        <label>Subscription CLI<select value={draft.cliEnvironment} onChange={e => patch({ cliEnvironment: e.target.value as PersonalCliEnvironment })}><option value="auto">Auto detect sign-in</option><option value="native">This system</option><option value="wsl">WSL</option></select></label>
        <label>Subscription model (optional)<input maxLength={200} value={draft.subscriptionModel} onChange={e => patch({ subscriptionModel: e.target.value })} placeholder="Use the CLI’s default model" /></label>
        <p className="personal-muted">Replies and scheduled check-ins use your {draft.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} subscription through its signed-in CLI, subject to your plan’s usage limits. No API key is needed. Your conversation stays in Deck when you switch subscriptions.</p>
        <p role="status">{checking ? 'Checking subscription sign-in…' : subscription?.message}</p><button type="button" className="btn subtle" disabled={checking || busy} onClick={() => setCheckVersion(v => v + 1)}>Check sign-in</button>
        <p className="personal-muted">Messages and relevant task, email, and calendar context go to the selected provider. Sign in through a {draft.provider === 'chatgpt' ? 'Codex' : 'Claude Code'} pane in the same environment. Deck does not switch to API billing if your subscription is unavailable.</p>
      </>}
      <h3>Your daily rhythm</h3><label>Time zone<input value={draft.timeZone} onChange={e => patch({ timeZone: e.target.value })} placeholder="America/New_York" /></label><div className="personal-schedule">{(['morning', 'checkIn', 'evening'] as const).map(key => <label key={key}>{key === 'morning' ? 'Morning plan' : key === 'checkIn' ? 'Refocus' : 'Evening review'}<input type="time" required value={draft[key]} onChange={e => patch({ [key]: e.target.value })} /></label>)}</div>
      <label className="personal-check"><input type="checkbox" checked={draft.proactive} onChange={e => patch({ proactive: e.target.checked })} />Proactive daily check-ins</label><label className="personal-check"><input type="checkbox" checked={draft.nudges} disabled={!draft.proactive} onChange={e => patch({ nudges: e.target.checked })} />Nudges for meetings, waiting agents and due tasks</label><label className="personal-check"><input type="checkbox" checked={draft.weekdaysOnly} onChange={e => patch({ weekdaysOnly: e.target.checked })} />Check in on weekdays only</label><label className="personal-check"><input type="checkbox" checked={draft.notifications} onChange={e => patch({ notifications: e.target.checked })} />Desktop notifications for check-ins and focus timers</label><p className="personal-muted">Keep Deck running for check-ins. Missed check-ins catch up within 90 minutes; overnight check-ins wait until the next day. Focus timers never mark tasks complete.</p>
      <div className="personal-inline"><button className="btn primary" disabled={busy}>Save agent settings</button><button type="button" className="btn ghost" disabled={busy} onClick={() => { setBusy(true); setNote(''); void onSave({ onboarded: false }).then(ok => { if (ok) onClose(); else setNote('Could not restart setup. Close this dialog for details.') }).finally(() => setBusy(false)) }}>Run setup again</button></div>
    </form>
    <div className="personal-form">{draft.provider === 'openrouter' && <><h3>Agent key</h3><OpenRouterKey /></>}<h3>Gmail & Google Calendar</h3>{google.connected ? <><p>Connected as <strong>{google.account}</strong>.</p><div className="personal-inline"><button className="btn subtle" disabled={busy} onClick={() => void googleAction(() => api.personal.google.connect())}>Reconnect</button><button className="btn ghost" disabled={busy} onClick={() => void googleAction(() => api.personal.google.disconnect())}>Disconnect Google</button></div></> : <><p className="personal-muted">Create a <strong>Desktop app</strong> OAuth client in Google Cloud, enable Gmail and Google Calendar APIs, and add your account as a test user while the consent screen is in testing.</p><button className="btn ghost" onClick={() => api.openExternal('https://console.cloud.google.com/auth/clients')}>Open Google Cloud setup</button><details className="personal-details" open={!google.configured}><summary>Desktop OAuth client</summary><label>Client ID<input value={clientId} autoComplete="off" onChange={e => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" /></label><label>Client secret<input type="password" autoComplete="off" value={clientSecret} onChange={e => setClientSecret(e.target.value)} /></label><button className="btn subtle" disabled={busy || !clientId.trim()} onClick={() => void googleAction(() => api.personal.google.configure({ clientId, clientSecret }))}>Save Google client</button></details><button className="btn primary" disabled={busy || !google.configured || google.connecting} onClick={() => void googleAction(() => api.personal.google.connect())}>{google.connecting ? 'Complete sign-in in your browser…' : 'Connect Gmail & Calendar'}</button></>}
      <p className="personal-muted">Google tokens stay encrypted on this machine. All email and calendar changes require your review. Calendar management covers the primary calendar and individual events; guests are notified of approved updates.</p>{google.error && <p role="alert" className="oc-note bad">{google.error}</p>}
      {google.connecting && <button className="btn subtle" onClick={() => void onGoogle(() => api.personal.google.cancelConnect())}>Cancel sign-in</button>}
    </div>
    {note && <p role="status">{note}</p>}
  </div></Modal>
}
