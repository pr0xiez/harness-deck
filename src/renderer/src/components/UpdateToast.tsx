import { useDeck } from '../store'
import { Icon } from './Icon'

/** Sits bottom-right whenever a release is waiting, until it is installed or waved off. */
export function UpdateToast(): React.JSX.Element | null {
  const update = useDeck((s) => s.update)
  const dismissed = useDeck((s) => s.updateDismissed)
  const error = useDeck((s) => s.updateError)
  const installing = useDeck((s) => s.updateInstalling)
  const installUpdate = useDeck((s) => s.installUpdate)
  const dismissUpdate = useDeck((s) => s.dismissUpdate)

  const available = update?.stage === 'available' ? update.available : null
  if (!update || !available || available.version === dismissed) return null

  return (
    <div className="toast" role="status">
      <div className="toast-head">
        <span className="toast-dot" />
        <strong>Version {available.version} is ready</strong>
        <button className="icon-btn tiny" title="Later" onClick={dismissUpdate}>
          <Icon name="close" />
        </button>
      </div>
      <p className={`toast-body ${error ? 'bad' : ''}`}>
        {error || available.notes || `You are running ${update.current}.`}
      </p>
      <div className="toast-actions">
        {update.installable ? (
          <button
            className="btn primary"
            disabled={installing}
            onClick={() => void installUpdate()}
          >
            <Icon name="restart" />
            <span>{installing ? 'Installing…' : 'Restart & install'}</span>
          </button>
        ) : (
          <span className="toast-note">Dev run — install from the packaged app.</span>
        )}
        <button className="btn ghost" onClick={dismissUpdate}>
          Later
        </button>
      </div>
    </div>
  )
}
