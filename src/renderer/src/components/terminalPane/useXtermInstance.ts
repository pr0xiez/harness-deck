import { useEffect, useRef, type RefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { useDeck } from '../../store'
import { isReservedShortcut } from '../../shortcuts'
import { registerTerminal, unregisterTerminal, type TerminalHandle } from '../../terminals'
import { terminalTheme } from '../../theme'

const api = window.harness

export interface XtermRefs {
  /** Where the terminal mounts. */
  hostRef: RefObject<HTMLDivElement | null>
  /** The live instance — null between teardown and the next epoch's build. */
  handleRef: RefObject<TerminalHandle | null>
  /** Read and set by usePtyAttach; reset here so a rebuilt terminal respawns. */
  spawnedRef: RefObject<boolean>
  /**
   * The terminal's handlers outlive the render that built them, so the lock is
   * read through this ref rather than the closure they captured.
   */
  lockedRef: RefObject<boolean>
}

/**
 * Owns the xterm instance for one pane: construction, addon wiring (WebGL with
 * a DOM-renderer fallback), the data/bell/selection/title subscriptions, the
 * resize observer, and teardown.
 *
 * One terminal per pane per epoch — a restart bumps the epoch and rebuilds it.
 * Settings and accent are read at creation time only; useLiveTerminalSettings
 * keeps the live instance current without a rebuild.
 */
export function useXtermInstance(
  paneId: string,
  epoch: number,
  accent: string,
  locked: boolean
): XtermRefs {
  const hostRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<TerminalHandle | null>(null)
  const spawnedRef = useRef(false)
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const accentRef = useRef(accent)
  accentRef.current = accent

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // Creation-time snapshot; live changes land via useLiveTerminalSettings.
    const { settings } = useDeck.getState()

    const term = new Terminal({
      allowProposedApi: true,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      // A still cursor is the lock saying so from inside the terminal.
      cursorBlink: settings.cursorBlink && !lockedRef.current,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      disableStdin: lockedRef.current,
      theme: { ...terminalTheme, cursor: accentRef.current },
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
      term.onTitleChange((next) =>
        useDeck.getState().updatePane(paneId, { processTitle: next.trim() || undefined })
      ),
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
  }, [paneId, epoch])

  return { hostRef, handleRef, spawnedRef, lockedRef }
}
