import { useRef, useState } from 'react'
import { isLive, useDeck, type DeckWorkspace } from '../store'
import { ACCENTS } from '../theme'
import { Dropdown } from './ui'
import { Icon } from './Icon'
import { SaveTemplateDialog, TemplatePicker } from './TemplateDialog'

const api = window.harness

function initials(name: string): string {
  const words = name.split(/[\s_\-./\\]+/).filter(Boolean)
  if (!words.length) return '··'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

function shortenPath(path: string, home: string): string {
  if (!path) return 'no folder'
  const normalised = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  const parts = normalised.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : normalised
}

interface RowProps {
  workspace: DeckWorkspace
  index: number
  active: boolean
  collapsed: boolean
  home: string
}

function WorkspaceRow({ workspace, index, active, collapsed, home }: RowProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const setActiveWorkspace = useDeck((s) => s.setActiveWorkspace)
  const updateWorkspace = useDeck((s) => s.updateWorkspace)
  const removeWorkspace = useDeck((s) => s.removeWorkspace)
  const duplicateWorkspace = useDeck((s) => s.duplicateWorkspace)
  const moveWorkspace = useDeck((s) => s.moveWorkspace)
  const setUi = useDeck((s) => s.setUi)

  const waiting = workspace.panes.filter((p) => p.status === 'waiting').length
  const running = workspace.panes.filter((p) => p.status === 'running').length
  const exited = workspace.panes.filter((p) => p.status === 'exited').length

  return (
    <div
      className={`ws-row ${active ? 'is-active' : ''}`}
      style={{ ['--ws-accent' as string]: workspace.accent }}
      onClick={() => setActiveWorkspace(workspace.id)}
      onDoubleClick={() => setRenaming(true)}
      title={collapsed ? `${workspace.name} — ${workspace.cwd}` : undefined}
    >
      <span className="ws-mark">{initials(workspace.name)}</span>

      {!collapsed ? (
        <span className="ws-meta">
          {renaming ? (
            <input
              className="ws-rename"
              autoFocus
              defaultValue={workspace.name}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                const value = event.target.value.trim()
                if (value) updateWorkspace(workspace.id, { name: value })
                setRenaming(false)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                if (event.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <span className="ws-name">{workspace.name}</span>
          )}
          <span className="ws-sub">{shortenPath(workspace.cwd, home)}</span>
        </span>
      ) : null}

      {/* A waiting count outranks the rest: the whole point is to see it on a
          workspace you are not looking at. */}
      <span className="ws-badges">
        {running ? (
          <span className="dot running" title={`${running} pane${running === 1 ? '' : 's'} running`} />
        ) : null}
        {waiting ? (
          <span
            className="count waiting"
            title={`${waiting} pane${waiting === 1 ? '' : 's'} waiting for you (Ctrl+Shift+J)`}
          >
            {waiting}
          </span>
        ) : null}
        {!waiting && running ? <span className="count running">{running}</span> : null}
        {!waiting && !running && exited ? <span className="count exited">{exited}</span> : null}
        {!waiting && !running && !exited && workspace.panes.length ? (
          <span className="count idle">{workspace.panes.length}</span>
        ) : null}
      </span>

      {!collapsed ? (
        <span className={`ws-menu-anchor ${menuOpen ? 'is-open' : ''}`}>
          <button
            ref={menuButton}
            className="icon-btn tiny"
            title="Workspace actions"
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            <Icon name="chevronDown" size={12} />
          </button>
          {menuOpen ? (
            <Dropdown onClose={() => setMenuOpen(false)} align="right" anchor={menuButton}>
              <button className="menu-item" onClick={() => { setMenuOpen(false); setRenaming(true) }}>
                Rename
              </button>
              <button
                className="menu-item"
                onClick={async () => {
                  setMenuOpen(false)
                  const dir = await api.pickDirectory(workspace.cwd)
                  if (dir) updateWorkspace(workspace.id, { cwd: dir })
                }}
              >
                Change folder…
              </button>
              <button className="menu-item" onClick={() => { setMenuOpen(false); duplicateWorkspace(workspace.id) }}>
                Duplicate with panes
              </button>
              <button
                className="menu-item"
                onClick={() => { setMenuOpen(false); setUi({ templateSaveFor: workspace.id }) }}
              >
                Save as template…
              </button>
              <div className="menu-sep" />
              <div className="menu-swatches">
                {ACCENTS.map((colour) => (
                  <button
                    key={colour}
                    className={`swatch ${workspace.accent === colour ? 'on' : ''}`}
                    style={{ background: colour }}
                    title={colour}
                    onClick={() => updateWorkspace(workspace.id, { accent: colour })}
                  />
                ))}
              </div>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { setMenuOpen(false); moveWorkspace(workspace.id, -1) }}>
                Move up
              </button>
              <button className="menu-item" onClick={() => { setMenuOpen(false); moveWorkspace(workspace.id, 1) }}>
                Move down
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={async () => {
                  setMenuOpen(false)
                  const live = workspace.panes.filter(isLive).length
                  if (
                    live &&
                    !(await api.confirm({
                      title: 'Delete workspace',
                      message: `${workspace.name} has ${live} running pane${live > 1 ? 's' : ''}.`,
                      detail: 'Those processes will be terminated.',
                      confirmLabel: 'Delete workspace'
                    }))
                  ) {
                    return
                  }
                  removeWorkspace(workspace.id)
                }}
              >
                Delete workspace
              </button>
            </Dropdown>
          ) : null}
        </span>
      ) : null}

      {!collapsed && index < 9 ? <span className="ws-hotkey">{index + 1}</span> : null}
    </div>
  )
}

export function Sidebar(): React.JSX.Element {
  const workspaces = useDeck((s) => s.workspaces)
  const activeId = useDeck((s) => s.activeWorkspaceId)
  const addWorkspace = useDeck((s) => s.addWorkspace)
  const collapsed = useDeck((s) => s.settings.sidebarCollapsed)
  const updateSettings = useDeck((s) => s.updateSettings)
  const home = useDeck((s) => s.info?.homeDir ?? '')
  const templates = useDeck((s) => s.templates)
  const ui = useDeck((s) => s.ui)
  const setUi = useDeck((s) => s.setUi)

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-head">
        {!collapsed ? <span className="sidebar-title">Workspaces</span> : null}
        <button
          className="icon-btn"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => updateSettings({ sidebarCollapsed: !collapsed })}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} />
        </button>
      </div>

      <div className="ws-list">
        {workspaces.map((workspace, index) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            index={index}
            active={workspace.id === activeId}
            collapsed={collapsed}
            home={home}
          />
        ))}
      </div>

      <div className="sidebar-foot">
        <button
          className="btn subtle full"
          title="New workspace (Ctrl+Shift+N)"
          onClick={() => addWorkspace()}
        >
          <Icon name="plus" />
          {!collapsed ? <span>New workspace</span> : null}
        </button>
        {!collapsed ? (
          <button
            className="btn subtle full"
            onClick={async () => {
              const dir = await api.pickDirectory()
              if (dir) addWorkspace(undefined, dir)
            }}
          >
            <Icon name="folder" />
            <span>From folder…</span>
          </button>
        ) : null}
        {/* Only once there is something to pick — an empty picker is a dead end,
            and saving the first template is a workspace action, not this one. */}
        {!collapsed && templates.length ? (
          <button className="btn subtle full ws-from-template" onClick={() => setUi({ templatePicker: true })}>
            <Icon name="copy" />
            <span>From template…</span>
          </button>
        ) : null}
      </div>

      {ui.templateSaveFor ? (
        <SaveTemplateDialog
          workspaceId={ui.templateSaveFor}
          onClose={() => setUi({ templateSaveFor: null })}
        />
      ) : null}
      {ui.templatePicker ? <TemplatePicker onClose={() => setUi({ templatePicker: false })} /> : null}
    </aside>
  )
}
