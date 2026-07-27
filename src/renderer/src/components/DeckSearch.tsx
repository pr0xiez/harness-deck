import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDeck, type DeckWorkspace } from '../store'
import { getTerminal } from '../terminals'
import { scanPanes } from '../search'
import { Icon } from './Icon'

/** A scan walks every pane's whole scrollback, so it must not run per keystroke. */
const SCAN_MS = 150

interface Props {
  workspace: DeckWorkspace
}

/** Where the last jump landed: the pane, and which of its matches. */
interface Cursor {
  paneId: string
  index: number
}

/**
 * Find across every pane in the workspace. `PaneSearch` answers "where in this
 * terminal"; this one answers "which of these six terminals", which is the
 * question you only have because there are six.
 */
export function DeckSearch({ workspace }: Props): React.JSX.Element {
  const profiles = useDeck((s) => s.profiles)
  const setUi = useDeck((s) => s.setUi)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [at, setAt] = useState<Cursor | null>(null)

  const needle = query.trim()
  // The pane set as a value that only changes when a pane opens or closes —
  // `workspace.panes` is a fresh array every time a status flickers.
  const paneKey = workspace.panes.map((pane) => pane.id).join(' ')

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    if (!needle) {
      setCounts(null)
      setAt(null)
      return
    }
    const timer = window.setTimeout(() => {
      setCounts(scanPanes(paneKey ? paneKey.split(' ') : [], needle))
      setAt(null)
    }, SCAN_MS)
    return () => window.clearTimeout(timer)
  }, [needle, paneKey])

  const hits = useMemo(() => {
    if (!counts) return []
    return workspace.panes
      .map((pane) => ({ pane, count: counts[pane.id] ?? 0 }))
      .filter((hit) => hit.count > 0)
  }, [counts, workspace.panes])

  const jump = useCallback(
    (paneId: string, index: number, forward: boolean): void => {
      const state = useDeck.getState()
      const ws = state.workspaces.find((w) => w.id === workspace.id)
      if (!ws) return
      // Zoom is a mode rather than a pin, so a jump out of a zoomed pane lands
      // zoomed on whichever pane matched instead of quietly hiding the match.
      if (ws.zoomedPaneId && ws.zoomedPaneId !== paneId) state.toggleZoom(ws.id, paneId)
      else state.setActivePane(ws.id, paneId)

      const handle = getTerminal(paneId)
      if (!handle) return
      // Arriving in a pane starts from one end of its buffer; walking within one
      // carries on from the selection the previous find left behind.
      if (at?.paneId !== paneId) handle.term.clearSelection()
      if (forward) handle.search.findNext(needle)
      else handle.search.findPrevious(needle)
      setAt({ paneId, index })
    },
    [workspace.id, needle, at]
  )

  /** Walks matches within a pane, then on to the next pane that has any. */
  const step = (delta: 1 | -1): void => {
    if (!hits.length) return
    const enter = (index: number): void => {
      const entry = hits[(index + hits.length) % hits.length]
      jump(entry.pane.id, delta > 0 ? 0 : entry.count - 1, delta > 0)
    }
    const here = at ? hits.findIndex((hit) => hit.pane.id === at.paneId) : -1
    // Nothing walked yet, or the pane we were in has stopped matching: start
    // from whichever end of the workspace the direction implies.
    if (!at || here < 0) return enter(delta > 0 ? 0 : hits.length - 1)
    const next = at.index + delta
    if (next >= 0 && next < hits[here].count) jump(hits[here].pane.id, next, delta > 0)
    else enter(here + delta)
  }

  // The pane we land on focuses its own terminal on the next frame (see the
  // visibility effect in TerminalPane). The box has to take focus back, or the
  // Enter that walks to the next match is typed into the agent instead.
  useEffect(() => {
    if (!at) return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => inputRef.current?.focus())
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [at])

  const close = (): void => {
    setUi({ findAll: false })
    const ws = useDeck.getState().workspaces.find((w) => w.id === workspace.id)
    if (ws?.activePaneId) getTerminal(ws.activePaneId)?.term.focus()
  }

  const total = hits.reduce((sum, hit) => sum + hit.count, 0)
  const missing = Boolean(needle) && counts !== null && !hits.length
  const summary = !needle
    ? `${workspace.panes.length} pane${workspace.panes.length === 1 ? '' : 's'}`
    : counts === null
      ? '…'
      : missing
        ? 'no matches'
        : `${total} in ${hits.length} pane${hits.length === 1 ? '' : 's'}`

  return (
    <div className="deck-search">
      <div className="deck-search-row">
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          placeholder={`Find in every pane of ${workspace.name}`}
          className={missing ? 'not-found' : ''}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              step(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              close()
            }
          }}
        />
        <span className="deck-search-count">{summary}</span>
        <button className="icon-btn" title="Previous match (Shift+Enter)" onClick={() => step(-1)}>
          <Icon name="chevronUp" />
        </button>
        <button className="icon-btn" title="Next match (Enter)" onClick={() => step(1)}>
          <Icon name="chevronDown" />
        </button>
        <button className="icon-btn" title="Close (Esc)" onClick={close}>
          <Icon name="close" />
        </button>
      </div>

      {hits.length ? (
        <div className="deck-search-hits">
          {hits.map(({ pane, count }) => {
            const profile = profiles.find((p) => p.id === pane.profileId)
            const label = pane.name || pane.processTitle || profile?.name || pane.command
            return (
              <button
                key={pane.id}
                className={`target-chip ${at?.paneId === pane.id ? 'on' : ''}`}
                style={{ ['--badge' as string]: profile?.accent ?? workspace.accent }}
                title={`Jump to the first match in ${label}`}
                onClick={() => jump(pane.id, 0, true)}
              >
                {profile?.icon ?? '»'} {label} <b>{count}</b>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
