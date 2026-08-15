import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { Profile } from '@shared/types'
import { useDeck, type PaneView } from '../store'
import { isReservedShortcut, shortcutLabel } from '../shortcuts'
import { decideRestart, RESTART_CAP, type RestartDecision } from '../restart'
import { registerTerminal, unregisterTerminal, type TerminalHandle } from '../terminals'
import { terminalTheme } from '../theme'
import { PaneSearch } from './PaneSearch'
import { Icon } from './Icon'

const api = window.harness

/**
 * Drawn above scrollback that came off disk. Without it a pane restored after a
 * quit reads as though the process below it produced that output — which is the
 * one thing a transcript must never be wrong about.
 */
const PREVIOUS_SESSION_RULE = '\x1b[2m— previous session —\x1b[0m\r\n'

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
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TerminalHandle | null>(null)
  const spawnedRef = useRef(false)
  // What the reset rule measures against. The mount rather than the spawn: the
  // two happen together for a pane that is starting, and a pane the window is
  // only now re-attaching to has been up longer than this says — which costs it
  // nothing but a slower return of its restart budget.
  const runStartedAt = useRef(Date.now())
  const [searchOpen, setSearchOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [crashPlan, setCrashPlan] = useState<RestartDecision | null>(null)
  const settings = useDeck((s) => s.settings)
  const updatePane = useDeck((s) => s.updatePane)
  const setPaneStatus = useDeck((s) => s.setPaneStatus)
  const setActivePane = useDeck((s) => s.setActivePane)
  const restartPane = useDeck((s) => s.restartPane)
  const closePane = useDeck((s) => s.closePane)
  const requestClosePane = useDeck((s) => s.requestClosePane)
  const toggleZoom = useDeck((s) => s.toggleZoom)
  const setUi = useDeck((s) => s.setUi)
  const zoomed = useDeck((s) => s.workspaces.find((w) => w.id === workspaceId)?.zoomedPaneId === pane.id)

  const title = pane.name || pane.processTitle || profile?.name || pane.command || 'terminal'
  const paneId = pane.id
  const autoRestart = Boolean(pane.autoRestart)
  const locked = Boolean(pane.readOnly)
  const muted = Boolean(pane.attentionMuted)
  // The terminal's handlers outlive the render that built them, so the lock is
  // read through a ref rather than the closure they captured.
  const lockedRef = useRef(locked)
  lockedRef.current = locked

  // One terminal per pane per epoch — a restart bumps the epoch and rebuilds it.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      // A still cursor is the lock saying so from inside the terminal.
      cursorBlink: settings.cursorBlink && !lockedRef.current,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      disableStdin: lockedRef.current,
      theme: { ...terminalTheme, cursor: accent },
      macOptionIsMeta: true,
      minimumContrastRatio: 1.1,
      smoothScrollDuration: 0,
      overviewRuler: { width: 10 }
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        api.openExternal(uri)
      })
    )

    term.open(host)

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* falls back to the DOM renderer */
    }

    const handle: TerminalHandle = {
      id: paneId,
      term,
      fit,
      search,
      attached: false,
      queue: [],
      write: (data) => {
        if (handle.attached) term.write(data)
        else handle.queue.push(data)
      },
      attach: () => {
        handle.attached = true
        if (handle.queue.length) {
          term.write(handle.queue.join(''))
          handle.queue = []
        }
      },
      refit: () => {
        if (!host.isConnected || host.clientWidth < 8 || host.clientHeight < 8) return
        try {
          fit.fit()
          api.pty.resize(paneId, term.cols, term.rows)
        } catch {
          /* terminal not measurable yet */
        }
      }
    }
    handleRef.current = handle
    registerTerminal(handle)

    const subs = [
      // The chokepoint: everything xterm turns into input arrives here, paste
      // and drops included, and none of it is a key event the handler below
      // would ever see.
      term.onData((data) => {
        if (lockedRef.current) return
        api.pty.write(paneId, data)
      }),
      term.onTitleChange((next) => updatePane(paneId, { processTitle: next.trim() || undefined })),
      term.onBell(() => {
        const state = useDeck.getState()
        // Not a plain `bell: true`: a pane ringing is a raised hand, and the
        // store is where a raised hand outranks a snooze someone put on it.
        state.ringBell(paneId)
        if (state.settings.bellNotifications && !document.hasFocus()) {
          const pane = state.workspaces.flatMap((w) => w.panes).find((p) => p.id === paneId)
          new Notification('Harness Deck', {
            body: `${pane?.name || pane?.processTitle || pane?.command} wants your attention`
          })
        }
      }),
      term.onSelectionChange(() => {
        if (!useDeck.getState().settings.copyOnSelect) return
        const selection = term.getSelection()
        if (selection) api.clipboard.write(selection)
      })
    ]

    // A locked pane hands every key straight past xterm: nothing is sent, and
    // nothing is acted on locally either. The window's own handler still sees
    // them, so Ctrl+Shift+C, the palette and the shortcuts keep working.
    term.attachCustomKeyEventHandler((event) => !lockedRef.current && !isReservedShortcut(event))

    const observer = new ResizeObserver(() => handle.refit())
    observer.observe(host)
    requestAnimationFrame(() => handle.refit())

    return () => {
      observer.disconnect()
      subs.forEach((sub) => sub.dispose())
      unregisterTerminal(paneId)
      handleRef.current = null
      spawnedRef.current = false
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, pane.epoch])

  // Start (or re-attach to) the process.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle || spawnedRef.current) return
    if (!pane.autostart) return
    spawnedRef.current = true

    let cancelled = false
    const { term } = handle
    void (async () => {
      const result = await api.pty.ensure(
        {
          id: paneId,
          command: pane.command,
          args: pane.args,
          cwd: pane.cwd,
          viaShell: pane.viaShell,
          env: pane.env,
          setup: pane.setup
        },
        Math.max(term.cols, 20),
        Math.max(term.rows, 5)
      )
      // A restart may have torn this terminal down while the spawn was in flight.
      if (cancelled) return
      if (result.previousSession) term.write(PREVIOUS_SESSION_RULE)
      if (result.replay) term.write(result.replay)
      handle.attach()
      // A process can die before the spawn reply gets back here, and that exit
      // event is the newer truth — never report it as running again.
      const current = useDeck
        .getState()
        .workspaces.flatMap((w) => w.panes)
        .find((p) => p.id === paneId)
      if (!(current?.status === 'exited' && result.status === 'running')) {
        setPaneStatus(paneId, result.status, result.exitCode ?? null)
      }
      handle.refit()
      if (active) term.focus()
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, pane.epoch, pane.autostart])

  // Auto-restart, for the panes that asked for it. The timer belongs to this
  // effect, so an epoch bump — a manual restart, an edit, the pane closing —
  // takes it down with the component that armed it. Same rule dispose() follows
  // in pty.ts: whatever the replaced session had pending is no longer news.
  useEffect(() => {
    if (!autoRestart || pane.status !== 'exited') {
      setCrashPlan(null)
      return
    }
    const plan = decideRestart({
      exitCode: pane.exitCode ?? null,
      ranMs: Date.now() - runStartedAt.current,
      attempts: pane.crashRestarts ?? 0
    })
    // The bar reads this rather than deciding for itself, so what it says is
    // what is about to happen.
    setCrashPlan(plan)
    if (plan.action !== 'restart') return
    const timer = window.setTimeout(() => {
      // restartPane clears the count, because by hand is how a crash loop is
      // meant to be broken — so the attempt this one spent goes back after it.
      restartPane(paneId)
      updatePane(paneId, { crashRestarts: plan.attempt })
    }, plan.delayMs)
    return () => window.clearTimeout(timer)
  }, [paneId, autoRestart, pane.status, pane.exitCode, pane.crashRestarts, restartPane, updatePane])

  // Live settings updates without rebuilding the terminal.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { term } = handle
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    term.options.cursorBlink = settings.cursorBlink && !locked
    term.options.cursorStyle = settings.cursorStyle
    term.options.scrollback = settings.scrollback
    // Belt to the data handler's braces: this stops xterm reading the keyboard
    // at all, which is also what makes an IME or a drop refuse to compose.
    term.options.disableStdin = locked
    term.options.theme = { ...terminalTheme, cursor: accent }
    handle.refit()
  }, [
    settings.fontSize,
    settings.fontFamily,
    settings.cursorBlink,
    settings.cursorStyle,
    settings.scrollback,
    accent,
    locked
  ])

  // Re-measure when the pane becomes visible again (hidden panes have no size).
  useEffect(() => {
    if (!visible) return
    const handle = handleRef.current
    if (!handle) return
    const id = requestAnimationFrame(() => {
      handle.refit()
      if (active) handle.term.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [visible, active])

  const focusPane = useCallback(() => {
    setActivePane(workspaceId, paneId)
    handleRef.current?.term.focus()
  }, [setActivePane, workspaceId, paneId])

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
            title={`Find in pane (${shortcutLabel('find-pane')})`}
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
            title={`${zoomed ? 'Restore pane' : 'Zoom pane'} (${shortcutLabel('zoom-pane')})`}
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
            title={`Restart process (${shortcutLabel('restart-pane')})`}
            onClick={() => restartPane(paneId)}
          >
            <Icon name="restart" />
          </button>
          <button
            className="icon-btn danger"
            title={`Close pane (${shortcutLabel('close-pane')})`}
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
