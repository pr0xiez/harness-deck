import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OpenRouterPaneDialog } from './OpenRouterPaneDialog'
import { DEFAULT_SETTINGS, serialize, useDeck } from '../store'
import { templateFromWorkspace, workspaceFromTemplate } from '../templates'
import { harness } from '../test/harness'
import type { Profile } from '@shared/types'

const profile: Profile = { id: 'agent:codex', name: 'Codex CLI', command: 'codex', args: [],
  kind: 'agent', icon: 'CX', accent: '#10a37f', available: true }
const workspace = { id: 'w', name: 'Project', cwd: '/repo', accent: '#10a37f', panes: [],
  activePaneId: null, layout: 'grid' as const, columns: 2, zoomedPaneId: null }
beforeEach(() => {
  localStorage.clear()
  useDeck.setState({ profiles: [profile], workspaces: [workspace], settings: DEFAULT_SETTINGS })
  harness.openRouter.keyState.mockResolvedValue({ hasKey: false, source: 'none' })
  harness.openRouter.models.mockResolvedValue({ models: ['openai/test-model', 'anthropic/test-model'] })
})

describe('provider pane options', () => {
  it('keeps the existing configuration as the initial choice', async () => {
    render(<OpenRouterPaneDialog workspaceId="w" profileId={profile.id} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open pane' }))
    expect(useDeck.getState().workspaces[0].panes[0]).toMatchObject({ command: 'codex', args: [] })
    expect(useDeck.getState().workspaces[0].panes[0].openRouter).toBeUndefined()
  })
  it('remembers routing, persists only the model, and carries it into templates', async () => {
    const user = userEvent.setup()
    const view = render(<OpenRouterPaneDialog workspaceId="w" profileId={profile.id} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'openrouter')
    await user.click(screen.getByRole('button', { name: 'Load available models' }))
    await user.type(screen.getByRole('combobox', { name: /^Model/ }), 'openai/test-model')
    await user.click(screen.getByRole('button', { name: 'Open pane' }))
    const state = useDeck.getState()
    expect(serialize(state).workspaces[0].panes[0]).toMatchObject({
      args: [], openRouter: { model: 'openai/test-model' }
    })
    expect(state.workspaces[0].panes[0].env).toBeUndefined()
    const template = templateFromWorkspace(state.workspaces[0], 'Agents', 't', '')
    expect(workspaceFromTemplate(template, '/new-repo', () => 'new').panes[0].openRouter)
      .toEqual({ model: 'openai/test-model' })
    view.unmount()
    render(<OpenRouterPaneDialog workspaceId="w" profileId={profile.id} onClose={vi.fn()} />)
    expect((screen.getByRole('combobox', { name: /^Model/ }) as HTMLInputElement).value).toBe('openai/test-model')
  })
  it('rejects incomplete model IDs before creating a pane', async () => {
    const user = userEvent.setup()
    render(<OpenRouterPaneDialog workspaceId="w" profileId={profile.id} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'openrouter')
    await user.type(screen.getByRole('combobox', { name: /^Model/ }), 'missing-prefix')
    await user.click(screen.getByRole('button', { name: 'Open pane' }))
    expect(screen.getByRole('alert').textContent).toContain('provider prefix')
    expect(useDeck.getState().workspaces[0].panes).toHaveLength(0)
  })
  it('sends saved keys only to main and clears the password field', async () => {
    const user = userEvent.setup()
    harness.openRouter.setKey.mockResolvedValue({ hasKey: true, source: 'stored', encrypted: true })
    render(<OpenRouterPaneDialog workspaceId="w" profileId={profile.id} onClose={vi.fn()} />)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Provider' }), 'openrouter')
    const key = screen.getByLabelText(/^OpenRouter API key/)
    await user.type(key, 'dummy-key')
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    expect(harness.openRouter.setKey).toHaveBeenCalledWith('dummy-key')
    expect((key as HTMLInputElement).value).toBe('')
    expect(JSON.stringify(serialize(useDeck.getState()))).not.toContain('dummy-key')
    expect(localStorage.getItem(`hd.router.launch:${profile.id}`)).toBeNull()
  })
})
