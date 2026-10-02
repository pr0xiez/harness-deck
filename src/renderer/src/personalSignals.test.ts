import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DECK_SIGNAL_ITEMS, validDeckSignals, type DeckSignals } from '@shared/personal-agent'
import type { GitHubItem } from '@shared/github'
import { useDeck, type DeckWorkspace, type PaneView } from './store'
import { useGitHub } from './github'
import { deckSignals, startDeckSignalsReporter } from './personalSignals'

const NOW = Date.parse('2026-10-02T15:00:00Z')
const pane = (id: string, patch: Partial<PaneView> = {}): PaneView =>
  ({ id, profileId: 'agent:codex', command: 'codex', args: [], cwd: '/repo', status: 'waiting', epoch: 0, waitingSince: NOW - 60_000, ...patch })
const workspace = (name: string, panes: PaneView[]): DeckWorkspace =>
  ({ id: name, name, cwd: '/repo', accent: '#fff', panes, activePaneId: null, layout: 'grid', columns: 2, zoomedPaneId: null })
const item = (id: string, patch: Partial<GitHubItem> = {}): GitHubItem => ({
  id, repository: 'acme/app', number: 7, title: 'Fix the build', url: 'https://github.com/acme/app/pull/7', revision: 'r1',
  signals: [{ kind: 'review', label: 'Review requested', url: 'https://github.com/acme/app/pull/7', revision: 'r1' }], ...patch
})
const github = (items: GitHubItem[], marks: Record<string, { revision: string; acknowledged?: boolean; snoozedUntil?: number }> = {}, enabled = true) =>
  ({ enabled, snapshots: { '/repo': { items, checkedAt: NOW } }, marks })

beforeEach(() => { useDeck.setState({ profiles: [] }) })

describe('deckSignals', () => {
  it('reports only actionable agent panes, labelled like the rest of the deck', () => {
    const signals = deckSignals({ profiles: [{ id: 'agent:codex', name: 'Codex' }], workspaces: [workspace('Web', [
      pane('named', { name: 'Reviewer' }),
      pane('titled', { processTitle: 'codex: fixing tests' }),
      pane('plain'),
      pane('seen', { acknowledged: true }),
      pane('muted', { attentionMuted: true }),
      pane('snoozed', { snooze: NOW + 60_000 }),
      pane('busy', { status: 'running' }),
      pane('shell', { command: 'bash', profileId: 'shell:bash' })
    ])] }, github([]), NOW)
    expect(signals.waitingAgents).toEqual([
      { paneId: 'named', label: 'Reviewer', workspace: 'Web', waitingSince: NOW - 60_000 },
      { paneId: 'titled', label: 'codex: fixing tests', workspace: 'Web', waitingSince: NOW - 60_000 },
      { paneId: 'plain', label: 'Codex', workspace: 'Web', waitingSince: NOW - 60_000 }
    ])
    expect(signals.reportedAt).toBe(NOW)
    expect(JSON.stringify(signals)).not.toMatch(/transcript|scrollback/)
  })
  it('reports GitHub items that still need attention, by signal label', () => {
    const signals = deckSignals({ profiles: [], workspaces: [] }, github([item('new'), item('seen'), item('changed', { revision: 'r2' })], {
      seen: { revision: 'r1', acknowledged: true }, changed: { revision: 'r1', acknowledged: true }
    }), NOW)
    expect(signals.github.map(g => g.id)).toEqual(['new', 'changed'])
    expect(signals.github[0]).toEqual({ id: 'new', repository: 'acme/app', number: 7, title: 'Fix the build', signals: ['Review requested'] })
    expect(deckSignals({ profiles: [], workspaces: [] }, github([item('new')], {}, false), NOW).github).toEqual([])
  })
  it('clamps text to the bounds main validates', () => {
    const long = 'x'.repeat(400)
    const signals = deckSignals({ profiles: [], workspaces: [workspace(long, [pane('a', { name: long }), pane('b', { name: '   ' , processTitle: '  ' })])] },
      github([item('pr', { title: long, repository: long, signals: Array.from({ length: 7 }, (_, i) => ({ kind: 'checks' as const, label: i ? long : '  ', url: '', revision: String(i) })) })]), NOW)
    expect(signals.waitingAgents[0].label).toHaveLength(200)
    expect(signals.waitingAgents[0].workspace).toHaveLength(200)
    expect(signals.waitingAgents[1].label).toBe('Agent')
    expect(signals.github[0].title).toHaveLength(300)
    expect(signals.github[0].repository).toHaveLength(200)
    expect(signals.github[0].signals).toHaveLength(5)
    expect(signals.github[0].signals.every(s => s.length === 100)).toBe(true)
    expect(validDeckSignals(signals)).toBe(true)
  })
  it('caps each list, keeping the longest-waiting agents', () => {
    const panes = Array.from({ length: 25 }, (_, i) => pane(`p${i}`, { waitingSince: NOW - i * 1000 }))
    const items = Array.from({ length: 25 }, (_, i) => item(`i${i}`, { number: i + 1 }))
    const signals = deckSignals({ profiles: [], workspaces: [workspace('W', panes)] }, github(items), NOW)
    expect(signals.waitingAgents).toHaveLength(MAX_DECK_SIGNAL_ITEMS)
    expect(signals.waitingAgents[0].paneId).toBe('p24')
    expect(signals.waitingAgents.map(a => a.paneId)).not.toContain('p0')
    expect(signals.github).toHaveLength(MAX_DECK_SIGNAL_ITEMS)
    expect(validDeckSignals(signals)).toBe(true)
  })
})

