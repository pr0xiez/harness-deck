import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpencodePaneDialog } from './OpencodePaneDialog'
import { useDeck, type DeckWorkspace, type PaneView } from '../store'
import type { Profile } from '@shared/types'
import { harness } from '../test/harness'

const OPENCODE: Profile = {
  id: 'agent:opencode',
  name: 'OpenCode',
  command: '/usr/local/bin/opencode',
  args: [],
  kind: 'agent',
  icon: 'OC',
  accent: '#f59e0b',
  available: true
}

const WSL_OPENCODE: Profile = {
  ...OPENCODE,
  id: 'wsl:opencode',
  name: 'OpenCode (WSL)',
  command: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-e', 'bash', '-lic', 'cd "$HD_CWD" 2>/dev/null; exec opencode']
}

const workspace = (panes: PaneView[] = []): DeckWorkspace => ({
  id: 'ws_1',
  name: 'Deck',
  cwd: '/repo',
  accent: '#94a3b8',
  panes,
  activePaneId: null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null
})

/** The pane the dialog made, if it made one. */
const made = (): PaneView | undefined =>
  useDeck.getState().workspaces[0].panes.find((p) => p.profileId.startsWith('agent:') || p.profileId.startsWith('wsl:'))

const INFO = {
  models: ['anthropic/claude-sonnet-4', 'opencode/big-pickle'],
  agents: ['build', 'plan'],
  sessions: [
    { id: 'ses_1', title: 'Fix the lint', updated: Date.now() - 60_000, directory: '/repo' },
    { id: 'ses_2', title: 'Older work', updated: Date.now() - 7_200_000 }
  ]
}

describe('OpencodePaneDialog', () => {
  beforeEach(() => {
    useDeck.setState({ profiles: [OPENCODE], workspaces: [workspace()], repos: {}, info: null })
    localStorage.clear()
    harness.opencode.query.mockResolvedValue(INFO)
  })

  it('offers what the CLI named, and launches with it', async () => {
    const user = userEvent.setup()
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />)

    // The model list arrives from the CLI…
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /Model/i }) as HTMLInputElement).disabled).toBe(
        false
      )
    )
    expect(harness.opencode.query).toHaveBeenCalledWith('agent:opencode', '/repo')

    await user.type(screen.getByRole('combobox', { name: /Model/i }), 'anthropic/claude-sonnet-4')
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    const pane = made()!
    expect(pane.command).toBe('/usr/local/bin/opencode')
    expect(pane.args).toEqual(['--model', 'anthropic/claude-sonnet-4'])
  })

  it('resumes a picked session and names the pane for it', async () => {
    const user = userEvent.setup()
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Pick one…' }))
    await user.click(await screen.findByRole('option', { name: /Fix the lint/ }))
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    const pane = made()!
    expect(pane.args).toEqual(['--session', 'ses_1'])
    expect(pane.name).toBe('OpenCode · resumed')
  })

  it('carries a prompt and auto-approval, and remembers them for next time', async () => {
    const user = userEvent.setup()
    const view = render(
      <OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />
    )

    await user.type(await screen.findByRole('textbox', { name: /Opening prompt/i }), 'fix the lint')
    await user.click(screen.getByRole('switch', { name: /Auto-approve/i }))
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    expect(made()!.args).toEqual(['--auto', '--prompt', 'fix the lint'])
    expect(JSON.parse(localStorage.getItem('hd.opencode.launch:agent:opencode')!)).toMatchObject({
      prompt: 'fix the lint',
      auto: true
    })

    // Reopened, the dialog starts where the last launch left off.
    view.unmount()
    useDeck.setState({ workspaces: [workspace()] })
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />)
    const prompt = (await screen.findByRole('textbox', {
      name: /Opening prompt/i
    })) as HTMLTextAreaElement
    expect(prompt.value).toBe('fix the lint')
  })

  it('continues the last session, forking it on request', async () => {
    const user = userEvent.setup()
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Last session' }))
    await user.click(screen.getByRole('switch', { name: /Fork it/i }))
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    expect(made()!.args).toEqual(['--continue', '--fork'])
  })

  it('speaks the WSL launcher’s grammar', async () => {
    const user = userEvent.setup()
    useDeck.setState({ profiles: [WSL_OPENCODE] })
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="wsl:opencode" onClose={vi.fn()} />)

    await user.type(await screen.findByRole('combobox', { name: /Model/i }), 'anthropic/claude-sonnet-4')
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    const pane = made()!
    expect(pane.command).toBe('C:\\Windows\\System32\\wsl.exe')
    expect(pane.args).toEqual([
      '-e',
      'bash',
      '-lic',
      'cd "$HD_CWD" 2>/dev/null; exec opencode --model anthropic/claude-sonnet-4'
    ])
  })

  it('launches anyway when the CLI would not answer', async () => {
    const user = userEvent.setup()
    harness.opencode.query.mockResolvedValue({
      models: [],
      agents: [],
      sessions: [],
      error: 'opencode did not answer — the fields below are free text'
    })
    render(<OpencodePaneDialog workspaceId="ws_1" profileId="agent:opencode" onClose={vi.fn()} />)

    expect((await screen.findByText(/did not answer/)).textContent).toMatch(/did not answer/)
    await user.type(screen.getByRole('combobox', { name: /Model/i }), 'opencode/big-pickle')
    await user.click(screen.getByRole('button', { name: 'Open pane' }))

    expect(made()!.args).toEqual(['--model', 'opencode/big-pickle'])
  })
})
