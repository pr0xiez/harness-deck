import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { emptyPersonalData, type PersonalSnapshot } from '@shared/personal-agent'
import { harness } from '../test/harness'
import { useDeck } from '../store'
import { PersonalAgentPage } from './PersonalAgentPage'
let snapshot: PersonalSnapshot
beforeEach(() => {
  snapshot = { data: emptyPersonalData('America/New_York'), busy: false, google: { configured: false, connected: false, connecting: false, mail: [], events: [] } }
  snapshot.data.settings.model = 'provider/model'; snapshot.data.revision = 1
  snapshot.data.tasks.push({ id: 'one', title: 'Finish release', notes: 'One next step', due: '', done: false, createdAt: new Date().toISOString() })
  harness.personal.snapshot.mockResolvedValue(snapshot)
  harness.personal.mutate.mockResolvedValue(snapshot)
  harness.personal.chat.mockResolvedValue(snapshot)
  harness.work.snapshot.mockResolvedValue({ ok: true, board: { version: 1, revision: 0, items: [] } })
  useDeck.setState({ workspaces: [] })
})
it('uses the latest persisted revision when selecting priorities and starting focus', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await user.click(await screen.findByRole('checkbox', { name: 'Prioritize Finish release' }))
  expect(harness.personal.mutate).toHaveBeenCalledWith({ operation: 'plan', intention: '', priorities: [{ source: 'personal', id: 'one' }] }, 1)
  const updated = structuredClone(snapshot); updated.data.revision = 2; updated.data.plans = [{ day: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), intention: 'Ship it', priorities: [{ source: 'personal', id: 'one' }] }]
  act(() => harness.personal.onChanged.mock.calls.at(-1)![0](updated))
  await user.click(screen.getByRole('button', { name: 'Focus' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'focus_start', priority: { source: 'personal', id: 'one' }, minutes: 25 }, 2)
})
it('shows the exact email for review and only approves after a click', async () => {
  const user = userEvent.setup()
  snapshot.data.actions.push({ id: 'proposal', operation: 'gmail_send', account: 'owner@example.com', title: 'Send a reply', status: 'pending', args: { to: 'friend@example.com', subject: 'Next steps', body: 'Here is the plan.' }, createdAt: new Date().toISOString() })
  harness.personal.approve.mockResolvedValue(snapshot)
  render(<PersonalAgentPage />)
  await screen.findByText('Here is the plan.')
  expect(harness.personal.approve).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Approve & send email' }))
  expect(harness.personal.approve).toHaveBeenCalledWith('proposal')
})
it('keeps task drafts and disables saves after a concurrent agent edit', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await user.click(await screen.findByRole('button', { name: 'Finish release' }))
  const field = screen.getByLabelText('What needs to get done?')
  await user.clear(field); await user.type(field, 'My draft')
  const updated = structuredClone(snapshot); updated.data.revision++; updated.data.tasks[0].title = 'Agent edit'
  act(() => harness.personal.onChanged.mock.calls.at(-1)![0](updated))
  expect((field as HTMLInputElement).value).toBe('My draft')
  expect((screen.getByRole('button', { name: 'Save task' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Reload current task' }))
  expect((field as HTMLInputElement).value).toBe('Agent edit')
})
it('shows saved conversation updates and lets the user stop an active reply', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await screen.findByText('Finish release')
  const updated = structuredClone(snapshot); updated.busy = true; updated.data.revision++
  updated.data.messages.push({ id: 'm', role: 'assistant', text: 'Choose one small next step.', at: new Date().toISOString(), kind: 'checkIn' })
  act(() => harness.personal.onChanged.mock.calls.at(-1)![0](updated))
  expect(within(screen.getByRole('log')).getByText('Choose one small next step.')).toBeTruthy()
  harness.personal.stop.mockResolvedValue({ ...updated, busy: false })
  await user.click(screen.getByRole('button', { name: 'Stop reply' }))
  expect(harness.personal.stop).toHaveBeenCalledOnce()
})
it('does not enable proactivity or Google access during onboarding', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await user.click(screen.getByRole('button', { name: 'Agent settings' }))
  expect((screen.getByRole('checkbox', { name: 'Proactive daily check-ins' }) as HTMLInputElement).checked).toBe(false)
  expect(harness.personal.google.connect).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Connect Gmail & Calendar' }) as HTMLButtonElement).disabled).toBe(true)
})
