import { useEffect, useMemo, useRef, useState } from 'react'
import { useDeck } from '../store'
import { useVoice } from '../voice'
import { Icon } from './Icon'

const api = window.harness

interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/** Names a workspace or pane in a way every filesystem will accept. */
const slug = (text: string): string =>
  text.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pane'

const pad = (value: number): string => String(value).padStart(2, '0')

/** `<workspace>-<pane>-<yyyymmdd-hhmm>.txt`, local time — it is a local file. */
function transcriptName(workspace: string, pane: string, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${slug(workspace)}-${slug(pane)}-${stamp}.txt`
}

export function CommandPalette(): React.JSX.Element {
  const state = useDeck()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const close = (): void => state.setUi({ palette: false })

  const commands = useMemo<Command[]>(() => {
    const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
    const activePane = workspace?.panes.find((p) => p.id === workspace.activePaneId)
    const list: Command[] = []

    state.workspaces.forEach((ws, index) => {
      list.push({
        id: `ws:${ws.id}`,
        group: 'Workspaces',
        label: `Switch to ${ws.name}`,
        hint: index < 9 ? `Ctrl+${index + 1}` : undefined,
        run: () => state.setActiveWorkspace(ws.id)
      })
    })

    list.push(
      {
        id: 'ws:new',
        group: 'Workspaces',
        label: 'New workspace',
        hint: 'Ctrl+Shift+N',
        run: () => state.addWorkspace()
      },
      {
        id: 'ws:new-folder',
        group: 'Workspaces',
        label: 'New workspace from folder…',
        run: async () => {
          const dir = await api.pickDirectory()
          if (dir) state.addWorkspace(undefined, dir)
        }
      }
    )

    if (workspace) {
      list.push(
        {
          id: 'ws:folder',
          group: 'Workspace',
          label: `Change folder for ${workspace.name}…`,
          run: async () => {
            const dir = await api.pickDirectory(workspace.cwd)
            if (dir) state.updateWorkspace(workspace.id, { cwd: dir })
          }
        },
        {
          id: 'ws:duplicate',
          group: 'Workspace',
          label: 'Duplicate workspace with its panes',
          run: () => state.duplicateWorkspace(workspace.id)
        },
        {
          id: 'ws:layout-grid',
          group: 'Workspace',
          label: 'Layout: grid',
          run: () => state.setLayout(workspace.id, 'grid')
        },
        {
          id: 'ws:layout-tabs',
          group: 'Workspace',
          label: 'Layout: tabs',
          run: () => state.setLayout(workspace.id, 'tabs')
        },
        {
          id: 'ws:broadcast',
          group: 'Workspace',
          label: state.ui.broadcast ? 'Hide broadcast bar' : 'Broadcast a prompt to every pane',
          hint: 'Ctrl+Shift+B',
          run: () => state.setUi({ broadcast: !state.ui.broadcast })
        },
        {
          id: 'ws:delete',
          group: 'Workspace',
          label: `Delete workspace ${workspace.name}`,
          run: () => state.removeWorkspace(workspace.id)
        }
      )

      for (let columns = 1; columns <= 4; columns += 1) {
        list.push({
          id: `ws:cols-${columns}`,
          group: 'Workspace',
          label: `Grid: ${columns} column${columns === 1 ? '' : 's'}`,
          run: () => {
            state.setLayout(workspace.id, 'grid')
            state.setColumns(workspace.id, columns)
          }
        })
      }

      state.profiles.forEach((profile) => {
        list.push({
          id: `pane:new:${profile.id}`,
          group: 'New pane',
          label: `${profile.name}${profile.available ? '' : ' (not installed)'}`,
          hint: profile.kind === 'agent' ? 'agent' : profile.kind,
          run: () => {
            if (profile.kind === 'custom') state.setUi({ profileMenu: true })
            else state.addPane(workspace.id, profile)
          }
        })
      })

      workspace.panes.forEach((pane, index) => {
        const profile = state.profiles.find((p) => p.id === pane.profileId)
        list.push({
          id: `pane:focus:${pane.id}`,
          group: 'Panes',
          label: `Focus ${pane.name || pane.processTitle || profile?.name || pane.command}`,
          hint: index < 9 ? `Alt+${index + 1}` : undefined,
          run: () => state.setActivePane(workspace.id, pane.id)
        })
      })

      if (activePane) {
        const paneLabel =
          activePane.name ||
          activePane.processTitle ||
          state.profiles.find((p) => p.id === activePane.profileId)?.name ||
          activePane.command
        const copyTranscript = async (strip: boolean): Promise<void> =>
          api.clipboard.write(await api.pty.transcript(activePane.id, strip))
        const saveTranscript = async (strip: boolean): Promise<void> => {
          await api.saveText({
            defaultName: transcriptName(workspace.name, paneLabel, new Date()),
            text: await api.pty.transcript(activePane.id, strip)
          })
        }

        list.push(
          {
            id: 'pane:restart',
            group: 'Active pane',
            label: 'Restart process',
            hint: 'Ctrl+Shift+R',
            run: () => state.restartPane(activePane.id)
          },
          {
            id: 'pane:kill',
            group: 'Active pane',
            label: 'Send SIGHUP (stop process)',
            run: () => state.killPane(activePane.id)
          },
          {
            id: 'pane:copy-transcript',
            group: 'Active pane',
            label: 'Copy pane transcript',
            hint: 'plain text',
            run: () => void copyTranscript(true)
          },
          {
            id: 'pane:copy-transcript-raw',
            group: 'Active pane',
            label: 'Copy pane transcript with its escape codes',
            hint: 'raw',
            run: () => void copyTranscript(false)
          },
          {
            id: 'pane:save-transcript',
            group: 'Active pane',
            label: 'Save pane transcript…',
            hint: 'plain text',
            run: () => void saveTranscript(true)
          },
          {
            id: 'pane:save-transcript-raw',
            group: 'Active pane',
            label: 'Save pane transcript with its escape codes…',
            hint: 'raw',
            run: () => void saveTranscript(false)
          },
          {
            id: 'pane:zoom',
            group: 'Active pane',
            label: 'Zoom / restore pane',
            hint: 'Ctrl+Shift+Z',
            run: () => state.toggleZoom(workspace.id, activePane.id)
          },
          {
            id: 'pane:close',
            group: 'Active pane',
            label: 'Close pane',
            hint: 'Ctrl+Shift+W',
            run: () => state.closePane(workspace.id, activePane.id)
          }
        )
      }
    }

    list.push(
      {
        id: 'app:settings',
        group: 'Application',
        label: 'Settings',
        hint: 'Ctrl+Shift+,',
        run: () => state.setUi({ settings: true })
      },
      {
        id: 'app:help',
        group: 'Application',
        label: 'Keyboard shortcuts',
        hint: 'Ctrl+Shift+/',
        run: () => state.setUi({ help: true })
      },
      {
        id: 'app:dictate',
        group: 'Application',
        label:
          useVoice.getState().status === 'listening'
            ? 'Stop dictating'
            : 'Dictate into the focused prompt',
        hint: 'Ctrl+Shift+M',
        run: () => useVoice.getState().toggle()
      },
      {
        id: 'app:rescan',
        group: 'Application',
        label: 'Rescan for installed harnesses',
        run: () => void state.refreshProfiles()
      },
      {
        id: 'app:check-update',
        group: 'Application',
        label: 'Check for updates',
        hint: state.update?.stage === 'available' ? state.update.available?.version : undefined,
        run: () => {
          state.showUpdate()
          void state.checkForUpdate()
        }
      },
      ...(state.update?.stage === 'available' && state.update.installable
        ? [
            {
              id: 'app:install-update',
              group: 'Application',
              label: `Restart and install ${state.update.available?.version}`,
              run: () => void state.installUpdate()
            }
          ]
        : []),
      {
        id: 'app:sidebar',
        group: 'Application',
        label: state.settings.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        run: () => state.updateSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed })
      }
    )

    return list
  }, [state])

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    const words = needle.split(/\s+/)
    return commands
      .map((command) => {
        const haystack = `${command.group} ${command.label}`.toLowerCase()
        let score = 0
        for (const word of words) {
          const at = haystack.indexOf(word)
          if (at === -1) return null
          score += at === 0 ? 3 : haystack.includes(` ${word}`) ? 2 : 1
        }
        return { command, score }
      })
      .filter((entry): entry is { command: Command; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => setCursor(0), [query])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const runAt = (index: number): void => {
    const command = results[index]
    if (!command) return
    close()
    command.run()
  }

  return (
    <div className="scrim palette-scrim" onMouseDown={close}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Icon name="command" />
          <input
            autoFocus
            value={query}
            placeholder="Run a command — switch workspace, open a harness, change layout…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((c) => Math.min(c + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runAt(cursor)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
          />
          <span className="palette-count">{results.length}</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.map((command, index) => (
            <button
              key={command.id}
              className={`palette-item ${index === cursor ? 'on' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={() => runAt(index)}
            >
              <span className="palette-group">{command.group}</span>
              <span className="palette-label">{command.label}</span>
              {command.hint ? <span className="palette-hint">{command.hint}</span> : null}
            </button>
          ))}
          {!results.length ? <div className="palette-none">Nothing matches “{query}”</div> : null}
        </div>
      </div>
    </div>
  )
}
