import { useEffect, useState } from 'react'
import { localClock, personalModelConfigured, type PersonalData, type Priority } from '@shared/personal-agent'
import type { WorkBoard } from '@shared/work-board'
import { useDeck } from '../store'
import { usePersonal, usePersonalFeed } from '../personal'
import { Icon } from './Icon'

const api = window.harness
const clock = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Board titles only matter when today's plan points at a card; load the board only then. */
function useBoard(needed: boolean): WorkBoard | null {
  const [board, setBoard] = useState<WorkBoard | null>(null)
  useEffect(() => {
    if (!needed) { setBoard(null); return }
    let live = true
    const off = api.work.onChanged(value => { if (live) setBoard(old => !old || value.revision >= old.revision ? value : old) })
    void api.work.snapshot().then(value => {
      if (live && value?.ok) setBoard(old => !old || value.board.revision >= old.revision ? value.board : old)
    }).catch(() => undefined)
    return () => { live = false; off() }
  }, [needed])
  return board
}

interface ChipState { label: string; detail: string; focusing: boolean }

function chipState(data: PersonalData, board: WorkBoard | null, now: number): ChipState {
  const focus = data.focus
  if (focus && now < focus.endsAt) return { label: `${clock(focus.endsAt - now)} · ${focus.title}`, detail: `Focus: ${focus.title}, ${clock(focus.endsAt - now)} left`, focusing: true }
  if (focus) return { label: `Check in · ${focus.title}`, detail: `Focus block finished: ${focus.title}. What did you finish?`, focusing: false }
  const day = localClock(new Date(now), data.settings.timeZone).day
  const plan = data.plans.find(p => p.day === day)
  if (plan && plan.priorities.length) {
    const resolve = (p: Priority): { title: string; done: boolean } | null | undefined => {
      if (p.source === 'personal') {
        const task = data.tasks.find(t => t.id === p.id)
        return task ? { title: task.title, done: task.done } : null
      }
      if (!board) return undefined // Still loading: say something true but vague.
      const card = board.items.find(c => c.id === p.id)
      return card ? { title: card.title, done: card.status === 'done' || card.status === 'wont_do' } : null
    }
    for (const p of plan.priorities) {
      const item = resolve(p)
      if (item === undefined) return { label: 'Next: work board card', detail: 'Next priority: a work board card', focusing: false }
      if (item && !item.done) return { label: `Next: ${item.title}`, detail: `Next priority: ${item.title}`, focusing: false }
    }
    return { label: 'Today’s plan is done', detail: 'Every priority in today’s plan is done', focusing: false }
  }
  if (!personalModelConfigured(data.settings)) return { label: 'Finish agent setup', detail: 'Choose how your personal agent thinks', focusing: false }
  return { label: 'Plan your day', detail: 'Choose up to three priorities for today', focusing: false }
}

/** The personal agent at a glance: focus countdown, next priority, or a nudge to plan. */
export function PersonalStatusChip(): React.JSX.Element | null {
  usePersonalFeed()
  const snapshot = usePersonal(s => s.snapshot)
  const setUi = useDeck(s => s.setUi)
  const [now, setNow] = useState(Date.now())
  const data = snapshot?.data
  const focusing = !!data?.focus && now < data.focus.endsAt
  const day = data ? localClock(new Date(now), data.settings.timeZone).day : ''
  const needsBoard = !!data && !focusing && !!data.plans.find(p => p.day === day)?.priorities.some(p => p.source === 'board')
  const board = useBoard(needsBoard)
  // A second-by-second tick only while a countdown is on screen; otherwise once
  // a minute, enough to notice the day turning over.
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), focusing ? 1000 : 60_000)
    return () => window.clearInterval(timer)
  }, [focusing, data?.focus?.endsAt])
  if (!data || !data.settings.onboarded) return null
  const state = chipState(data, board, now)
  const pending = data.actions.filter(a => a.status === 'pending').length
  const review = pending ? `${pending} Google ${pending === 1 ? 'proposal' : 'proposals'} to review` : ''
  return (
    <button
      className={`ghost-btn personal-chip${state.focusing ? ' focusing' : ''}`}
      aria-label={`Personal agent: ${state.label}${review ? `. ${review}` : ''}`}
      title={`Personal agent — ${state.detail}${review ? `\n${review}` : ''}`}
      onClick={() => setUi({ page: 'personal' })}
    >
      <Icon name="star" size={13} />
      <span className="personal-chip-label">{state.label}</span>
      {pending ? <span className="count personal-chip-count" aria-hidden="true">{pending}</span> : null}
    </button>
  )
}
