import { useCallback, useEffect, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import type { Profile } from '@shared/types'
import { paneLabel } from '../paneLabel'
import { useDeck, type PaneView } from '../store'
import { RESTART_CAP } from '../restart'
import { PaneSearch } from './PaneSearch'
import { Icon } from './Icon'
import { useXtermInstance } from './terminalPane/useXtermInstance'
import { usePtyAttach } from './terminalPane/usePtyAttach'
import { useAutoRestart } from './terminalPane/useAutoRestart'
import { useLiveTerminalSettings } from './terminalPane/useLiveTerminalSettings'
import { useVisibilityRefit } from './terminalPane/useVisibilityRefit'

const api = window.harness

interface Props {
  pane: PaneView
  workspaceId: string
  profile?: Profile
  accent: string
  active: boolean
  visible: boolean
  index: number
  paneCount: number
}

/**
 * What the lock promises, in the one sentence the user gets to read. Anything
 * that reads the pane — scrolling, selecting, copying, the transcript — is
 * untouched; the lock is about bytes reaching the process.
 */
const LOCK_HINT = 'Read-only: typing, paste, broadcast and dictation are refused'

/**
 * The other half of the mute promise: the pane keeps its own amber dot, because
 * what this pane is doing is never something the app should misreport. Muting is
 * about the counts that speak for every pane at once.
 */
const MUTE_HINT = 'Never count this pane as waiting — no badge, sidebar count, notification or queue'

/**
 * One pane of the deck. Each lifecycle concern lives in its own hook under
 * ./terminalPane — the xterm instance, the pty spawn/reattach, the crash
 * auto-restart, settings sync, visibility refit — and this component composes
 * them and renders the chrome around the terminal.
 */
export function TerminalPane({
  pane,
  workspaceId,
  profile,
  accent,
  active,
  visible,
  index,
  paneCount
}: Props): React.JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const updatePane = useDeck((s) => s.updatePane)
  const setActivePane = useDeck((s) => s.setActivePane)
  const restartPane = useDeck((s) => s.restartPane)
  const closePane = useDeck((s) => s.closePane)
  const requestClosePane = useDeck((s) => s.requestClosePane)
  const toggleZoom = useDeck((s) => s.toggleZoom)
  const setUi = useDeck((s) => s.setUi)
  const zoomed = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId)?.zoomedPaneId === pane.id)

  const title = paneLabel(pane, profile) || 'terminal'
  const paneId = pane.id
  const autoRestart = Boolean(pane.autoRestart)
  const locked = Boolean(pane.readOnly)
  const muted = Boolean(pane.attentionMuted)

  const { hostRef, handleRef, spawnedRef } = useXtermInstance(paneId, pane.epoch, accent, locked)
  usePtyAttach(pane, active, handleRef, spawnedRef)
  const crashPlan = useAutoRestart(pane)
  useLiveTerminalSettings(handleRef, accent, locked)
  useVisibilityRefit(handleRef, visible, active)

  const focusPane = useCallback(() => {
    setActivePane(workspaceId, paneId)
    handleRef.current?.term.focus()
  }, [setActivePane, workspaceId, paneId, handleRef])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ paneId: string }>).detail
      if (detail.paneId === paneId) setSearchOpen(true)
    }
    window.addEventListener('deck:find', handler)
    return () => window.removeEventListener('deck:find', handler)
  }, [paneId])

  // The header button copies the readable form; the palette has the raw stream
  // and the save dialog for the cases where that is the wrong answer.
  const copyTranscript = useCallback(async (): Promise<void> => {
    api.clipboard.write(await api.pty.transcript(paneId, true))
    setCopied(true)
  }, [paneId])

  // The tick is the only acknowledgement — a clipboard write is otherwise
  // completely silent, and the user has no way to tell it happened.
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const statusLabel =
    pane.status === 'running'
      ? 'running'
      : pane.status === 'waiting'
        ? 'waiting for you — the process is alive but has gone quiet'
        : pane.status === 'exited'
          ? `exited ${pane.exitCode ?? ''}`.trim()
          : 'idle'

  // An agent produces output constantly, so "there was output" told you nothing
  // — waiting is the signal that replaces it. A shell is quiet by nature, and
  // there the old dot still earns its place.
  const showActivity =
    pane.activity && !active && pane.status !== 'waiting' && profile?.kind !== 'agent'

  return (
    <section
      className={`pane ${active ? 'is-active' : ''} ${pane.status} ${
        locked ? 'is-locked' : ''
      } ${visible ? '' : 'is-hidden'}`}
      style={{ ['--pane-accent' as string]: profile?.accent || accent }}
      onMouseDown={focusPane}
      data-pane-id={paneId}
    >
      <header className="pane-head">
        <span className="pane-badge" title={profile?.name}>
          {profile?.icon ?? '»'}
        </span>
        <span className="pane-title" title={`${pane.command} ${pane.args.join(' ')}`.trim()}>
          {title}
        </span>
        <span className={`pane-status ${pane.status}`} title={statusLabel} />
        {showActivity ? <span className="pane-dot" title="new output" /> : null}
        {/* Says so without being hovered: the point of the lock is knowing
            which pane not to type into before you have typed into it. */}
        {locked ? (
          <span className="pane-lock-chip" title={LOCK_HINT}>
            <Icon name="lock" size={9} />
            read-only
          </span>
        ) : null}
        <span className="pane-index">{index + 1}</span>
        <div className="pane-actions">
          <button
            className="icon-btn"
            title="Find in pane (Ctrl+Shift+F)"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Icon name="search" />
          </button>
          <button
            className="icon-btn"
            title={copied ? 'Transcript copied' : 'Copy transcript as plain text'}
            onClick={() => void copyTranscript()}
          >
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          <button
            className="icon-btn"
            title={zoomed ? 'Restore pane (Ctrl+Shift+Z)' : 'Zoom pane (Ctrl+Shift+Z)'}
            onClick={() => toggleZoom(workspaceId, paneId)}
          >
            <Icon name={zoomed ? 'minimize' : 'maximize'} />
          </button>
          {/* Worktree panes only. The workspace's own tree is the user's, and
              this app does not commit it. */}
          {pane.worktree ? (
            <button
              className="icon-btn"
              title="Ship this worktree — commit, push, open a PR"
              onClick={() => setUi({ shipFor: paneId })}
            >
              <Icon name="branch" />
            </button>
          ) : null}
          <button
            className={`icon-btn pane-lock-btn ${locked ? 'on' : ''}`}
            aria-pressed={locked}
            title={locked ? 'Let this pane take input again' : LOCK_HINT}
            onClick={() => updatePane(paneId, { readOnly: !locked })}
          >
            <Icon name="lock" />
          </button>
          <button
            className={`icon-btn pane-mute-btn ${muted ? 'on' : ''}`}
            aria-pressed={muted}
            title={muted ? 'Count this pane as waiting again' : MUTE_HINT}
            onClick={() => updatePane(paneId, { attentionMuted: !muted })}
          >
            <Icon name="broadcast" />
          </button>
          <button
            className="icon-btn"
            title="Edit pane — command, folder, environment"
            onClick={() => setUi({ paneDialogFor: paneId })}
          >
            <Icon name="pencil" />
          </button>
          <button
            className="icon-btn"
            title="Restart process (Ctrl+Shift+R)"
            onClick={() => restartPane(paneId)}
          >
            <Icon name="restart" />
          </button>
          <button
            className="icon-btn danger"
            title="Close pane (Ctrl+Shift+W)"
            onClick={() => void requestClosePane(workspaceId, paneId)}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className="pane-body">
        <div className="term-host" ref={hostRef} />
        {searchOpen ? (
          <PaneSearch
            onClose={() => {
              setSearchOpen(false)
              handleRef.current?.term.focus()
            }}
            onSearch={(query, forward) => {
              const search = handleRef.current?.search
              if (!search || !query) return false
              return forward ? search.findNext(query) : search.findPrevious(query)
            }}
          />
        ) : null}

        {!pane.autostart && pane.status === 'idle' ? (
          <div className="pane-overlay">
            <div className="overlay-card">
              <p className="overlay-title">{title}</p>
              <p className="overlay-sub">{`${pane.command} ${pane.args.join(' ')}`.trim()}</p>
              <button className="btn primary" onClick={() => updatePane(paneId, { autostart: true })}>
                Start
              </button>
            </div>
          </div>
        ) : null}

        {pane.status === 'exited' ? (
          <div className="pane-exit-bar">
            <span>
              Process exited{pane.exitCode != null ? ` (code ${pane.exitCode})` : ''}
              {crashPlan?.action === 'restart'
                ? ` — restarting, attempt ${crashPlan.attempt} of ${RESTART_CAP}`
                : crashPlan?.action === 'halt'
                  ? ` — auto-restart gave up after ${RESTART_CAP} attempts`
                  : ''}
            </span>
            <label
              className="mini-check"
              title="Start this pane again when its process dies with a non-zero code. A clean exit is you, and is left alone."
            >
              <input
                type="checkbox"
                checked={autoRestart}
                onChange={(event) => updatePane(paneId, { autoRestart: event.target.checked })}
              />
              auto-restart
            </label>
            <button className="btn tiny" onClick={() => restartPane(paneId)}>
              Restart
            </button>
            <button className="btn tiny ghost" onClick={() => closePane(workspaceId, paneId)}>
              Close
            </button>
          </div>
        ) : null}
      </div>

      {paneCount > 1 ? <div className="pane-glow" aria-hidden /> : null}
    </section>
  )
}
