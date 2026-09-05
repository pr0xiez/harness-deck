import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Profile } from '@shared/types'
import { DEFAULT_SETTINGS, useDeck, type DeckWorkspace } from '../store'
import { harness } from '../test/harness'
import { ProfileMenu } from './ProfileMenu'

const CLAUDE: Profile = {
  id: 'agent:claude',
  name: 'Claude Code',
  command: 'claude',
  args: [],
  kind: 'agent',
  icon: 'CC',
  accent: '#d97757',
  available: true,
  detail: '/usr/local/bin/claude'
}

const SHELL: Profile = {
  id: 'shell:default',
  name: 'Shell',
  command: 'bash',
  args: [],
  kind: 'shell',
  icon: '$',
  accent: '#94a3b8',
  available: true
}

const WORKSPACE: DeckWorkspace = {
  id: 'ws_1',
  name: 'Deck',
  cwd: '/repo',
  accent: '#7aa2f7',
  panes: [],
  activePaneId: null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null
}

describe('ProfileMenu favorites', () => {
  beforeEach(() => {
    harness.git.info.mockResolvedValue(null)
    useDeck.setState({
      profiles: [CLAUDE, SHELL],
      workspaces: [WORKSPACE],
      repos: {},
      settings: DEFAULT_SETTINGS
    })
  })

  afterEach(() => {
    useDeck.setState({ profiles: [], workspaces: [], settings: DEFAULT_SETTINGS })
  })

  it('adds a profile to a section at the top and can remove it again', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<ProfileMenu workspaceId="ws_1" onClose={onClose} />)

    expect(screen.queryByText('Favorites')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Add Claude Code to favorites' }))

    expect(container.querySelector('.menu-label')?.textContent).toBe('Favorites')
    expect(screen.getAllByText('Claude Code')).toHaveLength(2)
    expect(useDeck.getState().settings.favoriteProfileIds).toEqual(['agent:claude'])
    expect(useDeck.getState().workspaces[0].panes).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()

    await user.click(
      screen.getAllByRole('button', { name: 'Remove Claude Code from favorites' })[0]
    )

    expect(screen.queryByText('Favorites')).toBeNull()
    expect(screen.getAllByText('Claude Code')).toHaveLength(1)
    expect(useDeck.getState().settings.favoriteProfileIds).toEqual([])
  })
})
