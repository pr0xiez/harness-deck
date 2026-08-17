import { useEffect, useState } from 'react'
import { totalActionableCount, totalLiveCount, useDeck } from '../store'
import { Icon } from './Icon'

const api = window.harness

export function TitleBar(): React.JSX.Element {
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
  const runningCount = totalLiveCount(workspaces)
  // Same rule as the dock badge and the sidebar counts, so the three never disagree.
  const waitingCount = totalActionableCount(workspaces)

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
        {/* Only while something is waiting: at zero it would be chrome with
            nothing behind it, and the amber appearing is itself the signal. */}
        {waitingCount ? (
          <button
            className="ghost-btn waiting"
            title={`${waitingCount} pane${waitingCount === 1 ? '' : 's'} waiting for you — open the queue (Ctrl+Shift+U)`}
            onClick={() => setUi({ waitingQueue: true })}
          >
            <Icon name="bell" />
            <span>Waiting</span>
            <span className="count waiting">{waitingCount}</span>
          </button>
        ) : null}
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
