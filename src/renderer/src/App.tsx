import { useEffect } from 'react'
import { useDeck } from './store'
import { getTerminal, refitAll } from './terminals'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { PaneArea } from './components/PaneArea'
import { BroadcastBar } from './components/BroadcastBar'
import { CommandPalette } from './components/CommandPalette'
import { SettingsDialog } from './components/SettingsDialog'
import { HelpDialog } from './components/HelpDialog'
import { UpdateToast } from './components/UpdateToast'
import { VoiceHud } from './components/VoiceHud'
import { Icon } from './components/Icon'
import { useVoice } from './voice'

const api = window.harness

const FONT_MIN = 8
const FONT_MAX = 28

export function App(): React.JSX.Element {
  const hydrated = useDeck((s) => s.hydrated)
  const workspaces = useDeck((s) => s.workspaces)
  const activeWorkspaceId = useDeck((s) => s.activeWorkspaceId)
  const mounted = useDeck((s) => s.mounted)
  const ui = useDeck((s) => s.ui)
  const updateChannel = useDeck((s) => s.settings.updateChannel)
  const addWorkspace = useDeck((s) => s.addWorkspace)
  const badgeEnabled = useDeck((s) => s.settings.attention.badge)
  const waitingCount = useDeck((s) =>
    s.workspaces.reduce(
      (total, ws) => total + ws.panes.filter((p) => p.status === 'waiting').length,
      0
    )
  )

  const active = workspaces.find((w) => w.id === activeWorkspaceId)

  // Panes waiting for you are the app's only unread count, so the platform gets
  // to show it: a dock badge, or a taskbar flash on Windows.
  useEffect(() => {
    api.attention.setBadge(badgeEnabled ? waitingCount : 0)
  }, [badgeEnabled, waitingCount])

  // Route pty output into the matching terminal and track background activity.
  useEffect(() => {
    const offData = api.pty.onData(({ id, data }) => {
      getTerminal(id)?.write(data)
      const state = useDeck.getState()
      const workspace = state.workspaces.find((w) => w.panes.some((p) => p.id === id))
      if (!workspace) return
      const pane = workspace.panes.find((p) => p.id === id)
      if (!pane || pane.activity) return
      const focused = workspace.id === state.activeWorkspaceId && workspace.activePaneId === id
      if (!focused) state.updatePane(id, { activity: true })
    })

    const offExit = api.pty.onExit(({ id, exitCode }) => {
      useDeck.getState().setPaneStatus(id, 'exited', exitCode)
    })

    // Output *stopping* is the signal worth having: the agent has hit a prompt,
    // an approval gate, or finished. The main process owns the clock; all that
    // is left here is turning it into a status the UI can route on.
    const offQuiet = api.pty.onQuiet(({ id, quiet }) => {
      const state = useDeck.getState()
      const pane = state.workspaces.flatMap((w) => w.panes).find((p) => p.id === id)
      // An exit is the newer truth — a dead pane is not waiting for you — and
      // the guard doubles as the once-per-transition rule for the notification.
      if (!pane || pane.status !== (quiet ? 'running' : 'waiting')) return
      state.setPaneStatus(id, quiet ? 'waiting' : 'running')
      if (!quiet || !state.settings.attention.notify || document.hasFocus()) return
      new Notification('Harness Deck', {
        body: `${pane.name || pane.processTitle || pane.command} is waiting for you`
      })
    })

    return () => {
      offData()
      offExit()
      offQuiet()
    }
  }, [])

  // The main process watches the release channel and pushes whatever it finds.
  useEffect(() => {
    const setUpdate = useDeck.getState().setUpdate
    void api.update.state().then(setUpdate)
    return api.update.onChange(setUpdate)
  }, [])

  // The updater starts on the local manifest and stays there until this says
  // otherwise, so a dev run or a smoke test never reaches for the network.
  useEffect(() => {
    if (!hydrated) return
    void api.update.setChannel(updateChannel).then(useDeck.getState().setUpdate)
  }, [hydrated, updateChannel])

  useEffect(() => {
    let frame = 0
    const onResize = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refitAll)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(frame)
    }
  }, [])

  // Global shortcuts. Terminals forward anything matching these (see TerminalPane).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useDeck.getState()
      const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
      const paneId = workspace?.activePaneId ?? null
      const ctrl = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const target = event.target as HTMLElement | null
      // xterm keeps a hidden textarea for input, so "focus is in a terminal"
      // must not count as typing in a form field.
      const inTerminal = Boolean(target?.closest('.xterm'))
      const typing =
        !inTerminal && Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))
      const take = (): void => {
        event.preventDefault()
        event.stopPropagation()
      }

      // Shift rewrites punctuation ("," becomes "<"), and on macOS Option
      // rewrites digits (Option+1 is "¡"), so match both on the physical key
      // and keep matching letters on the character.
      const code = event.code
      const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code)?.[1] ?? null
      const isMac = state.info?.platform === 'darwin'

      // macOS: the Edit menu owns Cmd+V, which xterm receives as a real paste
      // event. Cmd+C has to be ours — a pane's selection belongs to xterm and
      // never lands in the DOM where webContents.copy() would find it.
      if (isMac && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === 'c') {
        take()
        const field = inTerminal ? null : (target as HTMLInputElement | HTMLTextAreaElement | null)
        const selected =
          field && typeof field.selectionStart === 'number' && field.selectionStart !== field.selectionEnd
            ? field.value.slice(field.selectionStart, field.selectionEnd ?? undefined)
            : ''
        const text = inTerminal
          ? (paneId ? getTerminal(paneId)?.term.getSelection() ?? '' : '')
          : selected || window.getSelection()?.toString() || ''
        if (text) api.clipboard.write(text)
        return
      }

      if (ctrl && event.shiftKey) {
        if (code === 'Comma' || key === ',' || key === '<') {
          take()
          return state.setUi({ settings: true })
        }
        if (code === 'Slash' || key === '/' || key === '?') {
          take()
          return state.setUi({ help: true })
        }
        switch (key) {
          case 'p':
            take()
            return state.setUi({ palette: !state.ui.palette })
          case 'b':
            take()
            return state.setUi({ broadcast: !state.ui.broadcast })
          // Above the `typing` guard so dictation also works from a text box.
          case 'm':
            take()
            return useVoice.getState().toggle()
          case 'n':
            take()
            state.addWorkspace()
            return
          default:
            break
        }
      }

      if (typing) return

      if (ctrl && event.shiftKey) {
        switch (key) {
          case 't':
            take()
            if (workspace) state.setUi({ profileMenu: true })
            return
          case 'w':
            take()
            if (workspace && paneId) void state.requestClosePane(workspace.id, paneId)
            return
          case 'r':
            take()
            if (paneId) state.restartPane(paneId)
            return
          case 'z':
            take()
            if (workspace && paneId) state.toggleZoom(workspace.id, paneId)
            return
          case 'f':
            take()
            if (paneId) window.dispatchEvent(new CustomEvent('deck:find', { detail: { paneId } }))
            return
          case 'k':
            take()
            if (paneId) getTerminal(paneId)?.term.clear()
            return
          case 'j': {
            take()
            // Nothing waiting is a no-op, not an error — the same key is how
            // you check whether anything is waiting at all.
            const next = state.focusNextWaiting()
            if (next) getTerminal(next)?.term.focus()
            return
          }
          case 'c': {
            take()
            const selection = paneId ? getTerminal(paneId)?.term.getSelection() : ''
            if (selection) api.clipboard.write(selection)
            return
          }
          case 'v': {
            take()
            if (!paneId) return
            void api.clipboard.read().then((text) => {
              if (text) api.pty.write(paneId, text)
            })
            return
          }
          case 'arrowleft':
            take()
            if (workspace && paneId) state.movePane(workspace.id, paneId, -1)
            return
          case 'arrowright':
            take()
            if (workspace && paneId) state.movePane(workspace.id, paneId, 1)
            return
          case 'tab':
            take()
            state.cyclePane(-1)
            return
          default:
            break
        }
      }

      if (ctrl && !event.shiftKey) {
        if (key === 'tab') {
          take()
          state.cyclePane(1)
          return
        }
        if (key === 'pagedown') {
          take()
          state.cycleWorkspace(1)
          return
        }
        if (key === 'pageup') {
          take()
          state.cycleWorkspace(-1)
          return
        }
        if (digit) {
          const workspaceAt = state.workspaces[Number(digit) - 1]
          if (workspaceAt) {
            take()
            state.setActiveWorkspace(workspaceAt.id)
          }
          return
        }
        if (['=', '+'].includes(event.key) || code === 'Equal' || code === 'NumpadAdd') {
          take()
          return state.updateSettings({
            fontSize: Math.min(FONT_MAX, state.settings.fontSize + 1)
          })
        }
        if (['-', '_'].includes(event.key) || code === 'Minus' || code === 'NumpadSubtract') {
          take()
          return state.updateSettings({
            fontSize: Math.max(FONT_MIN, state.settings.fontSize - 1)
          })
        }
        if (event.key === '0') {
          take()
          return state.updateSettings({ fontSize: 13 })
        }
      }

      if (event.altKey && digit && workspace) {
        const pane = workspace.panes[Number(digit) - 1]
        if (pane) {
          take()
          state.setActivePane(workspace.id, pane.id)
          getTerminal(pane.id)?.term.focus()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  if (!hydrated) {
    return (
      <div className="boot">
        <span className="boot-mark" />
        <p>Looking for coding harnesses…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="deck">
          {active ? <Toolbar workspace={active} /> : null}
          <div className="deck-panes">
            {workspaces
              .filter((workspace) => mounted.includes(workspace.id))
              .map((workspace) => (
                <PaneArea
                  key={workspace.id}
                  workspace={workspace}
                  visible={workspace.id === activeWorkspaceId}
                />
              ))}
            {!workspaces.length ? (
              <div className="empty">
                <div className="empty-card">
                  <h2>No workspaces</h2>
                  <p>A workspace is a named set of terminals — one per project or experiment.</p>
                  <button className="btn primary" onClick={() => addWorkspace()}>
                    <Icon name="plus" />
                    <span>New workspace</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {active && ui.broadcast ? <BroadcastBar workspace={active} /> : null}
        </main>
      </div>

      <UpdateToast />
      <VoiceHud />

      {ui.palette ? <CommandPalette /> : null}
      {ui.settings ? <SettingsDialog /> : null}
      {ui.help ? <HelpDialog /> : null}
    </div>
  )
}
