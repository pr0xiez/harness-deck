import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { Icon } from './Icon'

const api = window.harness

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const setUi = useDeck((s) => s.setUi)
  const workspaces = useDeck((s) => s.workspaces)
  const activeId = useDeck((s) => s.activeWorkspaceId)
  const active = workspaces.find((w) => w.id === activeId)
  const runningCount = workspaces.reduce(
    (total, ws) => total + ws.panes.filter((p) => p.status === 'running').length,
    0
  )

  useEffect(() => {
    void api.window.isMaximized().then(setMaximized)
    return api.window.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="titlebar">
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
      </div>
    </div>
  )
}
