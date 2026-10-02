import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyPersonalData, localClock, type PersonalSnapshot } from '@shared/personal-agent'
import { harness } from '../test/harness'
import { useDeck } from '../store'
import { PersonalStatusChip } from './PersonalStatusChip'

const TZ = 'America/New_York'
let snapshot: PersonalSnapshot
const today = (): string => localClock(new Date(), TZ).day
const flush = (): Promise<void> => act(async () => {})
const emit = (value: PersonalSnapshot): void => act(() => (harness.personal.onChanged.mock.calls.at(-1)![0] as (s: PersonalSnapshot) => void)(value))
const chip = (): HTMLElement | null => screen.queryByRole('button', { name: /^Personal agent/ })
beforeEach(() => {
  snapshot = { data: emptyPersonalData(TZ), busy: false, google: { configured: false, connected: false, connecting: false, mail: [], events: [] } }
  snapshot.data.settings.onboarded = true; snapshot.data.revision = 1
  const createdAt = new Date().toISOString()
  snapshot.data.tasks.push({ id: 'one', title: 'Finish release', notes: '', due: '', done: false, createdAt },
    { id: 'two', title: 'Old chore', notes: '', due: '', done: true, createdAt })
  harness.personal.snapshot.mockResolvedValue(snapshot)
  harness.work.snapshot.mockResolvedValue({ ok: true, board: { version: 1, revision: 0, items: [] } })
  useDeck.getState().setUi({ page: 'deck' })
})
afterEach(() => { vi.useRealTimers() })

it('stays hidden until the snapshot loads', async () => {
  harness.personal.snapshot.mockReturnValue(new Promise(() => {}))
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()).toBeNull()
})
it('stays hidden until setup is finished', async () => {
  snapshot.data.settings.onboarded = false
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()).toBeNull()
  const done = structuredClone(snapshot); done.data.revision = 2; done.data.settings.onboarded = true
  emit(done)
  expect(chip()?.textContent).toBe('Plan your day')
})
it('invites planning and opens the personal page', async () => {
  const user = userEvent.setup()
  render(<PersonalStatusChip />)
  await flush()
  expect(screen.getByRole('button', { name: 'Personal agent: Plan your day' })).toBeTruthy()
  await user.click(chip()!)
  expect(useDeck.getState().ui.page).toBe('personal')
})
it('shows the next unfinished priority from today’s plan', async () => {
  snapshot.data.plans.push({ day: today(), intention: '', priorities: [{ source: 'personal', id: 'two' }, { source: 'personal', id: 'one' }] })
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()?.textContent).toBe('Next: Finish release')
  expect(harness.work.snapshot).not.toHaveBeenCalled()
})
it('resolves work-board priorities from the board', async () => {
  snapshot.data.plans.push({ day: today(), intention: '', priorities: [{ source: 'board', id: 'card' }] })
  harness.work.snapshot.mockResolvedValue({ ok: true, board: { version: 1, revision: 3, items: [{ id: 'card', title: 'Review the PR', description: '', status: 'in_progress', workspaceId: null, revision: 1, createdAt: '', updatedAt: '' }] } })
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()?.textContent).toBe('Next: Review the PR')
})
it('ignores a plan from another day', async () => {
  snapshot.data.plans.push({ day: '2000-01-01', intention: '', priorities: [{ source: 'personal', id: 'one' }] })
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()?.textContent).toBe('Plan your day')
})
it('counts down a running focus block every second', async () => {
  vi.useFakeTimers({ now: Date.parse('2026-10-02T15:00:00Z') })
  snapshot.data.focus = { source: 'personal', id: 'one', title: 'Finish release', startedAt: Date.now(), endsAt: Date.now() + 5 * 60_000, reminded: false }
  render(<PersonalStatusChip />)
  await flush()
  expect(chip()?.textContent).toBe('05:00 · Finish release')
  expect(chip()?.className).toContain('focusing')
  act(() => { vi.advanceTimersByTime(1000) })
  expect(chip()?.textContent).toBe('04:59 · Finish release')
  act(() => { vi.advanceTimersByTime(5 * 60_000) })
  expect(chip()?.textContent).toBe('Check in · Finish release')
})
it('badges pending Google proposals', async () => {
  const action = { operation: 'gmail_send' as const, title: 'Reply', account: 'me@example.com', args: {}, createdAt: new Date().toISOString() }
  snapshot.data.actions.push({ ...action, id: 'a', status: 'pending' }, { ...action, id: 'b', status: 'pending' }, { ...action, id: 'c', status: 'done' })
  render(<PersonalStatusChip />)
  await flush()
  expect(screen.getByRole('button', { name: 'Personal agent: Plan your day. 2 Google proposals to review' })).toBeTruthy()
  expect(chip()?.querySelector('.count')?.textContent).toBe('2')
})
it('follows newer snapshots, ignores older ones, and unsubscribes on unmount', async () => {
  const { unmount } = render(<PersonalStatusChip />)
  await flush()
  const planned = structuredClone(snapshot); planned.data.revision = 3
  planned.data.plans.push({ day: today(), intention: '', priorities: [{ source: 'personal', id: 'one' }] })
  emit(planned)
  expect(chip()?.textContent).toBe('Next: Finish release')
  emit(snapshot)
  expect(chip()?.textContent).toBe('Next: Finish release')
  const off = harness.personal.onChanged.mock.results.at(-1)!.value as () => void
  unmount()
  expect(off).toHaveBeenCalledOnce()
})
