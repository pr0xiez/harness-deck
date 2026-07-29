import { beforeEach, describe, expect, it } from 'vitest'
import type { PaneStatus } from '@shared/types'
import { harness } from './test/harness'
import { activeWorkspace, isLive, useDeck, type DeckWorkspace, type PaneView } from './store'

/**
 * The store reads `window.harness` while it is being imported, so the import at
 * the top of this file is itself part of what is under test: without the stub
 * the setup file installs, none of these tests would get as far as running.
 */

const pane = (id: string, status: PaneStatus): PaneView => ({
  id,
  profileId: 'claude',
  command: 'claude',
  args: [],
  cwd: '/repos/deck',
  status,
  epoch: 0
})

const workspace = (id: string, panes: PaneView[] = []): DeckWorkspace => ({
  id,
  name: id,
  cwd: `/repos/${id}`,
  accent: '#7aa2f7',
  panes,
  activePaneId: panes[0]?.id ?? null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null
})

beforeEach(() => {
  // The store is a module singleton, so one test's deck would otherwise still
  // be on screen for the next.
  useDeck.setState({ workspaces: [], activeWorkspaceId: null, repos: {} })
})

describe('isLive', () => {
  it('counts a pane that has fallen quiet at a prompt, not only one still talking', () => {
    expect(isLive(pane('a', 'running'))).toBe(true)
    expect(isLive(pane('a', 'waiting'))).toBe(true)
  })

  it('does not count a pane with no process on the end of it', () => {
    expect(isLive(pane('a', 'idle'))).toBe(false)
    expect(isLive(pane('a', 'exited'))).toBe(false)
  })
})

describe('activeWorkspace', () => {
  it('picks the one the deck is pointed at, not the first on the list', () => {
    useDeck.setState({
      workspaces: [workspace('one'), workspace('two'), workspace('three')],
      activeWorkspaceId: 'two'
    })

    expect(activeWorkspace(useDeck.getState())?.id).toBe('two')
  })

  it('has no answer for a deck that is pointed at nothing', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: null })

    expect(activeWorkspace(useDeck.getState())).toBeUndefined()
  })

  /** The gap between closing a workspace and the id being repointed. */
  it('has no answer for an id no workspace carries any more', () => {
    useDeck.setState({ workspaces: [workspace('one')], activeWorkspaceId: 'closed' })

    expect(activeWorkspace(useDeck.getState())).toBeUndefined()
  })
})

/** The bridge is stubbed, so this is where the stub earns its keep. */
describe('refreshRepo', () => {
  it('files what git said under the folder that was asked about', async () => {
    const repo = { root: '/repos/deck', branch: 'main', dirty: 2 }
    harness.git.info.mockResolvedValue(repo)

    await useDeck.getState().refreshRepo('/repos/deck/src')

    expect(harness.git.info).toHaveBeenCalledWith('/repos/deck/src')
    expect(useDeck.getState().repos).toEqual({ '/repos/deck/src': repo })
  })

  it('does not ask git about a pane that has no folder', async () => {
    await useDeck.getState().refreshRepo('')

    expect(harness.git.info).not.toHaveBeenCalled()
    expect(useDeck.getState().repos).toEqual({})
  })
})
