import { useState } from 'react'
import { paneLabel } from '../paneLabel'
import { useDeck, type DeckWorkspace } from '../store'
import { TerminalPane } from './TerminalPane'
import { ProfileMenu } from './ProfileMenu'
import { PaneDialog } from './PaneDialog'
import { ShipDialog } from './ShipDialog'
import { Icon } from './Icon'

interface Props {
  workspace: DeckWorkspace
  visible: boolean
}

export function PaneArea({ workspace, visible }: Props): React.JSX.Element {
  const profiles = useDeck((s) => s.profiles)
  const addPane = useDeck((s) => s.addPane)
  const setActivePane = useDeck((s) => s.setActivePane)
  const requestClosePane = useDeck((s) => s.requestClosePane)
  const setUi = useDeck((s) => s.setUi)
  // The dialog belongs to whichever workspace holds the pane, so it is rendered
  // beside the grid rather than inside a pane that a restart is about to unmount.
  const dialogFor = useDeck((s) =>
    workspace.panes.some((p) => p.id === s.ui.paneDialogFor) ? s.ui.paneDialogFor : null
  )
  // Same reasoning, plus one more: while the compare overlay is up it renders
  // its own ship dialog for the column it owns — with that column's diff already
  // in hand — and two of them would stack. The condition is the one the toolbar
  // mounts the overlay on, so only ever one of the two is showing.
  const shipFor = useDeck((s) => {
    const worktrees = workspace.panes.filter((p) => p.worktree)
    if (s.ui.compare && worktrees.length >= 2) return null
    return worktrees.some((p) => p.id === s.ui.shipFor) ? s.ui.shipFor : null
  })
  const shipPane = workspace.panes.find((p) => p.id === shipFor)
  const [addOpen, setAddOpen] = useState(false)

  const zoomed = workspace.zoomedPaneId
  const activeId = workspace.activePaneId
  const isVisible = (paneId: string): boolean => {
    if (!visible) return false
    if (workspace.layout === 'tabs') return paneId === activeId
    if (zoomed) return paneId === zoomed
    return true
  }

  const quickPicks = [
    ...profiles.filter((p) => p.kind === 'agent' && p.available).slice(0, 6),
    ...profiles.filter((p) => p.id.startsWith('custom:')).slice(0, 4),
    ...profiles.filter((p) => p.id === 'shell:default')
  ]

  return (
    <div
      className={`pane-area ${workspace.layout === 'tabs' ? 'layout-tabs' : 'layout-grid'} ${
        zoomed ? 'is-zoomed' : ''
      } ${visible ? '' : 'workspace-hidden'}`}
      style={{
        // Never leave an empty column: two panes at "3 col" still split evenly.
        ['--cols' as string]: String(Math.max(1, Math.min(workspace.columns, workspace.panes.length))),
        ['--ws-accent' as string]: workspace.accent
      }}
    >
      {workspace.layout === 'tabs' && workspace.panes.length ? (
        <div className="tabstrip">
          {workspace.panes.map((pane, index) => {
            const profile = profiles.find((p) => p.id === pane.profileId)
            return (
              <button
                key={pane.id}
                className={`tab ${pane.id === activeId ? 'on' : ''}`}
                style={{ ['--pane-accent' as string]: profile?.accent ?? workspace.accent }}
                onClick={() => setActivePane(workspace.id, pane.id)}
                title={`${pane.command} ${pane.args.join(' ')}`.trim()}
              >
                <span className="tab-badge">{profile?.icon ?? '»'}</span>
                <span className="tab-title">{paneLabel(pane, profile)}</span>
                <span className={`pane-status ${pane.status}`} />
                {pane.activity && pane.id !== activeId ? <span className="pane-dot" /> : null}
                <span className="tab-index">{index + 1}</span>
                <span
                  className="tab-close"
                  role="button"
                  title="Close pane"
                  onClick={(event) => {
                    event.stopPropagation()
                    void requestClosePane(workspace.id, pane.id)
                  }}
                >
                  <Icon name="close" size={11} />
                </span>
              </button>
            )
          })}
          <div className="tab-add-anchor">
            <button className="tab-add" title="New pane (Ctrl+Shift+T)" onClick={() => setAddOpen((v) => !v)}>
              <Icon name="plus" size={12} />
            </button>
            {addOpen ? (
              <ProfileMenu workspaceId={workspace.id} onClose={() => setAddOpen(false)} align="left" />
            ) : null}
          </div>
        </div>
      ) : null}

      {dialogFor ? (
        <PaneDialog
          workspaceId={workspace.id}
          paneId={dialogFor}
          onClose={() => setUi({ paneDialogFor: null })}
        />
      ) : null}

      {shipPane ? (
        <ShipDialog
          workspaceId={workspace.id}
          pane={shipPane}
          onClose={() => setUi({ shipFor: null })}
        />
      ) : null}

      {workspace.panes.length ? (
        <div className="pane-grid">
          {workspace.panes.map((pane, index) => (
            <TerminalPane
              key={`${pane.id}:${pane.epoch}`}
              pane={pane}
              workspaceId={workspace.id}
              profile={profiles.find((p) => p.id === pane.profileId)}
              accent={workspace.accent}
              active={pane.id === activeId}
              visible={isVisible(pane.id)}
              index={index}
              paneCount={workspace.panes.length}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-card">
            <h2>{workspace.name} is empty</h2>
            <p>
              Open a harness in this workspace. Every pane runs in{' '}
              <code>{workspace.cwd || 'your home folder'}</code> and keeps running while you switch
              workspaces.
            </p>
            <div className="empty-grid">
              {quickPicks.map((profile) => (
                <button
                  key={profile.id}
                  className="empty-pick"
                  style={{ ['--badge' as string]: profile.accent }}
                  onClick={() => addPane(workspace.id, profile)}
                >
                  <span className="profile-badge" style={{ ['--badge' as string]: profile.accent }}>
                    {profile.icon}
                  </span>
                  <span>{profile.name}</span>
                </button>
              ))}
            </div>
            <div className="empty-more">
              <div className="new-pane-anchor">
                <button className="btn subtle" onClick={() => setAddOpen((v) => !v)}>
                  <Icon name="plus" />
                  <span>Everything else…</span>
                </button>
                {addOpen ? (
                  <ProfileMenu workspaceId={workspace.id} onClose={() => setAddOpen(false)} align="left" />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
