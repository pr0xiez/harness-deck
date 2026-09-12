import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceTemplate } from '@shared/types'
import { DEFAULT_SETTINGS, useDeck, type DeckWorkspace, type PaneView } from '../store'
import {
  activePaneCommands,
  buildCommands,
  templateCommands,
  workspaceCommands
} from './commands'

/**
 * The palette's builders, taken one group at a time — which is the point of
 * their existing as functions: what the list holds for a given deck can now be
 * asked directly, without rendering the palette and searching it.
 */

const pane = (id: string, over: Partial<PaneView> = {}): PaneView => ({
  id,
  profileId: 'claude',
  command: 'claude',
  args: [],
  cwd: '/repos/deck',
  status: 'idle',
  epoch: 0,
  ...over
})

const workspace = (
  id: string,
  panes: PaneView[] = [],
  over: Partial<DeckWorkspace> = {}
): DeckWorkspace => ({
  id,
  name: id,
  cwd: `/repos/${id}`,
  accent: '#7aa2f7',
  panes,
  activePaneId: panes[0]?.id ?? null,
  layout: 'grid',
  columns: 2,
  zoomedPaneId: null,
  ...over
})

const template = (id: string, name: string): WorkspaceTemplate => ({
  id,
  name,
  accent: '#7aa2f7',
  layout: 'grid',
  columns: 2,
  panes: [],
  createdAt: '2026-01-01T00:00:00.000Z'
})

const deck = (): ReturnType<typeof useDeck.getState> => useDeck.getState()

beforeEach(() => {
  // The store is a module singleton, so one test's deck would otherwise still
  // be on screen for the next.
  useDeck.setState({
    workspaces: [],
    activeWorkspaceId: null,
    templates: [],
    profiles: [],
    mounted: [],
    settings: DEFAULT_SETTINGS
  })
})

describe('workspaceCommands', () => {
  it('offers every workspace by name, then the two ways of starting fresh', () => {
    useDeck.setState({ workspaces: [workspace('one'), workspace('two')] })

    const list = workspaceCommands(deck())

    expect(list.map((c) => c.id)).toEqual(['ws:one', 'ws:two', 'ws:new', 'ws:new-folder'])
    expect(list[0].label).toBe('Switch to one')
    // The first nine carry the shortcut that already switches to them.
    expect(list[0].hint).toBe('Ctrl+1')
    expect(list[1].hint).toBe('Ctrl+2')
  })

  it('switches the deck when a workspace entry runs', () => {
    useDeck.setState({ workspaces: [workspace('one'), workspace('two')], activeWorkspaceId: 'one' })

    workspaceCommands(deck())
      .find((c) => c.id === 'ws:two')!
      .run()

    expect(deck().activeWorkspaceId).toBe('two')
  })
})

describe('templateCommands', () => {
  it('stays out of the list entirely until a template has been saved', () => {
    expect(templateCommands(deck())).toEqual([])
  })

  it('offers the picker plus a named entry per template', () => {
    useDeck.setState({ templates: [template('t1', 'agent trio')] })

    const list = templateCommands(deck())

    expect(list.map((c) => c.id)).toEqual(['ws:new-template', 'ws:template:t1'])
    expect(list[1].label).toBe('New workspace from “agent trio”…')
  })
})

describe('activePaneCommands', () => {
  const ws = (over: Partial<PaneView> = {}): [DeckWorkspace, PaneView] => {
    const active = pane('a', over)
    return [workspace('one', [active]), active]
  }

  it('holds the settled set of pane verbs, in their settled order', () => {
    expect(activePaneCommands(deck(), ...ws()).map((c) => c.id)).toEqual([
      'pane:edit',
      'pane:restart',
      'pane:new-session',
      'pane:read-only',
      'pane:mute-attention',
      'pane:auto-restart',
      'pane:kill',
      'pane:copy-transcript',
      'pane:send-selection',
      'pane:copy-transcript-raw',
      'pane:save-transcript',
      'pane:save-transcript-raw',
      'pane:zoom',
      'pane:close'
    ])
  })

  it('offers new sessions only for supported interactive agents', () => {
    expect(activePaneCommands(deck(), ...ws({ command: 'bash' })).map((c) => c.id))
      .not.toContain('pane:new-session')
    expect(activePaneCommands(deck(), ...ws()).find((c) => c.id === 'pane:restart')?.label)
      .toBe('Restart and resume session')
  })

  /** The workspace's own tree is the user's; only worktree panes get shipped. */
  it('offers shipping only for a worktree pane', () => {
    expect(activePaneCommands(deck(), ...ws()).map((c) => c.id)).not.toContain('pane:ship')
    expect(
      activePaneCommands(deck(), ...ws({ worktree: '/repos/one/.wt/a' })).map((c) => c.id)
    ).toContain('pane:ship')
  })

  it('flips the read-only label to say what running it would do next', () => {
    const label = (over: Partial<PaneView>): string =>
      activePaneCommands(deck(), ...ws(over)).find((c) => c.id === 'pane:read-only')!.label

    expect(label({})).toBe('Lock this pane read-only')
    expect(label({ readOnly: true })).toBe('Let this pane take input again')
  })
})

describe('buildCommands', () => {
  it('keeps workspace-bound groups off the list when no workspace is active', () => {
    const groups = new Set(buildCommands(deck()).map((c) => c.group))

    expect(groups.has('Workspaces')).toBe(true)
    expect(groups.has('Application')).toBe(true)
    expect(groups.has('Workspace')).toBe(false)
    expect(groups.has('Panes')).toBe(false)
    expect(groups.has('Active pane')).toBe(false)
  })

  it('composes the groups in their settled order for a full deck', () => {
    const active = pane('a')
    useDeck.setState({
      workspaces: [workspace('one', [active])],
      activeWorkspaceId: 'one',
      templates: [template('t1', 'agent trio')]
    })

    const groups = [...new Set(buildCommands(deck()).map((c) => c.group))]

    expect(groups).toEqual([
      'Workspaces',
      'Templates',
      'Workspace',
      'Panes',
      'GitHub',
      'Active pane',
      'Application'
    ])
  })
})
