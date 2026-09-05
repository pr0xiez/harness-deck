import { paneLabel } from '../paneLabel'
import { isActionable, useDeck, type DeckWorkspace, type PaneView } from '../store'
import { isOpencodeProfile } from '@shared/opencode'
import { RESTART_CAP } from '../restart'
import { useVoice } from '../voice'
import { getTerminal } from '../terminals'
import { fencedBlock } from './BroadcastBar'

const api = window.harness

/**
 * The palette's command list, one builder per group. Each builder takes the
 * store snapshot — and whatever workspace or pane its group is about — and
 * hands back plain `Command[]`; `CommandPalette` composes them in order, so
 * each group can be read, and tested, on its own.
 */

export interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

/** The whole store, actions included — the builders call straight into it. */
type Deck = ReturnType<typeof useDeck.getState>

/** Names a workspace or pane in a way every filesystem will accept. */
const slug = (text: string): string =>
  text.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pane'

const pad = (value: number): string => String(value).padStart(2, '0')

/** `<workspace>-<pane>-<yyyymmdd-hhmm>.txt`, local time — it is a local file. */
export function transcriptName(workspace: string, pane: string, at: Date): string {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${slug(workspace)}-${slug(pane)}-${stamp}.txt`
}

/** Switching between workspaces, and the two ways of starting a blank one. */
export function workspaceCommands(state: Deck): Command[] {
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

  return list
}

/** Nothing at all until a template has been saved. */
export function templateCommands(state: Deck): Command[] {
  if (!state.templates.length) return []

  const list: Command[] = [
    {
      id: 'ws:new-template',
      group: 'Workspaces',
      label: 'New workspace from template…',
      hint: `${state.templates.length} saved`,
      run: () => state.setUi({ templatePicker: true })
    }
  ]
  // Named entries too, so the common case is one search and one folder pick
  // rather than a trip through the picker.
  state.templates.forEach((template) => {
    list.push({
      id: `ws:template:${template.id}`,
      group: 'Templates',
      label: `New workspace from “${template.name}”…`,
      hint: `${template.panes.length} pane${template.panes.length === 1 ? '' : 's'}`,
      run: async () => {
        const dir = await api.pickDirectory(state.settings.defaultCwd)
        if (dir) await state.newWorkspaceFromTemplate(template.id, dir)
      }
    })
  })

  return list
}

/** Everything that acts on the active workspace as a whole. */
export function activeWorkspaceCommands(state: Deck, workspace: DeckWorkspace): Command[] {
  const list: Command[] = [
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
      id: 'ws:save-template',
      group: 'Workspace',
      label: 'Save workspace as a template…',
      hint: 'its panes, without its folder',
      run: () => state.setUi({ templateSaveFor: workspace.id })
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
      id: 'ws:find-all',
      group: 'Workspace',
      label: 'Find across every pane…',
      hint: 'Ctrl+Shift+Alt+F',
      run: () => state.setUi({ findAll: true })
    },
    {
      id: 'ws:setup-actions',
      group: 'Workspace',
      label: 'Setup command and actions…',
      hint: workspace.setupCommand || 'what a fresh worktree runs first',
      run: () => state.setUi({ workspaceDialogFor: workspace.id })
    },
    {
      id: 'ws:delete',
      group: 'Workspace',
      label: `Delete workspace ${workspace.name}`,
      run: () => state.removeWorkspace(workspace.id)
    }
  ]

  // The chips, by name. Searching for "test" and pressing Enter is the
  // whole point of having saved the command in the first place.
  workspace.actions?.forEach((action, index) => {
    list.push({
      id: `ws:action:${action.id}`,
      group: 'Workspace',
      label: `Run ${action.label}`,
      hint: index < 9 ? `Alt+Shift+${index + 1}` : action.command,
      run: () => state.runWorkspaceAction(workspace.id, action.id)
    })
  })

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
      run: () => state.setUi({ compare: true })
    })
  }

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

  return list
}

/** One entry per harness profile, opening a fresh pane in the workspace. */
export function newPaneCommands(state: Deck, workspace: DeckWorkspace): Command[] {
  return state.profiles.map((profile) => ({
    id: `pane:new:${profile.id}`,
    group: 'New pane',
    label: `${profile.name}${profile.available ? '' : ' (not installed)'}`,
    hint: profile.kind === 'agent' ? 'agent' : profile.kind,
    run: () => {
      // The bare `custom` entry has no command line yet — it needs the dialog.
      // OpenCode has one too, for its model, agent and session options.
      if (profile.id === 'custom') state.setUi({ profileMenu: true })
      else if (isOpencodeProfile(profile.id))
        state.setUi({ opencodeFor: { workspaceId: workspace.id, profileId: profile.id } })
      else state.addPane(workspace.id, profile)
    }
  }))
}

/** Moving between panes: the waiting queue, and focus by name. */
export function paneCommands(state: Deck, workspace: DeckWorkspace): Command[] {
  const waiting = state.workspaces.reduce(
    (total, ws) => total + ws.panes.filter((p) => isActionable(p)).length,
    0
  )
  const list: Command[] = [
    {
      id: 'pane:next-waiting',
      group: 'Panes',
      label: waiting
        ? `Jump to the next waiting pane (${waiting} waiting)`
        : 'Jump to the next waiting pane',
      hint: 'Ctrl+Shift+J',
      run: () => state.focusNextWaiting()
    },
    {
      id: 'pane:waiting-queue',
      group: 'Panes',
      label: 'Waiting queue',
      hint: 'Ctrl+Shift+U',
      run: () => state.setUi({ waitingQueue: true })
    }
  ]

  workspace.panes.forEach((pane, index) => {
    const profile = state.profiles.find((p) => p.id === pane.profileId)
    list.push({
      id: `pane:focus:${pane.id}`,
      group: 'Panes',
      label: `Focus ${paneLabel(pane, profile)}`,
      hint: index < 9 ? `Alt+${index + 1}` : undefined,
      run: () => state.setActivePane(workspace.id, pane.id)
    })
  })

  return list
}

/** Everything that acts on the focused pane. */
export function activePaneCommands(
  state: Deck,
  workspace: DeckWorkspace,
  activePane: PaneView
): Command[] {
  const activeLabel = paneLabel(
    activePane,
    state.profiles.find((p) => p.id === activePane.profileId)
  )
  const copyTranscript = async (strip: boolean): Promise<void> => {
    await api.clipboard.write(await api.pty.transcript(activePane.id, strip))
  }
  const saveTranscript = async (strip: boolean): Promise<void> => {
    await api.saveText({
      defaultName: transcriptName(workspace.name, activeLabel, new Date()),
      text: await api.pty.transcript(activePane.id, strip)
    })
  }

  const list: Command[] = [
    {
      id: 'pane:edit',
      group: 'Active pane',
      label: 'Edit pane…',
      hint: 'command, folder, environment',
      run: () => state.setUi({ paneDialogFor: activePane.id })
    },
    {
      id: 'pane:restart',
      group: 'Active pane',
      label: 'Restart process',
      hint: 'Ctrl+Shift+R',
      run: () => state.restartPane(activePane.id)
    },
    {
      id: 'pane:read-only',
      group: 'Active pane',
      label: activePane.readOnly
        ? 'Let this pane take input again'
        : 'Lock this pane read-only',
      hint: activePane.readOnly ? 'locked' : 'refuses typing, paste, broadcast, dictation',
      run: () => state.updatePane(activePane.id, { readOnly: !activePane.readOnly })
    },
    {
      id: 'pane:mute-attention',
      group: 'Active pane',
      label: activePane.attentionMuted
        ? 'Count this pane as waiting again'
        : 'Never count this pane as waiting',
      hint: activePane.attentionMuted
        ? 'muted'
        : 'no badge, sidebar count or queue',
      run: () => state.updatePane(activePane.id, { attentionMuted: !activePane.attentionMuted })
    },
    {
      id: 'pane:auto-restart',
      group: 'Active pane',
      label: activePane.autoRestart
        ? 'Stop restarting this pane when it crashes'
        : 'Restart this pane when it crashes',
      hint: activePane.autoRestart ? 'on' : `${RESTART_CAP} attempts, then it stops`,
      run: () => state.updatePane(activePane.id, { autoRestart: !activePane.autoRestart })
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
      id: 'pane:send-selection',
      group: 'Active pane',
      label: 'Send the selection to the broadcast box',
      hint: 'Ctrl+Shift+E',
      run: () => {
        const selection = getTerminal(activePane.id)?.term.getSelection() ?? ''
        if (!selection.trim()) return
        state.setUi({ broadcast: true, pendingInsert: fencedBlock(selection) })
      }
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
  ]

  // Worktree panes only — the workspace's own tree is the user's, and
  // this app does not commit it. See HD-18.
  if (activePane.worktree) {
    list.push({
      id: 'pane:ship',
      group: 'Active pane',
      label: 'Ship this worktree…',
      hint: 'commit, push, open a PR',
      run: () => state.setUi({ shipFor: activePane.id })
    })
  }

  return list
}

/** The app itself: settings, help, dictation, updates, chrome. */
export function appCommands(state: Deck): Command[] {
  return [
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
  ]
}

/**
 * The list the palette searches, in the order the groups have always come:
 * workspaces first, the active workspace's own commands, its panes, the
 * focused pane's, and the application's last.
 */
export function buildCommands(state: Deck): Command[] {
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
  const activePane = workspace?.panes.find((p) => p.id === workspace.activePaneId)
  return [
    ...workspaceCommands(state),
    ...templateCommands(state),
    ...(workspace
      ? [
          ...activeWorkspaceCommands(state, workspace),
          ...newPaneCommands(state, workspace),
          ...paneCommands(state, workspace),
          ...(activePane ? activePaneCommands(state, workspace, activePane) : [])
        ]
      : []),
    ...appCommands(state)
  ]
}