describe('startDeckSignalsReporter', () => {
  afterEach(() => { vi.useRealTimers() })
  it('debounces changes, skips identical payloads, and keeps a heartbeat', () => {
    vi.useFakeTimers({ now: NOW })
    useGitHub.setState({ enabled: true, snapshots: {}, marks: {} })
    useDeck.setState({ workspaces: [workspace('Web', [pane('a', { status: 'running' })])] })
    const report = vi.fn(async (_signals: DeckSignals) => {})
    const off = startDeckSignalsReporter(report)
    try {
      vi.advanceTimersByTime(1999)
      expect(report).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0][0].waitingAgents).toEqual([])

      // A store change that does not alter the signals is not news.
      useDeck.getState().setUi({ palette: true })
      vi.advanceTimersByTime(2000)
      expect(report).toHaveBeenCalledTimes(1)

      // Several changes inside one window become one report.
      useDeck.getState().updatePane('a', { status: 'waiting', waitingSince: NOW })
      useDeck.getState().updatePane('a', { name: 'Builder' })
      vi.advanceTimersByTime(2000)
      expect(report).toHaveBeenCalledTimes(2)
      expect(report.mock.calls[1][0].waitingAgents).toEqual([{ paneId: 'a', label: 'Builder', workspace: 'Web', waitingSince: NOW }])

      vi.advanceTimersByTime(60_000 - 4000)
      expect(report).toHaveBeenCalledTimes(3)
      expect(report.mock.calls[2][0].waitingAgents).toEqual(report.mock.calls[1][0].waitingAgents)
      expect(report.mock.calls[2][0].reportedAt).toBeGreaterThan(report.mock.calls[1][0].reportedAt)
    } finally { off() }
    useDeck.getState().updatePane('a', { name: 'Later' })
    vi.advanceTimersByTime(120_000)
    expect(report).toHaveBeenCalledTimes(3)
  })
  it('swallows reporting failures', async () => {
    vi.useFakeTimers({ now: NOW })
    useDeck.setState({ workspaces: [] })
    const report = vi.fn(async () => { throw Error('main is gone') })
    const off = startDeckSignalsReporter(report)
    try {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      expect(report).toHaveBeenCalledOnce()
    } finally { off() }
  })
})
