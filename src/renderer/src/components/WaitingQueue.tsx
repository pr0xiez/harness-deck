import { useEffect, useMemo, useRef, useState } from 'react'
import { paneLabel } from '../paneLabel'
import { isSnoozed, useDeck, type DeckWorkspace, type PaneView } from '../store'
import { getTerminal } from '../terminals'
import { Icon } from './Icon'

const api = window.harness

/**
 * How much of the pane we show. For an agent sitting at an approval gate the
 * tail *is* the question, and three lines is where "what is it asking?" stops
 * and "go and read it" starts.
 */
const TAIL_LINES = 3

/** The clock in each row counts up, so the overlay re-renders while it is open. */
const TICK_MS = 1000

interface Row {
  pane: PaneView
  workspace: DeckWorkspace
}

/**
 * Which panes the queue lists — looser than `isActionable` in exactly one way:
 * a pane you acknowledged stays on the list, dimmed, because "I have seen it"
 * is not "hide it from me". Muted panes never appear, and a snoozed one leaves
 * until its snooze lapses or its bell wakes it.
 */
const inQueue = (pane: PaneView, now: number): boolean =>
  pane.status === 'waiting' && !pane.attentionMuted && !isSnoozed(pane, now)

/** "just now", then seconds, then minutes, then hours — never a date. */
function since(from: number | undefined, now: number): string {
  if (!from) return 'waiting'
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** What the snooze button says it will do next, in the order the key cycles. */
function snoozeLabel(pane: PaneView): string {
  if (pane.snooze === undefined) return 'Snooze until it next goes quiet'
  if (pane.snooze === 'quiet') return 'Snooze for an hour instead'
  return 'Stop snoozing this pane'
}

/**
 * Every pane waiting for you, across every workspace, oldest first — the
 * question attention routing could not answer on its own. Each row carries the
 * last lines the pane produced, because that is the cheapest honest answer to
 * "why is it waiting": no classifier, no provider events, nothing that rots
 * when a CLI changes its wording.
 *
 * Bespoke rather than a `Modal`: this thing's whole interface is single
 * unmodified keys — A, S, M, Enter — and the shared dialog would swallow them.
 */
export function WaitingQueue(): React.JSX.Element {
  const workspaces = useDeck((s) => s.workspaces)
  const profiles = useDeck((s) => s.profiles)
  const setUi = useDeck((s) => s.setUi)
  const toggleAcknowledged = useDeck((s) => s.toggleAcknowledged)
  const cycleSnooze = useDeck((s) => s.cycleSnooze)
  const toggleMuted = useDeck((s) => s.toggleMuted)
  const frameRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [tails, setTails] = useState<Record<string, string[]>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // The keys are the point of the overlay, so it takes focus off the terminal
  // the moment it opens and keeps it (see `hold` below).
  useEffect(() => frameRef.current?.focus(), [])

  const rows = useMemo(() => {
    const here = new Map<string, Row>()
    for (const workspace of workspaces) {
      for (const pane of workspace.panes) {
        if (inQueue(pane, Date.now())) here.set(pane.id, { pane, workspace })
      }
    }
    // Frozen order: a list that reshuffles under your finger cannot be
    // operated. Panes already on it hold their place however long they have
    // been waiting, newcomers go on the end, and only the initial order — the
    // one you see when it opens — is oldest first.
    const kept = orderRef.current.filter((id) => here.has(id))
    const added = [...here.keys()]
      .filter((id) => !kept.includes(id))
      .sort((a, b) => (here.get(a)!.pane.waitingSince ?? 0) - (here.get(b)!.pane.waitingSince ?? 0))
    orderRef.current = [...kept, ...added]
    return orderRef.current.map((id) => here.get(id)!)
  }, [workspaces])

  // A tail is only re-read when a pane joins the list or stops again: a waiting
  // pane is by definition producing nothing, so re-asking on the clock would be
  // an IPC round trip per second for an answer that cannot have changed.
  const keys = rows.map((row) => `${row.pane.id}@${row.pane.waitingSince ?? 0}`).join(' ')
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      rows.map(
        async (row) =>
          [
            `${row.pane.id}@${row.pane.waitingSince ?? 0}`,
            await api.pty.tail(row.pane.id, TAIL_LINES)
          ] as const
      )
    ).then((entries) => {
      if (!cancelled) setTails(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const close = (): void => setUi({ waitingQueue: false })
  /** Buttons steal focus, and the next key press has to reach the list. */
  const hold = (): void => frameRef.current?.focus()

  const jump = (row: Row): void => {
    const state = useDeck.getState()
    const ws = state.workspaces.find((w) => w.id === row.workspace.id)
    if (!ws) return
    if (ws.id !== state.activeWorkspaceId) state.setActiveWorkspace(ws.id)
    // Zoom is a mode rather than a pin, so a jump out of a zoomed pane lands
    // zoomed on the pane you asked for instead of quietly hiding it.
    if (ws.zoomedPaneId && ws.zoomedPaneId !== row.pane.id) state.toggleZoom(ws.id, row.pane.id)
    else state.setActivePane(ws.id, row.pane.id)
    close()
    getTerminal(row.pane.id)?.term.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const row = rows[at]
    const act = (run: () => void): void => {
      event.preventDefault()
      if (row) run()
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        return close()
      case 'ArrowDown':
        event.preventDefault()
        return setCursor(Math.max(0, Math.min(at + 1, rows.length - 1)))
      case 'ArrowUp':
        event.preventDefault()
        return setCursor(Math.max(0, at - 1))
      case 'Enter':
        return act(() => jump(row))
      default:
    }
    switch (event.key.toLowerCase()) {
      case 'a':
        return act(() => toggleAcknowledged(row.pane.id))
      case 's':
        return act(() => cycleSnooze(row.pane.id))
      case 'm':
        return act(() => toggleMuted(row.pane.id))
      default:
    }
  }

  return (
    <div className="scrim queue-scrim" onMouseDown={close}>
      <div
        className="queue"
        ref={frameRef}
        tabIndex={-1}
        role="listbox"
        aria-label="Panes waiting for you"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="queue-head">
          <Icon name="bell" />
          <span className="queue-title">Waiting for you</span>
          <span className="queue-count">{rows.length}</span>
          <span className="queue-legend">
            <b>Enter</b> jump · <b>A</b> acknowledge · <b>S</b> snooze · <b>M</b> mute ·{' '}
            <b>Esc</b> close
          </span>
        </div>

        <div className="queue-list">
          {rows.map((row, index) => {
            const { pane, workspace } = row
            const profile = profiles.find((p) => p.id === pane.profileId)
            const tail = tails[`${pane.id}@${pane.waitingSince ?? 0}`]
            return (
              <div
                key={pane.id}
                role="option"
                aria-selected={index === at}
                className={`queue-row ${index === at ? 'on' : ''} ${
                  pane.acknowledged ? 'is-acknowledged' : ''
                } ${pane.woke ? 'is-woke' : ''}`}
                style={{ ['--ws-accent' as string]: workspace.accent }}
                onMouseEnter={() => setCursor(index)}
                onClick={() => jump(row)}
              >
                <span className="queue-swatch" title={workspace.name} />
                <span className="queue-badge" title={profile?.name}>
                  {profile?.icon ?? '»'}
                </span>
                <span className="queue-name">
                  {paneLabel(pane, profile)}
                  <span className="queue-ws">{workspace.name}</span>
                </span>
                {/* The bell outranked a snooze to put this row back — say so,
                    or the row looks like it never left. */}
                {pane.woke ? <span className="queue-flag">rang</span> : null}
                {pane.acknowledged ? <span className="queue-flag seen">seen</span> : null}
                <span className="queue-age">{since(pane.waitingSince, now)}</span>

                <pre className="queue-tail">
                  {tail === undefined ? '…' : tail.length ? tail.join('\n') : 'no output yet'}
                </pre>

                <span className="queue-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    className={`btn tiny ghost ${pane.acknowledged ? 'on' : ''}`}
                    title="Acknowledge (A) — keeps the row, drops it from the counts until it stops again"
                    onClick={() => {
                      toggleAcknowledged(pane.id)
                      hold()
                    }}
                  >
                    {pane.acknowledged ? 'Unsee' : 'Ack'}
                  </button>
                  <button
                    className="btn tiny ghost"
                    title={`Snooze (S) — ${snoozeLabel(pane)}`}
                    onClick={() => {
                      cycleSnooze(pane.id)
                      hold()
                    }}
                  >
                    Snooze
                  </button>
                  <button
                    className="btn tiny ghost"
                    title="Mute (M) — this pane never counts again, until you unmute it"
                    onClick={() => {
                      toggleMuted(pane.id)
                      hold()
                    }}
                  >
                    Mute
                  </button>
                </span>
              </div>
            )
          })}

          {!rows.length ? (
            <div className="queue-none">
              Nothing is waiting for you. Panes you muted or snoozed are not counted here.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
