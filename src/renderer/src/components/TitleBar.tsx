import { useEffect, useState } from 'react'
import { isActionable, isLive, useDeck } from '../store'
import { githubCount, useGitHub } from '../github'
import { Icon } from './Icon'
import { PersonalStatusChip } from './PersonalStatusChip'

const api = window.harness

export function TitleBar(): React.JSX.Element {
  const githubWaiting = useGitHub(githubCount)
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const isMac = useDeck((s) => s.info?.platform === 'darwin')
  const setUi = useDeck((s) => s.setUi)
  const workspaces = useDeck((s) => s.workspaces)
  const activeId = useDeck((s) => s.activeWorkspaceId)
  const update = useDeck((s) => s.update)
  const showUpdate = useDeck((s) => s.showUpdate)
  const updateReady = update?.stage === 'available' ? update.available : null
  const active = workspaces.find((w) => w.id === activeId)
  // Waiting counts as running: the process is alive, it has just stopped talking.
  const runningCount = workspaces.reduce((total, ws) => total + ws.panes.filter(isLive).length, 0)
  // Same rule as the dock badge and the sidebar counts, so the three never disagree.
  const waitingCount = workspaces.reduce(
    (total, ws) => total + ws.panes.filter((p) => isActionable(p)).length,
    0
  )

  useEffect(() => {
    void api.window.isMaximized().then(setMaximized)
    const offMaximized = api.window.onMaximizedChange(setMaximized)
    const offFullscreen = api.window.onFullscreenChange(setFullscreen)
    return () => {
      offMaximized()
      offFullscreen()
    }
  }, [])

  // macOS draws its traffic lights over the left of the bar — except in
  // fullscreen, where they are gone and the space would be dead.
  return (
    <div className={`titlebar${isMac && !fullscreen ? ' mac-inset' : ''}`}>
      <div className="titlebar-left">
        <span className="wordmark">
          <span className="wordmark-dot" />
          Harness Deck
        </span>
        {active ? (
          <span className="titlebar-context">
            {active.name}
            <span className="sep">·</span>
            {runningCount} running
          </span>
        ) : null}
      </div>

      <div className="titlebar-drag" />

      <div className="titlebar-right">
        <PersonalStatusChip />
        {/* Always accessible for GitHub setup and acknowledged items. */}
        <button
          className={`ghost-btn ${waitingCount + githubWaiting ? 'waiting' : ''}`}
          title="Agent and GitHub attention (Ctrl+Shift+U)"
          onClick={() => setUi({ waitingQueue: true, attentionTab: githubWaiting && !waitingCount ? 'github' : 'agents' })}
        >
          <Icon name="bell" />
          <span>Attention</span>
          {waitingCount + githubWaiting > 0 ? <span className="count waiting">{waitingCount + githubWaiting}</span> : null}
        </button>
        {updateReady ? (
          <button
            className="ghost-btn on"
            title={`Version ${updateReady.version} is ready to install`}
            onClick={showUpdate}
          >
            <Icon name="restart" />
            <span>Update</span>
          </button>
        ) : null}
        <button
          className="ghost-btn"
          title="Command palette (Ctrl+Shift+P)"
          onClick={() => setUi({ palette: true })}
        >
          <Icon name="command" />
          <span>Commands</span>
        </button>
        <button
          className="icon-btn"
          title="Keyboard shortcuts (Ctrl+Shift+/)"
          onClick={() => setUi({ help: true })}
        >
          <Icon name="help" />
        </button>
        <button className="icon-btn" title="Settings (Ctrl+Shift+,)" onClick={() => setUi({ settings: true })}>
          <Icon name="settings" />
        </button>
        {isMac ? null : (
          <div className="window-controls">
            <button className="win-btn" title="Minimise" onClick={() => api.window.minimize()}>
              <Icon name="winMin" />
            </button>
            <button
              className="win-btn"
              title={maximized ? 'Restore' : 'Maximise'}
              onClick={() => api.window.toggleMaximize()}
            >
              <Icon name={maximized ? 'winRestore' : 'winMax'} />
            </button>
            <button className="win-btn close" title="Close" onClick={() => api.window.close()}>
              <Icon name="winClose" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
