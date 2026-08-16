import { useEffect } from 'react'
import { findPane, findPaneWorkspace, isActionable, useDeck, type DeckWorkspace } from './store'
import { digitOf, matchShortcut, type ShortcutId } from './shortcuts'
import { getTerminal, refitAll } from './terminals'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { Toolbar } from './components/Toolbar'
import { PaneArea } from './components/PaneArea'
import { BroadcastBar, fencedBlock } from './components/BroadcastBar'
import { DeckSearch } from './components/DeckSearch'
import { CommandPalette } from './components/CommandPalette'
import { WaitingQueue } from './components/WaitingQueue'
import { SettingsDialog } from './components/SettingsDialog'
import { HelpDialog } from './components/HelpDialog'
import { UpdateToast } from './components/UpdateToast'
import { NoticeToast } from './components/NoticeToast'
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
    s.workspaces.reduce((total, ws) => total + ws.panes.filter((p) => isActionable(p)).length, 0)
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
      const workspace = findPaneWorkspace(state.workspaces, id)
      if (!workspace) return
      const pane = findPane(state.workspaces, id)
      if (!pane || pane.activity) return
      const focused = workspace.id === state.activeWorkspaceId && workspace.activePaneId === id
      if (!focused) state.updatePane(id, { activity: true })
    })

    const offExit = api.pty.onExit(({ id, exitCode }) => {
      useDeck.getState().setPaneStatus(id, 'exited', exitCode)
    })

    return () => {
      offData()
      offExit()
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

  // Global shortcuts. The table in shortcuts.ts decides what matches — and is
  // also what TerminalPane forwards past xterm — so what each combo *does* is
  // all that lives here, bound by id.
  useEffect(() => {
    interface ShortcutScope {
      event: KeyboardEvent
      state: ReturnType<typeof useDeck.getState>
      workspace: DeckWorkspace | undefined
      paneId: string | null
      inTerminal: boolean
      take: () => void
    }

    const actions: Record<ShortcutId, (scope: ShortcutScope) => void> = {
      // Cmd+C has to lift a selection wherever it lives: xterm's buffer, a
      // form field, or the document — none of which reach webContents.copy().
      'copy-selection-mac': ({ event, paneId, inTerminal, take }) => {
        take()
        const target = event.target as HTMLInputElement | HTMLTextAreaElement | null
        const field = inTerminal ? null : target
        const selected =
          field && typeof field.selectionStart === 'number' && field.selectionStart !== field.selectionEnd
            ? field.value.slice(field.selectionStart, field.selectionEnd ?? undefined)
            : ''
        const text = inTerminal
          ? (paneId ? getTerminal(paneId)?.term.getSelection() ?? '' : '')
          : selected || window.getSelection()?.toString() || ''
        if (text) api.clipboard.write(text)
      },
      'open-settings': ({ state, take }) => {
        take()
        state.setUi({ settings: true })
      },
      'open-help': ({ state, take }) => {
        take()
        state.setUi({ help: true })
      },
      'toggle-palette': ({ state, take }) => {
        take()
        state.setUi({ palette: !state.ui.palette })
      },
      'toggle-broadcast': ({ state, take }) => {
        take()
        state.setUi({ broadcast: !state.ui.broadcast })
      },
      // The shortest path from "the error is on screen" to "the agents have
      // it": what xterm hands back is already plain text, so all that is left
      // is fencing it and opening the bar over whatever you were looking at.
      'send-selection': ({ state, paneId, take }) => {
        take()
        const selection = paneId ? getTerminal(paneId)?.term.getSelection() ?? '' : ''
        // A drag across empty terminal is not a selection — it must not open
        // the bar on an empty fence.
        if (!selection.trim()) return
        state.setUi({ broadcast: true, pendingInsert: fencedBlock(selection) })
      },
      'toggle-dictation': ({ take }) => {
        take()
        useVoice.getState().toggle()
      },
      'new-workspace': ({ state, take }) => {
        take()
        state.addWorkspace()
      },
      'find-all': ({ state, workspace, take }) => {
        take()
        if (workspace) state.setUi({ findAll: !state.ui.findAll })
      },
      'new-pane': ({ state, workspace, take }) => {
        take()
        if (workspace) state.setUi({ profileMenu: true })
      },
      'close-pane': ({ state, workspace, paneId, take }) => {
        take()
        if (workspace && paneId) void state.requestClosePane(workspace.id, paneId)
      },
      'restart-pane': ({ state, paneId, take }) => {
        take()
        if (paneId) state.restartPane(paneId)
      },
      'zoom-pane': ({ state, workspace, paneId, take }) => {
        take()
        if (workspace && paneId) state.toggleZoom(workspace.id, paneId)
      },
      'find-pane': ({ paneId, take }) => {
        take()
        if (paneId) window.dispatchEvent(new CustomEvent('deck:find', { detail: { paneId } }))
      },
      'clear-pane': ({ paneId, take }) => {
        take()
        if (paneId) getTerminal(paneId)?.term.clear()
      },
      'focus-waiting': ({ state, take }) => {
        take()
        // Nothing waiting is a no-op, not an error — the same key is how
        // you check whether anything is waiting at all.
        const next = state.focusNextWaiting()
        if (next) getTerminal(next)?.term.focus()
      },
      'toggle-waiting-queue': ({ state, take }) => {
        take()
        state.setUi({ waitingQueue: !state.ui.waitingQueue })
      },
      'copy-selection': ({ paneId, take }) => {
        take()
        const selection = paneId ? getTerminal(paneId)?.term.getSelection() : ''
        if (selection) api.clipboard.write(selection)
      },
      'paste': ({ workspace, paneId, take }) => {
        take()
        if (!paneId) return
        // This one never reaches xterm, so the pane's own refusal cannot
        // see it — the lock has to be checked here as well.
        if (workspace?.panes.find((p) => p.id === paneId)?.readOnly) return
        void api.clipboard.read().then((text) => {
          if (text) api.pty.write(paneId, text)
        })
      },
      'move-pane-left': ({ state, workspace, paneId, take }) => {
        take()
        if (workspace && paneId) state.movePane(workspace.id, paneId, -1)
      },
      'move-pane-right': ({ state, workspace, paneId, take }) => {
        take()
        if (workspace && paneId) state.movePane(workspace.id, paneId, 1)
      },
      'prev-pane': ({ state, take }) => {
        take()
        state.cyclePane(-1)
      },
      'next-pane': ({ state, take }) => {
        take()
        state.cyclePane(1)
      },
      'next-workspace': ({ state, take }) => {
        take()
        state.cycleWorkspace(1)
      },
      'prev-workspace': ({ state, take }) => {
        take()
        state.cycleWorkspace(-1)
      },
      // No workspace at that position means no take() either — the key falls
      // through to whatever else wants it.
      'workspace-by-digit': ({ event, state, take }) => {
        const workspaceAt = state.workspaces[Number(digitOf(event)) - 1]
        if (workspaceAt) {
          take()
          state.setActiveWorkspace(workspaceAt.id)
        }
      },
      'font-bigger': ({ state, take }) => {
        take()
        state.updateSettings({ fontSize: Math.min(FONT_MAX, state.settings.fontSize + 1) })
      },
      'font-smaller': ({ state, take }) => {
        take()
        state.updateSettings({ fontSize: Math.max(FONT_MIN, state.settings.fontSize - 1) })
      },
      'font-reset': ({ state, take }) => {
        take()
        state.updateSettings({ fontSize: 13 })
      },
      'focus-pane-by-digit': ({ event, state, workspace, take }) => {
        if (!workspace) return
        const pane = workspace.panes[Number(digitOf(event)) - 1]
        if (pane) {
          take()
          state.setActivePane(workspace.id, pane.id)
          getTerminal(pane.id)?.term.focus()
        }
      },
      // Unlike the other digit shortcuts this one is not idempotent — every
      // firing opens a pane with a real process in it — so key autorepeat must
      // not count as pressing it again.
      'run-action-by-digit': ({ event, state, workspace, take }) => {
        if (!workspace || event.repeat) return
        const action = workspace.actions?.[Number(digitOf(event)) - 1]
        if (action) {
          take()
          state.runWorkspaceAction(workspace.id, action.id)
        }
      }
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useDeck.getState()
      const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
      const target = event.target as HTMLElement | null
      // xterm keeps a hidden textarea for input, so "focus is in a terminal"
      // must not count as typing in a form field.
      const inTerminal = Boolean(target?.closest('.xterm'))
      const typing =
        !inTerminal && Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))

      const shortcut = matchShortcut(event, state.info?.platform === 'darwin')
      if (!shortcut) return
      if (typing && !shortcut.whileTyping) return
      actions[shortcut.id]({
        event,
        state,
        workspace,
        paneId: workspace?.activePaneId ?? null,
        inTerminal,
        take: () => {
          event.preventDefault()
          event.stopPropagation()
        }
      })
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
            {active && ui.findAll ? <DeckSearch workspace={active} /> : null}
          </div>
          {active && ui.broadcast ? <BroadcastBar workspace={active} /> : null}
        </main>
      </div>

      <UpdateToast />
      <NoticeToast />
      <VoiceHud />

      {/* Outside the deck: it lists panes from every workspace, so it cannot
          belong to the one on screen. */}
      {ui.waitingQueue ? <WaitingQueue /> : null}
      {ui.palette ? <CommandPalette /> : null}
      {ui.settings ? <SettingsDialog /> : null}
      {ui.help ? <HelpDialog /> : null}
    </div>
  )
}
