import { useEffect, useState } from 'react'
import { isLive, useDeck, type DeckWorkspace } from '../store'
import { CompareView } from './CompareView'
import { Icon } from './Icon'
import { MicButton } from './MicButton'
import { ProfileMenu } from './ProfileMenu'

const api = window.harness

interface Props {
  workspace: DeckWorkspace
}

export function Toolbar({ workspace }: Props): React.JSX.Element {
  const updateWorkspace = useDeck((s) => s.updateWorkspace)
  const setLayout = useDeck((s) => s.setLayout)
  const setColumns = useDeck((s) => s.setColumns)
  const ui = useDeck((s) => s.ui)
  const setUi = useDeck((s) => s.setUi)
  const home = useDeck((s) => s.info?.homeDir ?? '')
  const repo = useDeck((s) => s.repos[workspace.cwd] ?? null)
  const refreshRepo = useDeck((s) => s.refreshRepo)
  const menuOpen = ui.profileMenu
  const setMenuOpen = (open: boolean): void => setUi({ profileMenu: open })
  const [editingName, setEditingName] = useState(false)

  const displayCwd =
    home && workspace.cwd.startsWith(home) ? `~${workspace.cwd.slice(home.length)}` : workspace.cwd
  // The chip says "live", and a pane that has gone quiet still has a process.
  const running = workspace.panes.filter(isLive).length
  // One worktree has nothing to be compared against; the offer only makes sense
  // once two agents have been sent at the same task.
  const worktrees = workspace.panes.filter((pane) => pane.worktree).length

  // Not a timer. A branch and a dirty count only change when something
  // happened, and the two moments that mean something happened are the window
  // coming back to you and an agent falling silent — which, for an agent, is
  // usually the moment it stopped writing files.
  useEffect(() => {
    const read = (): void => void refreshRepo(workspace.cwd)
    read()
    const offFocus = api.window.onFocusChange((focused) => {
      if (focused) read()
    })
    const offQuiet = api.pty.onQuiet(({ quiet }) => {
      if (quiet) read()
    })
    return () => {
      offFocus()
      offQuiet()
    }
  }, [workspace.cwd, refreshRepo])

  return (
    <div className="toolbar" style={{ ['--ws-accent' as string]: workspace.accent }}>
      <div className="toolbar-left">
        <span className="ws-chip" style={{ background: workspace.accent }} />
        {editingName ? (
          <input
            className="toolbar-name-input"
            autoFocus
            defaultValue={workspace.name}
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value) updateWorkspace(workspace.id, { name: value })
              setEditingName(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
              if (event.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          <button className="toolbar-name" onClick={() => setEditingName(true)} title="Rename workspace">
            {workspace.name}
          </button>
        )}

        <button
          className="cwd-chip"
          title={`${workspace.cwd}\nClick to change the folder new panes open in`}
          onClick={async () => {
            const dir = await api.pickDirectory(workspace.cwd)
            if (dir) updateWorkspace(workspace.id, { cwd: dir })
          }}
        >
          <Icon name="folder" size={12} />
          <span>{displayCwd || 'choose folder…'}</span>
        </button>

        {/* Nothing at all when the folder is not a repo — no empty chip to explain. */}
        {repo ? (
          <span
            className="repo-chip"
            title={`${repo.root}\nOn ${repo.branch}${
              repo.dirty ? ` · ${repo.dirty} uncommitted` : ' · nothing uncommitted'
            }${repo.worktreeOf ? `\nA worktree of ${repo.worktreeOf}` : ''}`}
          >
            <Icon name="branch" size={12} />
            <span className="repo-branch">{repo.branch}</span>
            {repo.dirty ? <span className="dirty">{repo.dirty}</span> : null}
          </span>
        ) : null}

        <span className="pane-count">
          {workspace.panes.length} pane{workspace.panes.length === 1 ? '' : 's'}
          {running ? <span className="live"> · {running} live</span> : null}
        </span>
      </div>

      <div className="toolbar-right">
        <div className="segmented" role="group" aria-label="Layout">
          <button
            className={workspace.layout === 'grid' ? 'on' : ''}
            title="Grid layout"
            onClick={() => setLayout(workspace.id, 'grid')}
          >
            <Icon name="grid" />
          </button>
          <button
            className={workspace.layout === 'tabs' ? 'on' : ''}
            title="Tab layout"
            onClick={() => setLayout(workspace.id, 'tabs')}
          >
            <Icon name="tabs" />
          </button>
        </div>

        {workspace.layout === 'grid' ? (
          <div className="stepper" title="Grid columns">
            <button onClick={() => setColumns(workspace.id, workspace.columns - 1)} disabled={workspace.columns <= 1}>
              −
            </button>
            <span>{workspace.columns} col</span>
            <button onClick={() => setColumns(workspace.id, workspace.columns + 1)} disabled={workspace.columns >= 4}>
              +
            </button>
          </div>
        ) : null}

        <MicButton />

        {worktrees >= 2 ? (
          <button
            className={`ghost-btn ${ui.compare ? 'on' : ''}`}
            title={`See what each of the ${worktrees} worktree panes changed, side by side`}
            onClick={() => setUi({ compare: !ui.compare })}
          >
            <Icon name="branch" />
            <span>Compare</span>
          </button>
        ) : null}

        <button
          className={`ghost-btn ${ui.broadcast ? 'on' : ''}`}
          title="Broadcast a prompt to every pane (Ctrl+Shift+B)"
          onClick={() => setUi({ broadcast: !ui.broadcast })}
        >
          <Icon name="broadcast" />
          <span>Broadcast</span>
        </button>

        <div className="new-pane-anchor">
          <button className="btn primary" title="New pane (Ctrl+Shift+T)" onClick={() => setMenuOpen(!menuOpen)}>
            <Icon name="plus" />
            <span>New pane</span>
            <Icon name="chevronDown" size={12} />
          </button>
          {menuOpen ? <ProfileMenu workspaceId={workspace.id} onClose={() => setMenuOpen(false)} /> : null}
        </div>
      </div>

      {/* Mounted here rather than in App because the toolbar is what owns the
          workspace — and the overlay is fixed, so nothing above it clips it. */}
      {ui.compare && worktrees >= 2 ? (
        <CompareView workspace={workspace} onClose={() => setUi({ compare: false })} />
      ) : null}
    </div>
  )
}
