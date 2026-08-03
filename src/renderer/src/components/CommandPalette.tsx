import { useEffect, useMemo, useRef, useState } from 'react'
import { useDeck } from '../store'
import { RESTART_CAP } from '../restart'
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
  const workspaces = useDeck((s) => s.workspaces)
  const activeWorkspaceId = useDeck((s) => s.activeWorkspaceId)
  const templates = useDeck((s) => s.templates)
  const profiles = useDeck((s) => s.profiles)
  const update = useDeck((s) => s.update)
  const defaultCwd = useDeck((s) => s.settings.defaultCwd)
  const sidebarCollapsed = useDeck((s) => s.settings.sidebarCollapsed)
  const broadcastOpen = useDeck((s) => s.ui.broadcast)
  const setUi = useDeck((s) => s.setUi)
  const setActiveWorkspace = useDeck((s) => s.setActiveWorkspace)
  const addWorkspace = useDeck((s) => s.addWorkspace)
  const newWorkspaceFromTemplate = useDeck((s) => s.newWorkspaceFromTemplate)
  const updateWorkspace = useDeck((s) => s.updateWorkspace)
  const duplicateWorkspace = useDeck((s) => s.duplicateWorkspace)
  const removeWorkspace = useDeck((s) => s.removeWorkspace)
  const setLayout = useDeck((s) => s.setLayout)
  const setColumns = useDeck((s) => s.setColumns)
  const addPane = useDeck((s) => s.addPane)
  const focusNextWaiting = useDeck((s) => s.focusNextWaiting)
  const setActivePane = useDeck((s) => s.setActivePane)
  const restartPane = useDeck((s) => s.restartPane)
  const updatePane = useDeck((s) => s.updatePane)
  const killPane = useDeck((s) => s.killPane)
  const toggleZoom = useDeck((s) => s.toggleZoom)
  const closePane = useDeck((s) => s.closePane)
  const refreshProfiles = useDeck((s) => s.refreshProfiles)
  const showUpdate = useDeck((s) => s.showUpdate)
  const checkForUpdate = useDeck((s) => s.checkForUpdate)
  const installUpdate = useDeck((s) => s.installUpdate)
  const updateSettings = useDeck((s) => s.updateSettings)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const close = (): void => setUi({ palette: false })

  const commands = useMemo<Command[]>(() => {
    const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
    const activePane = workspace?.panes.find((p) => p.id === workspace.activePaneId)
    const list: Command[] = []

    workspaces.forEach((ws, index) => {
      list.push({
        id: `ws:${ws.id}`,
        group: 'Workspaces',
        label: `Switch to ${ws.name}`,
        hint: index < 9 ? `Ctrl+${index + 1}` : undefined,
        run: () => setActiveWorkspace(ws.id)
      })
    })

    list.push(
      {
        id: 'ws:new',
        group: 'Workspaces',
        label: 'New workspace',
        hint: 'Ctrl+Shift+N',
        run: () => addWorkspace()
      },
      {
        id: 'ws:new-folder',
        group: 'Workspaces',
        label: 'New workspace from folder…',
        run: async () => {
          const dir = await api.pickDirectory()
          if (dir) addWorkspace(undefined, dir)
        }
      }
    )

    if (templates.length) {
      list.push({
        id: 'ws:new-template',
        group: 'Workspaces',
        label: 'New workspace from template…',
        hint: `${templates.length} saved`,
        run: () => setUi({ templatePicker: true })
      })
      // Named entries too, so the common case is one search and one folder pick
      // rather than a trip through the picker.
      templates.forEach((template) => {
        list.push({
          id: `ws:template:${template.id}`,
          group: 'Templates',
          label: `New workspace from “${template.name}”…`,
          hint: `${template.panes.length} pane${template.panes.length === 1 ? '' : 's'}`,
          run: async () => {
            const dir = await api.pickDirectory(defaultCwd)
            if (dir) await newWorkspaceFromTemplate(template.id, dir)
          }
        })
      })
    }

    if (workspace) {
      list.push(
        {
          id: 'ws:folder',
          group: 'Workspace',
          label: `Change folder for ${workspace.name}…`,
          run: async () => {
            const dir = await api.pickDirectory(workspace.cwd)
            if (dir) updateWorkspace(workspace.id, { cwd: dir })
          }
        },
        {
          id: 'ws:duplicate',
          group: 'Workspace',
          label: 'Duplicate workspace with its panes',
          run: () => duplicateWorkspace(workspace.id)
        },
        {
          id: 'ws:save-template',
          group: 'Workspace',
          label: 'Save workspace as a template…',
          hint: 'its panes, without its folder',
          run: () => setUi({ templateSaveFor: workspace.id })
        },
        {
          id: 'ws:layout-grid',
          group: 'Workspace',
          label: 'Layout: grid',
          run: () => setLayout(workspace.id, 'grid')
        },
        {
          id: 'ws:layout-tabs',
          group: 'Workspace',
          label: 'Layout: tabs',
          run: () => setLayout(workspace.id, 'tabs')
        },
        {
          id: 'ws:broadcast',
          group: 'Workspace',
          label: broadcastOpen ? 'Hide broadcast bar' : 'Broadcast a prompt to every pane',
          hint: 'Ctrl+Shift+B',
          run: () => setUi({ broadcast: !broadcastOpen })
        },
        {
          id: 'ws:find-all',
          group: 'Workspace',
          label: 'Find across every pane…',
          hint: 'Ctrl+Shift+Alt+F',
          run: () => setUi({ findAll: true })
        },
        {
          id: 'ws:delete',
          group: 'Workspace',
          label: `Delete workspace ${workspace.name}`,
          run: () => removeWorkspace(workspace.id)
        }
      )

      // Only once there are two answers to compare. One worktree pane has
      // nothing to sit beside, and the entry would open an overlay with a
      // single column in it.
      const worktrees = workspace.panes.filter((pane) => pane.worktree).length
      if (worktrees >= 2) {
        list.push({
          id: 'ws:compare',
          group: 'Workspace',
          label: 'Compare what the agents did',
          hint: `${worktrees} worktrees, side by side`,
          run: () => setUi({ compare: true })
        })
      }

      for (let columns = 1; columns <= 4; columns += 1) {
        list.push({
          id: `ws:cols-${columns}`,
          group: 'Workspace',
          label: `Grid: ${columns} column${columns === 1 ? '' : 's'}`,
          run: () => {
            setLayout(workspace.id, 'grid')
            setColumns(workspace.id, columns)
          }
        })
      }

      profiles.forEach((profile) => {
        list.push({
          id: `pane:new:${profile.id}`,
          group: 'New pane',
          label: `${profile.name}${profile.available ? '' : ' (not installed)'}`,
          hint: profile.kind === 'agent' ? 'agent' : profile.kind,
          run: () => {
            // The bare `custom` entry has no command line yet — it needs the dialog.
            if (profile.id === 'custom') setUi({ profileMenu: true })
            else addPane(workspace.id, profile)
          }
        })
      })

      const waiting = workspaces.reduce(
        (total, ws) => total + ws.panes.filter((p) => p.status === 'waiting').length,
        0
      )
      list.push({
        id: 'pane:next-waiting',
        group: 'Panes',
        label: waiting
          ? `Jump to the next waiting pane (${waiting} waiting)`
          : 'Jump to the next waiting pane',
        hint: 'Ctrl+Shift+J',
        run: () => focusNextWaiting()
      })

      workspace.panes.forEach((pane, index) => {
        const profile = profiles.find((p) => p.id === pane.profileId)
        list.push({
          id: `pane:focus:${pane.id}`,
          group: 'Panes',
          label: `Focus ${pane.name || pane.processTitle || profile?.name || pane.command}`,
          hint: index < 9 ? `Alt+${index + 1}` : undefined,
          run: () => setActivePane(workspace.id, pane.id)
        })
      })

      if (activePane) {
        const paneLabel =
          activePane.name ||
          activePane.processTitle ||
          profiles.find((p) => p.id === activePane.profileId)?.name ||
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
            id: 'pane:edit',
            group: 'Active pane',
            label: 'Edit pane…',
            hint: 'command, folder, environment',
            run: () => setUi({ paneDialogFor: activePane.id })
          },
          {
            id: 'pane:restart',
            group: 'Active pane',
            label: 'Restart process',
            hint: 'Ctrl+Shift+R',
            run: () => restartPane(activePane.id)
          },
          {
            id: 'pane:read-only',
            group: 'Active pane',
            label: activePane.readOnly
              ? 'Let this pane take input again'
              : 'Lock this pane read-only',
            hint: activePane.readOnly ? 'locked' : 'refuses typing, paste, broadcast, dictation',
            run: () => updatePane(activePane.id, { readOnly: !activePane.readOnly })
          },
          {
            id: 'pane:auto-restart',
            group: 'Active pane',
            label: activePane.autoRestart
              ? 'Stop restarting this pane when it crashes'
              : 'Restart this pane when it crashes',
            hint: activePane.autoRestart ? 'on' : `${RESTART_CAP} attempts, then it stops`,
            run: () => updatePane(activePane.id, { autoRestart: !activePane.autoRestart })
          },
          {
            id: 'pane:kill',
            group: 'Active pane',
            label: 'Send SIGHUP (stop process)',
            run: () => killPane(activePane.id)
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
            run: () => toggleZoom(workspace.id, activePane.id)
          },
          {
            id: 'pane:close',
            group: 'Active pane',
            label: 'Close pane',
            hint: 'Ctrl+Shift+W',
            run: () => closePane(workspace.id, activePane.id)
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
        run: () => setUi({ settings: true })
      },
      {
        id: 'app:help',
        group: 'Application',
        label: 'Keyboard shortcuts',
        hint: 'Ctrl+Shift+/',
        run: () => setUi({ help: true })
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
        run: () => void refreshProfiles()
      },
      {
        id: 'app:check-update',
        group: 'Application',
        label: 'Check for updates',
        hint: update?.stage === 'available' ? update.available?.version : undefined,
        run: () => {
          showUpdate()
          void checkForUpdate()
        }
      },
      ...(update?.stage === 'available' && update.installable
        ? [
            {
              id: 'app:install-update',
              group: 'Application',
              label: `Restart and install ${update.available?.version}`,
              run: () => void installUpdate()
            }
          ]
        : []),
      {
        id: 'app:sidebar',
        group: 'Application',
        label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        run: () => updateSettings({ sidebarCollapsed: !sidebarCollapsed })
      }
    )

    return list
  }, [
    workspaces,
    activeWorkspaceId,
    templates,
    profiles,
    update,
    defaultCwd,
    sidebarCollapsed,
    broadcastOpen,
    setUi,
    setActiveWorkspace,
    addWorkspace,
    newWorkspaceFromTemplate,
    updateWorkspace,
    duplicateWorkspace,
    removeWorkspace,
    setLayout,
    setColumns,
    addPane,
    focusNextWaiting,
    setActivePane,
    restartPane,
    updatePane,
    killPane,
    toggleZoom,
    closePane,
    refreshProfiles,
    showUpdate,
    checkForUpdate,
    installUpdate,
    updateSettings
  ])

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
