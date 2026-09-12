import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { DEFAULT_SETTINGS, isActionable, startAttention, useDeck, type PaneView } from '../store'
import { useGitHub } from '../github'
import { harness } from '../test/harness'
import type { AgentActivityEvent, PtyQuietEvent } from '@shared/types'
const pane = (id: string, patch: Partial<PaneView> = {}): PaneView => ({ id, profileId: 'agent:codex', command: 'codex', args: [], cwd: '/repo', status: 'running', epoch: 0, ...patch })
function mount(panes: PaneView[], collapsed = false) {
  useGitHub.setState({ enabled: false, snapshots: {} })
  useDeck.setState({ settings: { ...DEFAULT_SETTINGS, sidebarCollapsed: collapsed }, workspaces: [{ id: 'w', name: 'Workspace', cwd: '/repo', accent: '#fff', panes, activePaneId: 'p', layout: 'grid', columns: 2, zoomedPaneId: null }] })
  return render(<Sidebar />)
}
afterEach(() => { cleanup(); vi.useRealTimers() })
it.each([false, true])('keeps four agents, two working and one attention count separate (collapsed=%s)', collapsed => {
  mount([pane('a', { agentActivity: 'working' }), pane('b', { agentActivity: 'working' }), pane('c', { agentActivity: 'ready' }), pane('d', { agentActivity: 'waiting', status: 'waiting' }), pane('shell', { command: 'bash', profileId: 'shell:ubuntu', status: 'waiting' })], collapsed)
  expect(screen.getByLabelText('4 agents').textContent).toBe('4')
  expect(screen.getByLabelText('2 agents working').textContent).toBe('2')
  expect(screen.getByTitle(/1 pane waiting for you/).textContent).toBe('1')
})
it('does not claim output is agent work when tracking is unavailable', () => {
  const { container } = mount([pane('a')])
  expect(screen.getByLabelText('1 agents with unknown activity')).toBeTruthy()
  expect(container.querySelector('.count.running')).toBeNull()
})
it('does not turn a live acknowledged agent into an exited workspace', () => {
  const { container } = mount([pane('a', { agentActivity: 'waiting', status: 'waiting', acknowledged: true }), pane('b', { status: 'exited' })])
  expect(screen.getByLabelText('2 agents')).toBeTruthy()
  expect(container.querySelector('.count.exited')).toBeNull()
})
it('refreshes attention on snooze expiry without terminal output', () => {
  vi.useFakeTimers()
  const { container } = mount([pane('p', { status: 'waiting', agentActivity: 'waiting', snooze: Date.now() + 1000 })])
  const off = startAttention()
  try {
    expect(container.querySelector('.count.waiting')).toBeNull()
    act(() => vi.advanceTimersByTime(1001))
    expect(container.querySelector('.count.waiting')?.textContent).toBe('1')
  } finally { off() }
})
it('uses hook events for Codex and ignores silence from Codex and shells', () => {
  mount([pane('a'), pane('shell', { command: 'bash', profileId: 'shell:ubuntu' })])
  const off = startAttention()
  const quiet = harness.pty.onQuiet.mock.calls.at(-1)![0] as (event: PtyQuietEvent) => void
  const activity = harness.pty.onAgentActivity.mock.calls.at(-1)![0] as (event: AgentActivityEvent) => void
  try {
    act(() => { quiet({ id: 'a', quiet: true }); quiet({ id: 'shell', quiet: true }) })
    expect(useDeck.getState().workspaces[0].panes.map(p => p.status)).toEqual(['running', 'running'])
    act(() => activity({ id: 'a', activity: 'waiting' }))
    expect(isActionable(useDeck.getState().workspaces[0].panes[0])).toBe(true)
    act(() => activity({ id: 'a', activity: 'working' }))
    expect(screen.getByLabelText('1 agents working')).toBeTruthy()
    act(() => { useDeck.getState().setPaneStatus('a', 'exited'); activity({ id: 'a', activity: 'waiting' }) })
    expect(useDeck.getState().workspaces[0].panes[0].status).toBe('exited')
  } finally { off() }
})
