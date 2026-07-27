import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { Profile } from '@shared/types'
import { useDeck, type PaneView } from '../store'
import { registerTerminal, unregisterTerminal, type TerminalHandle } from '../terminals'
import { terminalTheme } from '../theme'
import { PaneSearch } from './PaneSearch'
import { Icon } from './Icon'

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

/** Reserved for the app: xterm must not swallow these. */
function isAppShortcut(event: KeyboardEvent): boolean {
  const ctrl = event.ctrlKey || event.metaKey
  // Option rewrites digits on macOS ("¡" for Option+1), so the digit tests go
  // by the physical key — same reasoning as the handler in App.tsx.
  const digit = /^(?:Digit|Numpad)[1-9]$/.test(event.code)
  if (ctrl && event.shiftKey) return true
  if (ctrl && ['+', '=', '-', '_', '0'].includes(event.key)) return true
  if (ctrl && event.key === 'Tab') return true
  if (event.altKey && digit) return true
  if (ctrl && digit) return true
  // The app services plain Cmd+C so it can lift xterm's own selection.
  if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') return true
  return false
}

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
  const [searchOpen, setSearchOpen] = useState(false)
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

  // One terminal per pane per epoch — a restart bumps the epoch and rebuilds it.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      allowProposedApi: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
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
      term.onData((data) => api.pty.write(paneId, data)),
      term.onTitleChange((next) => updatePane(paneId, { processTitle: next.trim() || undefined })),
      term.onBell(() => {
        const state = useDeck.getState()
        state.updatePane(paneId, { bell: true })
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

    term.attachCustomKeyEventHandler((event) => !isAppShortcut(event))

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
          env: pane.env
        },
        Math.max(term.cols, 20),
        Math.max(term.rows, 5)
      )
      // A restart may have torn this terminal down while the spawn was in flight.
      if (cancelled) return
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

  // Live settings updates without rebuilding the terminal.
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { term } = handle
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    term.options.cursorBlink = settings.cursorBlink
    term.options.cursorStyle = settings.cursorStyle
    term.options.scrollback = settings.scrollback
    term.options.theme = { ...terminalTheme, cursor: accent }
    handle.refit()
  }, [settings.fontSize, settings.fontFamily, settings.cursorBlink, settings.cursorStyle, settings.scrollback, accent])

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

  const statusLabel =
    pane.status === 'running'
      ? 'running'
      : pane.status === 'exited'
        ? `exited ${pane.exitCode ?? ''}`.trim()
        : 'idle'

  return (
    <section
      className={`pane ${active ? 'is-active' : ''} ${pane.status} ${visible ? '' : 'is-hidden'}`}
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
        {pane.activity && !active ? <span className="pane-dot" title="new output" /> : null}
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
            title={zoomed ? 'Restore pane (Ctrl+Shift+Z)' : 'Zoom pane (Ctrl+Shift+Z)'}
            onClick={() => toggleZoom(workspaceId, paneId)}
          >
            <Icon name={zoomed ? 'minimize' : 'maximize'} />
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
            </span>
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
