import { useEffect } from 'react'
import { MAX_DECK_SIGNAL_ITEMS, type DeckSignals } from '@shared/personal-agent'
import type { GitHubSnapshot } from '@shared/github'
import type { Profile } from '@shared/types'
import { isActionable, useDeck, type DeckWorkspace } from './store'
import { githubItems, needsGitHubAttention, useGitHub } from './github'
import { paneLabel } from './paneLabel'

type Marks = Parameters<typeof needsGitHubAttention>[1]
const MAX_SIGNALS_PER_ITEM = 5
const DEBOUNCE_MS = 2000
const HEARTBEAT_MS = 60_000

const clip = (value: string, max: number): string => value.trim().slice(0, max).trim()

/**
 * What the personal agent may know about the deck: which agents are waiting
 * and which pull requests need you. Status only — never terminal output,
 * transcripts or anything a process printed beyond its own title. Clamped to
 * the bounds main validates, so one long title never drops the whole report.
 */
export function deckSignals(
  deck: { workspaces: DeckWorkspace[]; profiles: Pick<Profile, 'id' | 'name'>[] },
  github: { enabled: boolean; snapshots: Record<string, GitHubSnapshot>; marks: Marks },
  now: number
): DeckSignals {
  const waitingAgents = deck.workspaces
    .flatMap((ws) => ws.panes.filter((pane) => isActionable(pane, now)).map((pane) => ({
      paneId: pane.id,
      label: clip(paneLabel(pane, deck.profiles.find((p) => p.id === pane.profileId)) || '', 200) || 'Agent',
      workspace: clip(ws.name, 200),
      waitingSince: pane.waitingSince ?? now
    })))
    .filter((agent) => agent.paneId.length <= 200 && agent.paneId.trim())
    // Oldest first: if anything is cut, it is the freshest stop.
    .sort((a, b) => a.waitingSince - b.waitingSince)
    .slice(0, MAX_DECK_SIGNAL_ITEMS)
  const attention = github.enabled
    ? githubItems(github.snapshots).filter((item) => needsGitHubAttention(item, github.marks, now)).map((item) => ({
      id: item.id,
      repository: clip(item.repository, 200),
      number: item.number,
      title: clip(item.title, 300),
      signals: item.signals.map((s) => clip(s.label, 100)).filter(Boolean).slice(0, MAX_SIGNALS_PER_ITEM)
    })).filter((item) => item.id.length <= 300 && item.id.trim() && item.repository &&
      Number.isSafeInteger(item.number) && item.number > 0)
    : []
  return { waitingAgents, github: attention.slice(0, MAX_DECK_SIGNAL_ITEMS), reportedAt: now }
}

const current = (now: number): DeckSignals => {
  const deck = useDeck.getState()
  return deckSignals(deck, useGitHub.getState(), now)
}

/**
 * Reports deck signals to main: coalesced to at most one report per ~2 s of
 * changes, skipping payloads identical to the last one sent, plus a heartbeat
 * so main can tell a quiet deck from a stale report. Errors are swallowed —
 * the agent simply sees older signals.
 */
export function startDeckSignalsReporter(
  report: (signals: DeckSignals) => Promise<void> = (signals) => window.harness.personal.reportSignals(signals)
): () => void {
  let last = ''
  let timer: number | undefined
  const send = (force: boolean): void => {
    window.clearTimeout(timer); timer = undefined
    const signals = current(Date.now())
    const key = JSON.stringify({ ...signals, reportedAt: 0 })
    if (!force && key === last) return
    last = key
    try { void report(signals).catch(() => undefined) } catch { /* Reporting is best effort. */ }
  }
  // Not a sliding debounce: a pane whose title spins every second would starve it.
  const schedule = (): void => { if (timer === undefined) timer = window.setTimeout(() => send(false), DEBOUNCE_MS) }
  const offDeck = useDeck.subscribe(schedule)
  const offGitHub = useGitHub.subscribe(schedule)
  const heartbeat = window.setInterval(() => send(true), HEARTBEAT_MS)
  schedule()
  return () => { offDeck(); offGitHub(); window.clearTimeout(timer); window.clearInterval(heartbeat) }
}

export function useDeckSignalsReporter(): void {
  useEffect(() => startDeckSignalsReporter(), [])
}
