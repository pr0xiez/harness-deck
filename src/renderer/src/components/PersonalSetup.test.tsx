import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { emptyPersonalData, type PersonalCommand, type PersonalSnapshot } from '@shared/personal-agent'
import { harness } from '../test/harness'
import { useDeck } from '../store'
import { PersonalAgentPage } from './PersonalAgentPage'
let snapshot: PersonalSnapshot
const settingsPatch = (patch: object): [PersonalCommand, number] => [{ operation: 'settings', patch: expect.objectContaining(patch) }, 1]
beforeEach(() => {
  snapshot = { data: emptyPersonalData('America/New_York'), busy: false, google: { configured: false, connected: false, connecting: false, mail: [], events: [] } }
  snapshot.data.settings.provider = 'openrouter'; snapshot.data.revision = 1
  harness.personal.snapshot.mockResolvedValue(snapshot)
  harness.personal.mutate.mockResolvedValue(snapshot)
  harness.personal.chat.mockResolvedValue(snapshot)
  harness.personal.subscriptionStatus.mockResolvedValue({ available: true, signedIn: true, environment: 'wsl', message: 'Subscription sign-in found (WSL).' })
  harness.work.snapshot.mockResolvedValue({ ok: true, board: { version: 1, revision: 0, items: [] } })
  harness.clipboard.write.mockResolvedValue(true)
  useDeck.setState({ workspaces: [] })
})
async function chooseChatGpt(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /ChatGPT subscription/ }))
  await screen.findByText('Subscription sign-in found (WSL).')
}

it('shows setup instead of the page for a new agent and walks all three steps', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  expect(await screen.findByRole('heading', { name: 'How should it think?' })).toBeTruthy()
  expect(screen.queryByText('Today’s focus')).toBeNull()
  expect(screen.getByText('STEP 1 OF 3')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  await chooseChatGpt(user)
  expect(harness.personal.subscriptionStatus).toHaveBeenCalledWith('chatgpt', 'auto')
  expect(harness.personal.mutate).toHaveBeenCalledWith({ operation: 'settings', patch: { provider: 'chatgpt', cliEnvironment: 'wsl', subscriptionModel: '' } }, 1)
  await user.click(screen.getByRole('button', { name: 'Continue' }))

  expect(screen.getByRole('heading', { name: 'Your rhythm' })).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: 'Daily check-ins' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: 'Nudges for meetings, waiting agents and due tasks' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.change(screen.getByLabelText('Check-in'), { target: { value: '12:15' } })
  await user.click(screen.getByRole('checkbox', { name: 'Weekdays only' }))
  await user.click(screen.getByRole('button', { name: 'Save & continue' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'settings', patch: { timeZone: 'America/New_York', morning: '08:30', checkIn: '12:15', evening: '17:30', weekdaysOnly: false, proactive: true, nudges: true, notifications: true } }, 1)

  expect(screen.getByRole('heading', { name: 'What are you working toward?' })).toBeTruthy()
  await user.type(screen.getByLabelText('Your goals'), 'Ship the beta')
  await user.click(screen.getByRole('button', { name: 'Finish' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'settings', patch: { onboarded: true, context: 'Ship the beta' } }, 1)
  expect(harness.personal.chat).not.toHaveBeenCalled()
})
it('validates check-in order inline before saving the rhythm', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await chooseChatGpt(user)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  fireEvent.change(screen.getByLabelText('Morning plan'), { target: { value: '14:00' } })
  expect(screen.getByRole('alert').textContent).toMatch(/Keep the times in order/)
  expect((screen.getByRole('button', { name: 'Save & continue' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Mars/Olympus' } })
  expect(screen.getByRole('alert').textContent).toMatch(/time zone/)
  expect(harness.personal.mutate).toHaveBeenCalledTimes(1)
})
it('shows the login command when the subscription CLI is not signed in', async () => {
  const user = userEvent.setup()
  harness.personal.subscriptionStatus.mockResolvedValue({ available: true, signedIn: false, message: 'Claude Code is installed but not signed in.' })
  render(<PersonalAgentPage />)
  await user.click(await screen.findByRole('button', { name: /Claude subscription/ }))
  expect(await screen.findByText('Claude Code is installed but not signed in.')).toBeTruthy()
  expect(screen.getByText('claude auth login')).toBeTruthy()
  expect(harness.personal.mutate).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Copy' }))
  expect(harness.clipboard.write).toHaveBeenCalledWith('claude auth login')
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  harness.personal.subscriptionStatus.mockResolvedValue({ available: true, signedIn: true, environment: 'native', message: 'Subscription sign-in found.' })
  await user.click(screen.getByRole('button', { name: 'Check again' }))
  await screen.findByText('Subscription sign-in found.')
  expect(harness.personal.subscriptionStatus).toHaveBeenLastCalledWith('claude', 'auto')
  expect(harness.personal.mutate).toHaveBeenCalledWith(...settingsPatch({ provider: 'claude', cliEnvironment: 'native' }))
  expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false)
})
it('opens Agent settings for OpenRouter credits', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await user.click(await screen.findByRole('button', { name: 'Advanced: OpenRouter credits' }))
  expect(screen.getByRole('dialog', { name: 'Your personal agent' })).toBeTruthy()
})
it('skips setup from any step', async () => {
  const user = userEvent.setup()
  render(<PersonalAgentPage />)
  await chooseChatGpt(user)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await user.click(screen.getByRole('button', { name: 'Skip setup' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'settings', patch: { onboarded: true } }, 1)
})
it('finishes, appends goals to saved context, and plans the day', async () => {
  const user = userEvent.setup()
  snapshot.data.settings.context = 'Existing goals'; snapshot.data.settings.provider = 'chatgpt'
  const done = structuredClone(snapshot); done.data.revision = 2; done.data.settings.onboarded = true; done.data.settings.provider = 'chatgpt'
  harness.personal.mutate.mockImplementation(async command => command.operation === 'settings' && command.patch.onboarded ? done : snapshot)
  render(<PersonalAgentPage />)
  await chooseChatGpt(user)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  await user.click(screen.getByRole('button', { name: 'Save & continue' }))
  await user.type(screen.getByLabelText('Your goals'), 'Protect mornings')
  await user.click(screen.getByRole('button', { name: 'Finish & plan my day' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'settings', patch: { onboarded: true, context: 'Existing goals\n\nProtect mornings' } }, 1)
  expect(harness.personal.chat).toHaveBeenCalledWith('Help me plan today.')
  expect(await screen.findByText('Today’s focus')).toBeTruthy()
})
it('keeps existing agents on the page and can run setup again from settings', async () => {
  const user = userEvent.setup()
  snapshot.data.settings.onboarded = true; snapshot.data.settings.proactive = true
  render(<PersonalAgentPage />)
  await screen.findByText('Today’s focus')
  await user.click(screen.getByRole('button', { name: 'Agent settings' }))
  const nudges = screen.getByRole('checkbox', { name: 'Nudges for meetings, waiting agents and due tasks' }) as HTMLInputElement
  expect(nudges.checked).toBe(true)
  await user.click(nudges)
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith(...settingsPatch({ nudges: false, proactive: true }))
  await user.click(screen.getByRole('button', { name: 'Run setup again' }))
  expect(harness.personal.mutate).toHaveBeenLastCalledWith({ operation: 'settings', patch: { onboarded: false } }, 1)
  expect(screen.queryByRole('dialog')).toBeNull()
})
